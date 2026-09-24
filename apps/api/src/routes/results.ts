import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { assertInstructor, assertStaff, writeAudit } from '../authz.js';
import {
  resultRepo,
  attemptRepo,
  quizVersionRepo,
  questionRepo,
  courseRepo,
  answerRepo,
} from '../repo.js';
import { gradeAttempt } from '../services/grading.js';
import { jsonParse } from '../util.js';
import type { ResultView } from '../api-types.js';

export const resultsRouter = Router();

resultsRouter.use(requireAuth);

function resultView(attemptId: number): ResultView | null {
  const result = resultRepo.getByAttempt(attemptId);
  if (!result) return null;
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(result.quiz_version_id);
  const course = version ? courseRepo.get(version.course_id) : undefined;

  return {
    id: result.id,
    attempt_id: attemptId,
    quiz_version_id: result.quiz_version_id,
    quiz_title: version?.title ?? '',
    course_code: course?.code ?? '',
    course_name: course?.name ?? '',
    version: version?.version ?? 0,
    score: result.score,
    max_score: result.max_score,
    released: result.released,
    answer_key_released: result.answer_key_released,
    released_at: result.released_at,
    submitted_at: attempt.submitted_at,
    per_question: [],
  };
}

function gradeBreakdown(attemptId: number): { question_id: number; earned: number }[] {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) return [];
  const questions = questionRepo.listForVersion(attempt.quiz_version_id);
  const answers = answerRepo.listForAttempt(attemptId);
  const graded = gradeAttempt(questions, answers);
  return graded.perQuestion.map((g) => ({ question_id: g.question_id, earned: g.earned }));
}

/** Build the per-question breakdown for a seen result. */
function perQuestionDetail(attemptId: number, answerKeyReleased: boolean) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) return [];
  const questions = questionRepo.listForVersion(attempt.quiz_version_id);
  const order = jsonParse<number[]>(attempt.question_order, []);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = order.map((id) => byId.get(id)).filter((q): q is NonNullable<typeof q> => Boolean(q));
  const answers = new Map(answerRepo.listForAttempt(attemptId).map((a) => [a.question_id, a]));
  const earned = new Map(gradeBreakdown(attemptId).map((g) => [g.question_id, g.earned]));
  return ordered.map((q) => {
    const yourAnswer = answers.get(q.id) ? jsonParse<unknown>(answers.get(q.id)?.answer ?? 'null', null) : null;
    return {
      question_id: q.id,
      text: q.text,
      qtype: q.qtype,
      options: q.options,
      your_answer: yourAnswer,
      answered: yourAnswer != null,
      correct_answer: answerKeyReleased ? q.answer : null,
      earned: earned.get(q.id) ?? 0,
      points: q.points,
    };
  });
}

resultsRouter.get('/mine', (req: AuthedRequest, res) => {
  const rows = resultRepo.listForUser(req.userId as number);
  res.json({ results: rows });
});

/** Instructor releases all results for a published quiz version. */
resultsRouter.post('/quiz/:quizVersionId/release', (req: AuthedRequest, res) => {
  const version = quizVersionRepo.get(Number(req.params.quizVersionId));
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const answerKey = Boolean((req.body ?? {}).answer_key ?? false);
  const n = resultRepo.releaseAllForVersion(version.id, answerKey);
  writeAudit(req, {
    action: 'results.release',
    course_id: version.course_id,
    target: 'version:' + version.id,
    after: { answer_key: answerKey, released: n },
  });
  res.json({ ok: true, released: n });
});

/** Release (or toggle answer key for) a single attempt result. */
resultsRouter.put('/attempt/:attemptId', (req: AuthedRequest, res) => {
  const attempt = attemptRepo.get(Number(req.params.attemptId));
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const result = resultRepo.getByAttempt(attempt.id);
  if (!result) throw new AppError(409, 'Attempt has not been graded yet.');
  const { release, answer_key } = req.body ?? {};
  if (typeof release === 'boolean') {
    if (version.show_scores === 'never') {
      throw new AppError(400, 'This quiz never shows scores.');
    }
    if (release) resultRepo.releaseByAttempt(attempt.id);
  }
  if (typeof answer_key === 'boolean') {
    resultRepo.setKeyReleased(attempt.id, answer_key ? 1 : 0);
  }
  writeAudit(req, {
    action: 'results.attempt.update',
    course_id: version.course_id,
    target: 'attempt:' + attempt.id,
    after: req.body,
  });
  res.json({ ok: true });
});

resultsRouter.get('/attempt/:attemptId', (req: AuthedRequest, res) => {
  const attempt = attemptRepo.get(Number(req.params.attemptId));
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const isOwner = attempt.user_id === (req.userId as number);
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!isOwner) {
    if (!version) throw new AppError(403, 'Not your attempt.');
    assertStaff(req, version.course_id);
  }
  const result = resultRepo.getByAttempt(attempt.id);
  if (!result || !result.released) {
    if (!isOwner || version?.show_scores !== 'immediate') {
      throw new AppError(404, 'Result has not been released yet.');
    }
  }
  const view = resultView(attempt.id);
  if (!view) throw new AppError(404, 'No result to show.');
  const perQuestion = perQuestionDetail(attempt.id, Boolean(result?.answer_key_released));
  res.json({
    result: {
      ...view,
      per_question: perQuestion,
    },
  });
});

/** CSV export of graded results for a published version. */
resultsRouter.get('/quiz/:quizVersionId/export.csv', (req: AuthedRequest, res) => {
  const version = quizVersionRepo.get(Number(req.params.quizVersionId));
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const rows = attemptRepo.listForVersion(version.id).filter((a) => a.status === 'submitted' || a.status === 'expired');
  const csvRows = [
    ['attempt_id', 'student_id', 'status', 'started_at', 'submitted_at', 'score', 'max_score', 'receipt'],
    ...rows.map((a) => [
      String(a.id),
      String(a.user_id),
      a.status,
      a.started_at,
      a.submitted_at ?? '',
      a.score ?? '',
      a.max_score ?? '',
      a.receipt ?? '',
    ]),
  ];
  const csv = csvRows.map((r) => r.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="result-${version.id}.csv"`);
  res.send(csv);
});