import { Router } from 'express';
import { requireAuth, AppError, type AuthedRequest } from '../auth.js';
import { bankRepo } from '../repo.js';
import type { Difficulty } from '../types.js';
import { validateQuestionData } from '../services/question-validation.js';
import { assertStaff, assertInstructor, writeAudit } from '../authz.js';

export const banksRouter = Router();

banksRouter.use(requireAuth);

// List question banks for a course
banksRouter.get('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  assertStaff(req, courseId);
  const banks = bankRepo.listForCourse(courseId);
  res.json({ banks });
});

// Create a new question bank
banksRouter.post('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  assertStaff(req, courseId);
  const { name, description } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new AppError(400, 'Bank name is required.');
  }
  const bank = bankRepo.create(courseId, req.userId as number, name.trim(), description ? String(description).trim() : '');
  res.status(201).json({ bank });
});

// Get a question bank and its questions
banksRouter.get('/:bankId', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);
  const questions = bankRepo.listQuestions(bankId);
  res.json({ bank, questions });
});

// Delete a question bank
banksRouter.delete('/:bankId', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertInstructor(req, bank.course_id);
  const users = bankRepo.usedBy(bankId);
  if (users.length) {
    throw new AppError(
      409,
      `Random questions in ${users.map((u) => `“${u.title}”`).join(', ')} draw from this bank. Remove those first.`,
      'bank_in_use',
    );
  }
  bankRepo.delete(bankId);
  writeAudit(req, { action: 'bank.delete', course_id: bank.course_id, target: 'bank:' + bankId });
  res.json({ ok: true });
});

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

function parseDifficulty(raw: unknown): Difficulty {
  if (raw === undefined || raw === null || raw === '') return 'medium';
  const d = String(raw).trim().toLowerCase();
  const alias: Record<string, Difficulty> = { med: 'medium', moderate: 'medium', difficult: 'hard', simple: 'easy' };
  const value = (alias[d] ?? d) as Difficulty;
  if (!DIFFICULTIES.includes(value)) throw new AppError(400, "Difficulty must be 'easy', 'medium' or 'hard'.");
  return value;
}

/** Validate one bank question exactly like a quiz question (it may become one). */
function bankQuestionInput(raw: Record<string, unknown>) {
  const v = validateQuestionData({
    qtype: String(raw.qtype ?? ''),
    text: String(raw.text ?? ''),
    options: raw.options,
    answer: raw.answer,
    tolerance: raw.tolerance,
    points: raw.points,
  });
  return {
    qtype: v.qtype,
    text: String(raw.text).trim(),
    options: v.options ?? [],
    answer: v.answer,
    tolerance: v.tolerance ?? null,
    points: raw.points != null && raw.points !== '' ? Number(raw.points) : 1,
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : typeof raw.tags === 'string'
        ? raw.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20)
        : [],
    difficulty: parseDifficulty(raw.difficulty),
    allow_assumptions: Boolean(raw.allow_assumptions),
  };
}

// Add a question to a bank
banksRouter.post('/:bankId/questions', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);
  const question = bankRepo.addQuestion(bankId, bankQuestionInput(req.body ?? {}));
  res.status(201).json({ question });
});

// Re-rate a bank question's difficulty (e.g. after the results showed it plays harder).
banksRouter.patch('/:bankId/questions/:questionId', (req: AuthedRequest, res) => {
  const bank = bankRepo.get(Number(req.params.bankId));
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);
  const question = bankRepo.getQuestion(Number(req.params.questionId));
  if (!question || question.bank_id !== bank.id) throw new AppError(404, 'Question not found in this bank.');
  if (req.body?.difficulty === undefined) throw new AppError(400, 'Nothing to change.');
  const difficulty = parseDifficulty(req.body.difficulty);
  bankRepo.setDifficulty(question.id, difficulty);
  writeAudit(req, {
    action: 'bank.question.difficulty',
    course_id: bank.course_id,
    target: 'bank_question:' + question.id,
    before: question.difficulty,
    after: difficulty,
  });
  res.json({ question: bankRepo.getQuestion(question.id) });
});

// Delete a question from a bank. Papers already drawn keep their own copy.
banksRouter.delete('/:bankId/questions/:questionId', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const questionId = Number(req.params.questionId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);

  bankRepo.deleteQuestion(questionId);
  res.json({ ok: true });
});

// Batch import questions into a bank. Invalid items are skipped and reported.
banksRouter.post('/:bankId/import', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);

  const { questions } = req.body ?? {};
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new AppError(400, 'Expected a non-empty array of questions.');
  }
  if (questions.length > 2000) throw new AppError(400, 'Import at most 2000 questions at a time.');

  const imported: ReturnType<typeof bankRepo.addQuestion>[] = [];
  const skipped: { index: number; error: string }[] = [];
  questions.forEach((q: unknown, index: number) => {
    try {
      imported.push(bankRepo.addQuestion(bankId, bankQuestionInput((q ?? {}) as Record<string, unknown>)));
    } catch (e) {
      skipped.push({ index, error: e instanceof AppError ? e.message : 'Invalid question.' });
    }
  });

  res.status(201).json({ count: imported.length, questions: imported, skipped });
});
