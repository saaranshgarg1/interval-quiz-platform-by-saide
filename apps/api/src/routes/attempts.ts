import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { db } from '../db.js';
import { attemptRepo, quizVersionRepo, courseRepo, resultRepo } from '../repo.js';
import { assertStaff } from '../authz.js';
import { scoreVisible } from '../services/finalize.js';
import {
  startAttempt,
  claimSession,
  getAttemptForStudent,
  saveAnswers,
  advanceQuestion,
  submitAttempt,
  reportClientEvent,
  heartbeat,
  raiseHand,
  type ClientContext,
} from '../services/attempts.js';

export const attemptsRouter = Router();

attemptsRouter.use(requireAuth);

/** The HTTP view of the caller: network address, browser, and attempt session token. */
export function clientContext(req: AuthedRequest): ClientContext {
  const session = req.get('x-attempt-session');
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    session: session && session.length <= 128 ? session : null,
  };
}

function ensureOwner(req: AuthedRequest, attemptId: number) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (attempt.user_id !== (req.userId as number)) throw new AppError(403, 'Not your attempt.');
  return attempt;
}

attemptsRouter.post('/quiz/:quizVersionId', (req: AuthedRequest, res) => {
  const view = startAttempt(req.userId as number, Number(req.params.quizVersionId), clientContext(req), {
    accessCode: req.body?.access_code,
  });
  res.status(201).json(view);
});

attemptsRouter.get('/quiz/:quizVersionId/mine', (req: AuthedRequest, res) => {
  const versionId = Number(req.params.quizVersionId);
  const version = quizVersionRepo.get(versionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  const attempts = attemptRepo
    .listForUserAcrossQuiz(req.userId as number, version.quiz_id)
    .map((a, i, all) => {
      const canSeeScore = scoreVisible(a, quizVersionRepo.get(a.quiz_version_id));
      const pending = resultRepo.getByAttempt(a.id)?.pending_manual ?? 0;
      return {
        id: a.id,
        status: a.status,
        started_at: a.started_at,
        expires_at: a.expires_at,
        submitted_at: a.submitted_at,
        receipt: a.receipt,
        attempt_number: all.length - i,
        score: canSeeScore ? a.score : null,
        max_score: canSeeScore ? a.max_score : null,
        can_view_result: canSeeScore,
        marking_pending: pending > 0,
        finalize_reason: a.finalize_reason,
      };
    });
  res.json({ attempts });
});


attemptsRouter.get('/:attemptId', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  res.json(getAttemptForStudent(req.userId as number, attempt.id, clientContext(req)));
});

/** Bind this window to the attempt (resume / take over / re-entry rules apply). */
attemptsRouter.post('/:attemptId/session', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  res.json(
    claimSession(req.userId as number, attempt.id, clientContext(req), { takeover: req.body?.takeover === true }),
  );
});

attemptsRouter.put('/:attemptId/answers', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  const payload = req.body ?? {};
  if (!Array.isArray(payload.answers)) throw new AppError(400, 'answers array is required.');
  const result = saveAnswers(req.userId as number, attempt.id, { answers: payload.answers }, clientContext(req));
  res.json(result);
});

attemptsRouter.post('/:attemptId/advance', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  const fromIndex = Number(req.body?.from_index);
  if (!Number.isInteger(fromIndex)) throw new AppError(400, 'from_index is required.');
  res.json(advanceQuestion(req.userId as number, attempt.id, fromIndex, clientContext(req)));
});

attemptsRouter.post('/:attemptId/submit', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  res.json(submitAttempt(req.userId as number, attempt.id, clientContext(req)));
});

attemptsRouter.post('/:attemptId/events', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  const { kind, detail } = req.body ?? {};
  if (!kind || typeof kind !== 'string' || kind.length > 40) throw new AppError(400, 'event kind is required.');
  const outcome = reportClientEvent(
    req.userId as number,
    attempt.id,
    kind,
    typeof detail === 'string' ? detail : null,
    clientContext(req),
  );
  if (outcome.lock) {
    res.status(423).json(outcome);
    return;
  }
  res.json(outcome);
});

attemptsRouter.post('/:attemptId/heartbeat', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  res.json(heartbeat(req.userId as number, attempt.id, req.body ?? {}, clientContext(req)));
});

/** Raise a hand: a private question to the invigilators during the exam. */
attemptsRouter.post('/:attemptId/hand', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  res.status(201).json({ hand: raiseHand(req.userId as number, attempt.id, req.body ?? {}, clientContext(req)) });
});

/** Locked attempts and attempts with recorded violations, across the course's published quizzes. */
attemptsRouter.get('/course/:courseId/incidents', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const course = courseRepo.get(courseId);
  if (!course) throw new AppError(404, 'Course not found.');
  assertStaff(req, courseId);
  const incidents = db
    .prepare(
      `SELECT a.id AS attempt_id, a.quiz_version_id, qv.quiz_id, qv.title AS quiz_title, a.status,
              a.started_at, a.expires_at, a.user_id, u.name AS user_name, u.email AS user_email,
              u.entry_number, a.violation_count, a.lock_reason, a.finalize_reason
       FROM attempts a
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       JOIN users u ON u.id = a.user_id
       WHERE qv.course_id = ?
         AND (a.status IN ('locked', 'under_review') OR a.violation_count > 0)
       ORDER BY CASE WHEN a.status IN ('locked', 'under_review') THEN 0 ELSE 1 END, a.id DESC
       LIMIT 1000`,
    )
    .all(courseId);
  res.json({ incidents });
});
