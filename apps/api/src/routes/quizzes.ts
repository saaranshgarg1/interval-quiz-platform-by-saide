import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import {
  courseRepo,
  quizRepo,
  quizVersionRepo,
  questionRepo,
  attemptRepo,
} from '../repo.js';
import type { CourseRole, QuestionType } from '../types.js';
import { assertStaff, assertInstructor, writeAudit } from '../authz.js';

export const quizzesRouter = Router();

quizzesRouter.use(requireAuth);

function versionDetail(versionId: number, viewerId: number, role: CourseRole | 'admin') {
  const version = quizVersionRepo.get(versionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  const isStaff = role !== 'student';
  const questions = questionRepo.listForVersion(versionId);
  return {
    id: version.id,
    quiz_id: version.quiz_id,
    version: version.version,
    status: version.status,
    title: version.title,
    instructions: version.instructions,
    duration_minutes: version.duration_minutes,
    shuffle_questions: version.shuffle_questions,
    shuffle_options: version.shuffle_options,
    attempts_allowed: version.attempts_allowed,
    integrity_policy: version.integrity_policy,
    policy_trigger: version.policy_trigger,
    show_scores: version.show_scores,
    published_at: version.published_at,
    created_at: version.created_at,
    questions: questions.map((q) => ({
      id: q.id,
      qtype: q.qtype,
      text: q.text,
      options: q.options,
      points: q.points,
      order_index: q.order_index,
      answer: isStaff ? q.answer : null,
      tolerance: isStaff ? q.tolerance : null,
    })),
    attempts: isStaff ? summarizeAttemptsForVersion(versionId) : undefined,
    my_attempts: summarizeAttempts(viewerId, versionId),
  };
}

function summarizeAttempts(userId: number, versionId: number) {
  const rows = attemptRepo.listForUserQuiz(userId, versionId);
  const open = rows.find((a) => a.status === 'in_progress');
  const submitted = rows.filter((a) => a.status === 'submitted');
  const best = submitted.length
    ? submitted.reduce((m, a) => Math.max(m, a.score ?? 0), -Infinity)
    : null;
  return {
    count: rows.length,
    in_progress: open ? open.id : null,
    best_score: best,
    last_status: rows[0]?.status ?? null,
    last_receipt: submitted[0]?.receipt ?? null,
  };
}

function summarizeAttemptsForVersion(versionId: number) {
  const rows = attemptRepo.listForVersion(versionId);
  const statuses = rows.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  const submittedScores = rows
    .filter((a) => typeof a.score === 'number')
    .map((a) => a.score as number);
  return {
    total: rows.length,
    statuses,
    avg_score: submittedScores.length
      ? submittedScores.reduce((s, x) => s + x, 0) / submittedScores.length
      : null,
    best: submittedScores.length ? Math.max(...submittedScores) : null,
  };
}

// --------------------------------------------------------------------- list

quizzesRouter.get('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const role = assertStaff(req, courseId);
  const isStaff = role !== 'student';

  const quizzes = quizRepo.listForCourse(courseId).map((quiz) => {
    const versions = quizVersionRepo.listForQuiz(quiz.id);
    const published = quizVersionRepo.latestPublished(quiz.id);
    const draft = versions.find((v) => v.status === 'draft');
    return {
      quiz_id: quiz.id,
      published: published ? versionDetail(published.id, req.userId as number, role) : null,
      draft: isStaff && draft ? versionDetail(draft.id, req.userId as number, role) : null,
    };
  });

  res.json({ quizzes });
});

// ------------------------------------------------------------------- create

quizzesRouter.post('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const role = assertStaff(req, courseId);
  const quizId = quizRepo.create(courseId, req.userId as number);
  const versionId = quizVersionRepo.createDraft(quizId, courseId, req.userId as number, 1);
  res.status(201).json(versionDetail(versionId, req.userId as number, role));
});

// ------------------------------------------------------------------- detail

quizzesRouter.get('/:quizId', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const versions = quizVersionRepo.listForQuiz(quiz.id)
    .filter((v) => role === 'student' ? v.status === 'published' || v.status === 'archived' : true)
    .map((v) => versionDetail(v.id, req.userId as number, role));
  res.json({ quiz_id: quiz.id, course_id: quiz.course_id, versions });
});

// ------------------------------------------------------------------- update meta

quizzesRouter.put('/:quizId', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft || draft.status !== 'draft') {
    throw new AppError(409, 'Only the latest draft version can be edited. Create a new draft version.');
  }
  const body = req.body ?? {};
  if (body.title !== undefined) {
    if (!String(body.title).trim()) throw new AppError(400, 'Title cannot be empty.');
  }
  if (body.duration_minutes !== undefined && body.duration_minutes !== null) {
    const m = Number(body.duration_minutes);
    if (!Number.isFinite(m) || m < 1) throw new AppError(400, 'Duration must be positive minutes or off.');
  }
  if (body.attempts_allowed !== undefined) {
    const n = Number(body.attempts_allowed);
    if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'Attempts must be a positive integer.');
  }
  if (body.integrity_policy !== undefined && !['off', 'warn', 'strict'].includes(body.integrity_policy)) {
    throw new AppError(400, 'Invalid integrity policy.');
  }
  if (body.show_scores !== undefined && !['never', 'release', 'immediate'].includes(body.show_scores)) {
    throw new AppError(400, 'Invalid show-scores policy.');
  }
  quizVersionRepo.updateMeta(draft.id, {
    title: body.title !== undefined ? String(body.title) : undefined,
    instructions: body.instructions !== undefined ? String(body.instructions) : undefined,
    duration_minutes: body.duration_minutes !== undefined && body.duration_minutes !== null
      ? Number(body.duration_minutes)
      : null,
    shuffle_questions: body.shuffle_questions !== undefined ? Number(Boolean(body.shuffle_questions)) : undefined,
    shuffle_options: body.shuffle_options !== undefined ? Number(Boolean(body.shuffle_options)) : undefined,
    attempts_allowed: body.attempts_allowed !== undefined ? Number(body.attempts_allowed) : undefined,
    integrity_policy: body.integrity_policy,
    policy_trigger: body.policy_trigger,
    show_scores: body.show_scores,
  });
  res.json(versionDetail(draft.id, req.userId as number, role));
});

// ------------------------------------------------------------------- versioning

quizzesRouter.post('/:quizId/versions', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const newDraft = quizVersionRepo.clonePublished(quiz.id, req.userId as number);
  res.status(201).json(versionDetail(newDraft.id, req.userId as number, role));
});

// ------------------------------------------------------------------- publish

quizzesRouter.patch('/:quizId/publish', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertInstructor(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft || draft.status !== 'draft') throw new AppError(409, 'No draft version to publish.');
  const questions = questionRepo.listForVersion(draft.id);
  if (questions.length === 0) throw new AppError(400, 'Add at least one question before publishing.');
  quizVersionRepo.publish(draft.id);
  writeAudit(req, { action: 'quiz.publish', course_id: quiz.course_id, target: 'quiz:' + quiz.id });
  res.json(versionDetail(draft.id, req.userId as number, role));
});

// ------------------------------------------------------------------- questions

interface Validated {
  qtype: QuestionType;
  options?: string[];
  answer: unknown;
  tolerance?: number;
}

function validateQuestionData(data: {
  qtype: string;
  text: string;
  options?: unknown;
  answer: unknown;
  tolerance?: unknown;
  points?: unknown;
}): Validated {
  if (!['single', 'multiple', 'short', 'numeric'].includes(data.qtype)) {
    throw new AppError(400, 'Invalid question type.');
  }
  const qtype = data.qtype as QuestionType;
  if (!String(data.text ?? '').trim()) throw new AppError(400, 'Question text is required.');

  if (qtype === 'single' || qtype === 'multiple') {
    const constOptions = Array.isArray(data.options) ? data.options.map(String).map((s) => s.trim()).filter(Boolean) : [];
    if (constOptions.length < 2) throw new AppError(400, 'Choice questions need at least two options.');
    const answerIdx = Array.isArray(data.answer)
      ? data.answer.map(Number)
      : [Number(data.answer)];
    if (qtype === 'single') {
      const idx = Number(data.answer);
      if (!Number.isInteger(idx) || idx < 0 || idx >= constOptions.length) {
        throw new AppError(400, 'Answer must be a valid option index.');
      }
    } else {
      const idxs = answerIdx;
      if (idxs.length === 0 || idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= constOptions.length)) {
        throw new AppError(400, 'Answer must be a list of valid option indices.');
      }
    }
    return { qtype, options: constOptions, answer: data.answer };
  }

  if (qtype === 'numeric') {
    const n = Number(data.answer);
    if (!Number.isFinite(n)) throw new AppError(400, 'Numeric answer must be a number.');
    const tol = data.tolerance == null || data.tolerance === '' ? 0 : Number(data.tolerance);
    if (!Number.isFinite(tol) || tol < 0) throw new AppError(400, 'Tolerance must be a non-negative number.');
    return { qtype, options: undefined, answer: n, tolerance: tol };
  }

  const text = String(data.answer ?? '').trim();
  if (!text) throw new AppError(400, 'Short-answer expected value is required.');
  return { qtype, options: undefined, answer: text };
}

function editableDraft(req: AuthedRequest, quizId: number) {
  const quiz = quizRepo.get(quizId);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft || draft.status !== 'draft') {
    throw new AppError(409, 'Only the latest draft version is editable.');
  }
  return { quiz, draft, role };
}

quizzesRouter.post('/:quizId/questions', (req: AuthedRequest, res) => {
  const { draft, role } = editableDraft(req, Number(req.params.quizId));
  const v = validateQuestionData(req.body ?? {});
  const question = questionRepo.create(draft.id, {
    qtype: v.qtype,
    text: String(req.body.text),
    options: v.options,
    answer: v.answer,
    tolerance: v.tolerance,
    points: Number(req.body.points) || 1,
  });
  res.status(201).json({ question });
  void role;
});

quizzesRouter.put('/questions/:questionId', (req: AuthedRequest, res) => {
  const question = questionRepo.get(Number(req.params.questionId));
  if (!question) throw new AppError(404, 'Question not found.');
  const draft = quizVersionRepo.get(question.quiz_version_id);
  if (!draft || draft.status !== 'draft') throw new AppError(409, 'Published questions are frozen.');
  void editableDraft(req, draft.quiz_id);

  const body = req.body ?? {};
  const next: Record<string, unknown> = { ...question };
  if (body.qtype !== undefined) next.qtype = body.qtype;
  if (body.text !== undefined) next.text = body.text;
  if (body.options !== undefined) next.options = body.options;
  if (body.answer !== undefined) next.answer = body.answer;
  if (body.tolerance !== undefined) next.tolerance = body.tolerance;
  if (body.points !== undefined) next.points = body.points;

  const v = validateQuestionData(next as never);
  const updated = questionRepo.update(question.id, {
    qtype: v.qtype,
    text: String(next.text),
    options: v.options,
    answer: v.answer,
    tolerance: v.tolerance as number | null,
    points: Number(next.points) || 1,
  });
  res.json({ question: updated });
});

quizzesRouter.delete('/questions/:questionId', (req: AuthedRequest, res) => {
  const question = questionRepo.get(Number(req.params.questionId));
  if (!question) throw new AppError(404, 'Question not found.');
  const draft = quizVersionRepo.get(question.quiz_version_id);
  if (!draft || draft.status !== 'draft') throw new AppError(409, 'Published questions are frozen.');
  void editableDraft(req, draft.quiz_id);
  questionRepo.remove(question.id);
  res.json({ ok: true });
});

quizzesRouter.post('/:quizId/questions/reorder', (req: AuthedRequest, res) => {
  const { draft, role } = editableDraft(req, Number(req.params.quizId));
  const ids: number[] = Array.isArray(req.body?.question_ids) ? (req.body.question_ids as unknown[]).map(Number) : [];
  if (ids.length === 0) throw new AppError(400, 'question_ids is required.');
  const existing = questionRepo.listForVersion(draft.id).map((q) => q.id);
  if (ids.length !== existing.length || ids.some((id) => !existing.includes(id))) {
    throw new AppError(400, 'question_ids must contain every question exactly once.');
  }
  questionRepo.reorder(draft.id, ids);
  res.json(versionDetail(draft.id, req.userId as number, role));
});

// ------------------------------------------------------------------- preview (staff)

quizzesRouter.get('/:quizId/preview', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft) throw new AppError(404, 'No version to preview.');
  const questions = questionRepo.listForVersion(draft.id);
  res.json({
    ...versionDetail(draft.id, req.userId as number, role),
    student_view: questions.map((q) => ({
      id: q.id,
      qtype: q.qtype,
      text: q.text,
      options: q.options,
      points: q.points,
    })),
  });
});