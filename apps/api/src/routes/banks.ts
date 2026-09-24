import { Router } from 'express';
import { requireAuth, AppError, type AuthedRequest } from '../auth.js';
import { bankRepo } from '../repo.js';
import type { QuestionType } from '../types.js';
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
  bankRepo.delete(bankId);
  writeAudit(req, { action: 'bank.delete', course_id: bank.course_id, target: 'bank:' + bankId });
  res.json({ ok: true });
});

// Add a question to a bank
banksRouter.post('/:bankId/questions', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);

  const { qtype, text, options, answer, tolerance, points, tags } = req.body ?? {};
  if (!['single', 'multiple', 'short', 'numeric'].includes(qtype)) {
    throw new AppError(400, 'Invalid question type.');
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AppError(400, 'Question text is required.');
  }

  const question = bankRepo.addQuestion(bankId, {
    qtype: qtype as QuestionType,
    text: text.trim(),
    options: Array.isArray(options) ? options.map(String) : [],
    answer: answer ?? '',
    tolerance: tolerance != null ? Number(tolerance) : null,
    points: points != null ? Number(points) : 1,
    tags: Array.isArray(tags) ? tags.map(String) : [],
  });

  res.status(201).json({ question });
});

// Delete a question from a bank
banksRouter.delete('/:bankId/questions/:questionId', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const questionId = Number(req.params.questionId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);

  bankRepo.deleteQuestion(questionId);
  res.json({ ok: true });
});

// Batch import questions into a bank
banksRouter.post('/:bankId/import', (req: AuthedRequest, res) => {
  const bankId = Number(req.params.bankId);
  const bank = bankRepo.get(bankId);
  if (!bank) throw new AppError(404, 'Question bank not found.');
  assertStaff(req, bank.course_id);

  const { questions } = req.body ?? {};
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new AppError(400, 'Expected a non-empty array of questions.');
  }

  const imported = [];
  for (const q of questions) {
    if (!q.text || !q.qtype) continue;
    const item = bankRepo.addQuestion(bankId, {
      qtype: q.qtype as QuestionType,
      text: String(q.text).trim(),
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      answer: q.answer ?? '',
      tolerance: q.tolerance != null ? Number(q.tolerance) : null,
      points: q.points != null ? Number(q.points) : 1,
      tags: Array.isArray(q.tags) ? q.tags.map(String) : [],
    });
    imported.push(item);
  }

  res.status(201).json({ count: imported.length, questions: imported });
});
