import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { attemptRepo, quizVersionRepo, policyRepo, reviewRepo, userRepo, pubUser, answerRepo } from '../repo.js';
import { buildAttemptView } from '../services/attempts.js';
import { reviewAttempt } from '../services/proctor.js';
import { manualFlagsForAttempt } from '../services/flags.js';
import { appealRepo, handRepo } from '../insight-repo.js';
import { paperLabels } from '../services/insights.js';
import { jsonParse } from '../util.js';
import type { AnswerRevision } from '../types.js';
import { assertStaff, assertInstructor, writeAudit } from '../authz.js';

export const reviewRouter = Router();

reviewRouter.use(requireAuth);

function staffForAttempt(req: AuthedRequest, attemptId: number) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertStaff(req, version.course_id);
  return { attempt, version };
}

/** Full audit trail for an attempt: answers (and every change to them), events, decisions, grade. */
reviewRouter.get('/attempt/:attemptId', (req: AuthedRequest, res) => {
  const { attempt, version } = staffForAttempt(req, Number(req.params.attemptId));
  const student = userRepo.findById(attempt.user_id);
  const answers = (answerRows(attempt.id)).map((a) => ({
    question_id: a.question_id,
    position: a.position,
    answer: jsonParse<unknown>(a.answer, null),
    revision: a.revision,
    saved_at: a.saved_at,
    status: a.status,
    assumption: a.assumption ?? null,
  }));
  res.json({
    attempt: {
      id: attempt.id,
      status: attempt.status,
      started_at: attempt.started_at,
      expires_at: attempt.expires_at,
      submitted_at: attempt.submitted_at,
      score: attempt.score,
      max_score: attempt.max_score,
      receipt: attempt.receipt,
      quiz_version_id: attempt.quiz_version_id,
      quiz_id: version.quiz_id,
      quiz_title: version.title,
      version: version.version,
      violation_count: attempt.violation_count,
      resume_count: attempt.resume_count,
      lock_reason: attempt.lock_reason,
      finalize_reason: attempt.finalize_reason,
      start_ip: attempt.start_ip,
      last_ip: attempt.last_ip,
      user_agent: attempt.user_agent,
      extra_seconds: attempt.extra_seconds,
      last_seen_at: attempt.last_seen_at,
    },
    student: student ? pubUser(student) : null,
    answers,
    history: answerRepo.history(attempt.id).map((h) => ({ ...h, answer: jsonParse<unknown>(h.answer, null) })),
    events: policyRepo.listForAttempt(attempt.id),
    decisions: reviewRepo.listForAttempt(attempt.id),
    flags: manualFlagsForAttempt(attempt.id),
    hands: handRepo.forAttempt(attempt.id),
    appeals: appealRepo.forAttempt(attempt.id),
    labels: Object.fromEntries(paperLabels(attempt.quiz_version_id)),
  });
});

function answerRows(attemptId: number): AnswerRevision[] {
  return answerRepo.listForAttempt(attemptId);
}

reviewRouter.post('/attempt/:attemptId', (req: AuthedRequest, res) => {
  const attempt = attemptRepo.get(Number(req.params.attemptId));
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const { decision, reason, minutes } = req.body ?? {};
  if (!['reinstate', 'lock', 'allow_submit'].includes(decision)) {
    throw new AppError(400, "decision must be 'reinstate', 'lock' or 'allow_submit'.");
  }
  const extra = minutes === undefined || minutes === null || minutes === '' ? null : Number(minutes);
  const outcome = reviewAttempt(
    req.userId as number,
    attempt.id,
    String(decision),
    typeof reason === 'string' && reason.trim() ? reason : null,
    extra,
  );
  writeAudit(req, { action: 'attempt.ruling', course_id: version.course_id, target: 'attempt:' + attempt.id, after: { decision, reason, minutes: extra } });
  res.json(outcome);
});

reviewRouter.get('/attempt/:attemptId/current', (req: AuthedRequest, res) => {
  const { attempt } = staffForAttempt(req, Number(req.params.attemptId));
  res.json(buildAttemptView(attempt.id));
});
