import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { attemptRepo, quizRepo, quizVersionRepo, questionRepo, slotRepo } from '../repo.js';
import { appealRepo, handRepo } from '../insight-repo.js';
import { assertInstructor, assertStaff, writeAudit } from '../authz.js';
import {
  answerHand,
  appealsForVersion,
  collusionReport,
  createAppeal,
  fairnessReport,
  gradingQueue,
  handsForQuiz,
  normalizeSlot,
  questionHealth,
  questionReview,
  regradeQuestion,
  resolveAppeal,
  setManualMarks,
} from '../services/insights.js';

/**
 * Post-exam analysis and fairness tools (see services/insights.ts).
 *
 * RBAC: course staff (TAs included) may read the reports, mark written
 * answers and answer raised hands; changing a question's grading for
 * everyone, normalizing random questions, running the collusion check and
 * deciding appeals are instructor decisions.
 */
export const insightsRouter = Router();

insightsRouter.use(requireAuth);

function versionFor(req: AuthedRequest) {
  const version = quizVersionRepo.get(Number(req.params.versionId));
  if (!version) throw new AppError(404, 'Quiz version not found.');
  return version;
}

function attemptCourse(attemptId: number) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  return { attempt, version };
}

// ---------------------------------------------------------------- marking

insightsRouter.get('/version/:versionId/grading', (req: AuthedRequest, res) => {
  const version = versionFor(req);
  assertStaff(req, version.course_id);
  res.json(gradingQueue(version.id));
});

insightsRouter.put('/attempt/:attemptId/question/:questionId/marks', (req: AuthedRequest, res) => {
  const { attempt, version } = attemptCourse(Number(req.params.attemptId));
  assertStaff(req, version.course_id);
  const body = req.body ?? {};
  const marks = body.marks === null || body.marks === '' || body.marks === undefined ? null : Number(body.marks);
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
  const out = setManualMarks(req.userId as number, attempt.id, Number(req.params.questionId), marks, feedback);
  writeAudit(req, {
    action: 'grading.marks',
    course_id: version.course_id,
    target: `attempt:${attempt.id}:question:${req.params.questionId}`,
    after: { marks, feedback: feedback || undefined },
  });
  res.json(out);
});

// ---------------------------------------------------------------- questions + regrade

insightsRouter.get('/version/:versionId/questions', (req: AuthedRequest, res) => {
  const version = versionFor(req);
  assertStaff(req, version.course_id);
  res.json(questionReview(version.id));
});

insightsRouter.post('/questions/:questionId/regrade', (req: AuthedRequest, res) => {
  const question = questionRepo.get(Number(req.params.questionId));
  if (!question) throw new AppError(404, 'Question not found.');
  const version = quizVersionRepo.get(question.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const out = regradeQuestion(question.id, req.body ?? {});
  writeAudit(req, {
    action: 'grading.regrade',
    course_id: version.course_id,
    target: `question:${question.id}`,
    before: { mode: question.grading_mode, answer: question.answer, accept_also: question.accept_also, tolerance: question.tolerance },
    after: {
      mode: out.question.grading_mode,
      answer: out.question.answer,
      accept_also: out.question.accept_also,
      tolerance: out.question.tolerance,
      regraded: out.regraded,
      changed: out.changed,
    },
  });
  res.json(out);
});

// ---------------------------------------------------------------- random-question fairness

insightsRouter.get('/version/:versionId/fairness', (req: AuthedRequest, res) => {
  const version = versionFor(req);
  assertStaff(req, version.course_id);
  res.json(fairnessReport(version.id));
});

insightsRouter.post('/slots/:slotId/normalize', (req: AuthedRequest, res) => {
  const slot = slotRepo.get(Number(req.params.slotId));
  if (!slot) throw new AppError(404, 'Random slot not found.');
  const version = quizVersionRepo.get(slot.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const mode = req.body?.mode === 'clear' ? 'clear' : 'raise_to_easiest';
  const out = normalizeSlot(slot.id, mode);
  writeAudit(req, {
    action: 'grading.normalize',
    course_id: version.course_id,
    target: `slot:${slot.id}`,
    after: { mode, bonuses: out.bonuses, changed: out.changed },
  });
  res.json(out);
});

// ---------------------------------------------------------------- collusion

/** Runs only when the instructor asks for it (POST), and is audit-logged. */
insightsRouter.post('/version/:versionId/collusion', (req: AuthedRequest, res) => {
  const version = versionFor(req);
  assertInstructor(req, version.course_id);
  const report = collusionReport(version.id);
  writeAudit(req, {
    action: 'integrity.collusion_check',
    course_id: version.course_id,
    target: `version:${version.id}`,
    after: { analysed: report.analysed_attempts, flagged: report.flagged },
  });
  res.json(report);
});

// ---------------------------------------------------------------- appeals

insightsRouter.get('/version/:versionId/appeals', (req: AuthedRequest, res) => {
  const version = versionFor(req);
  assertStaff(req, version.course_id);
  res.json(appealsForVersion(version.id));
});

insightsRouter.post('/appeals/:appealId/resolve', (req: AuthedRequest, res) => {
  const appeal = appealRepo.get(Number(req.params.appealId));
  if (!appeal) throw new AppError(404, 'Appeal not found.');
  const { version } = attemptCourse(appeal.attempt_id);
  assertInstructor(req, version.course_id);
  const out = resolveAppeal(req.userId as number, appeal.id, req.body ?? {});
  writeAudit(req, {
    action: 'appeal.resolve',
    course_id: version.course_id,
    target: `appeal:${appeal.id}`,
    after: { status: req.body?.status, marks: req.body?.marks },
  });
  res.json(out);
});

/** The student's own appeals on an attempt (staff of the course may read them too). */
insightsRouter.get('/attempt/:attemptId/appeals', (req: AuthedRequest, res) => {
  const { attempt, version } = attemptCourse(Number(req.params.attemptId));
  if (attempt.user_id !== req.userId) assertStaff(req, version.course_id);
  res.json({ appeals: appealRepo.forAttempt(attempt.id) });
});

insightsRouter.post('/attempt/:attemptId/appeals', (req: AuthedRequest, res) => {
  const { attempt } = attemptCourse(Number(req.params.attemptId));
  res.status(201).json({ appeal: createAppeal(req.userId as number, attempt.id, req.body ?? {}) });
});

// ---------------------------------------------------------------- live exam

insightsRouter.get('/quiz/:quizId/question-health', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  assertStaff(req, quiz.course_id);
  res.json(questionHealth(quiz.id));
});

insightsRouter.get('/quiz/:quizId/hands', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  assertStaff(req, quiz.course_id);
  res.json(handsForQuiz(quiz.id));
});

insightsRouter.post('/hands/:handId/answer', (req: AuthedRequest, res) => {
  const hand = handRepo.get(Number(req.params.handId));
  if (!hand) throw new AppError(404, 'Question not found.');
  const quiz = quizRepo.get(hand.quiz_id);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  assertStaff(req, quiz.course_id);
  const out = answerHand(req.userId as number, hand.id, req.body ?? {});
  writeAudit(req, {
    action: 'exam.hand.answer',
    course_id: quiz.course_id,
    target: `hand:${hand.id}`,
    after: { broadcast: Boolean(req.body?.broadcast), dismissed: Boolean(req.body?.dismiss) },
  });
  res.json(out);
});
