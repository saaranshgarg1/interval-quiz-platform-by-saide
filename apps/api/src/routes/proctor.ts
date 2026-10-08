import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { attemptRepo, quizRepo, quizVersionRepo } from '../repo.js';
import { assertInstructor, assertStaff, writeAudit } from '../authz.js';
import {
  ATTEMPT_ACTIONS,
  announce,
  attemptAction,
  closeQuiz,
  extendTime,
  monitorSnapshot,
  parseIdentifiers,
  pauseQuiz,
  recentEvents,
  reopenQuiz,
  resolveStudents,
  resumeQuiz,
  liveExams,
  type AttemptAction,
} from '../services/proctor.js';
import { flagById, flagReport, raiseFlag, resolveFlag } from '../services/flags.js';

/**
 * Live exam control. RBAC follows RBAC.md: TAs monitor and may broadcast
 * announcements; changing anyone's time, pausing/ending the exam and rulings on
 * individual attempts are instructor-only exam-fairness controls.
 */
export const proctorRouter = Router();

proctorRouter.use(requireAuth);

function quizFor(req: AuthedRequest) {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  return quiz;
}

/** Turn `{ scope, students }` into user ids (null = everyone) plus unmatched identifiers. */
function targetStudents(courseId: number, body: Record<string, unknown>) {
  if (body.scope !== 'students') return { userIds: null, not_found: [] as string[], users: [] };
  const identifiers = parseIdentifiers(body.students);
  if (identifiers.filter((s) => s.trim()).length === 0) {
    throw new AppError(400, 'List the students by entry number or email.');
  }
  const resolved = resolveStudents(courseId, identifiers);
  if (resolved.users.length === 0) {
    throw new AppError(404, `No enrolled student matches: ${resolved.not_found.join(', ')}`, 'students_not_found', {
      not_found: resolved.not_found,
    });
  }
  return { userIds: resolved.users.map((u) => u.id), not_found: resolved.not_found, users: resolved.users };
}

/** Every quiz the caller can proctor that is live (or about to open) right now, across courses. */
proctorRouter.get('/live', (req: AuthedRequest, res) => {
  res.json({ exams: liveExams(req.userId as number, req.userRole === 'admin') });
});

/** Flagged candidates: automatic signals + staff flags, most serious first. */
proctorRouter.get('/quiz/:quizId/flags', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertStaff(req, quiz.course_id);
  res.json(flagReport(quiz.id));
});

/** Raise a flag on an attempt (TAs too: invigilators see things in the hall). */
proctorRouter.post('/attempt/:attemptId/flags', (req: AuthedRequest, res) => {
  const attempt = attemptRepo.get(Number(req.params.attemptId));
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertStaff(req, version.course_id);
  const flag = raiseFlag(req.userId as number, attempt.id, req.body?.severity, req.body?.reason);
  writeAudit(req, { action: 'attempt.flag', course_id: version.course_id, target: `attempt:${attempt.id}`, after: flag });
  res.status(201).json({ flag });
});

/** Resolving a flag is an integrity ruling: instructor only. */
proctorRouter.post('/flags/:flagId/resolve', (req: AuthedRequest, res) => {
  const flag = flagById(Number(req.params.flagId));
  if (!flag) throw new AppError(404, 'Flag not found.');
  assertInstructor(req, flag.course_id);
  resolveFlag(req.userId as number, flag.id, req.body?.resolution);
  writeAudit(req, {
    action: 'attempt.flag.resolve',
    course_id: flag.course_id,
    target: `flag:${flag.id}`,
    after: { resolution: req.body?.resolution },
  });
  res.json({ ok: true });
});

proctorRouter.get('/quiz/:quizId', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  const role = assertStaff(req, quiz.course_id);
  res.json({ ...monitorSnapshot(quiz.id), viewer_role: role });
});

proctorRouter.get('/quiz/:quizId/events', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertStaff(req, quiz.course_id);
  const after = Number(req.query.after ?? 0);
  const limit = Number(req.query.limit ?? 100);
  res.json({
    events: recentEvents(quiz.id, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 100),
  });
});

/** Preview who an identifier list resolves to before acting on it. */
proctorRouter.post('/quiz/:quizId/resolve', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertStaff(req, quiz.course_id);
  res.json(resolveStudents(quiz.course_id, parseIdentifiers(req.body?.students)));
});

proctorRouter.post('/quiz/:quizId/extend', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertInstructor(req, quiz.course_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const minutes = Number(body.minutes);
  const target = targetStudents(quiz.course_id, body);
  const result = extendTime(req.userId as number, quiz.id, {
    userIds: target.userIds,
    minutes,
    includeNew: body.include_new !== false,
    reopenExpired: body.reopen_expired === true,
    reason: typeof body.reason === 'string' ? body.reason : null,
  });
  writeAudit(req, {
    action: 'exam.extend',
    course_id: quiz.course_id,
    target: `quiz:${quiz.id}`,
    after: {
      minutes,
      scope: target.userIds ? 'students' : 'all',
      students: target.users.map((u) => u.entry_number ?? u.email),
      include_new: body.include_new !== false,
      reopen_expired: body.reopen_expired === true,
      reason: body.reason ?? null,
      ...result,
    },
  });
  res.json({ ...result, students: target.users, not_found: target.not_found });
});

proctorRouter.post('/quiz/:quizId/pause', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertInstructor(req, quiz.course_id);
  const result = pauseQuiz(quiz.id);
  writeAudit(req, { action: 'exam.pause', course_id: quiz.course_id, target: `quiz:${quiz.id}`, after: result });
  res.json(result);
});

proctorRouter.post('/quiz/:quizId/resume', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertInstructor(req, quiz.course_id);
  const result = resumeQuiz(req.userId as number, quiz.id);
  writeAudit(req, { action: 'exam.resume', course_id: quiz.course_id, target: `quiz:${quiz.id}`, after: result });
  res.json(result);
});

proctorRouter.post('/quiz/:quizId/close', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertInstructor(req, quiz.course_id);
  const result = closeQuiz(quiz.id);
  writeAudit(req, {
    action: 'exam.close',
    course_id: quiz.course_id,
    target: `quiz:${quiz.id}`,
    after: { ...result, reason: req.body?.reason ?? null },
  });
  res.json(result);
});

proctorRouter.post('/quiz/:quizId/reopen', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertInstructor(req, quiz.course_id);
  reopenQuiz(quiz.id);
  writeAudit(req, { action: 'exam.reopen', course_id: quiz.course_id, target: `quiz:${quiz.id}` });
  res.json({ ok: true });
});

proctorRouter.post('/quiz/:quizId/announce', (req: AuthedRequest, res) => {
  const quiz = quizFor(req);
  assertStaff(req, quiz.course_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = targetStudents(quiz.course_id, body);
  const questionId = body.question_id === undefined || body.question_id === null || body.question_id === ''
    ? null
    : Number(body.question_id);
  const sent = announce(req.userId as number, quiz.id, String(body.message ?? ''), target.userIds, questionId);
  writeAudit(req, {
    action: 'exam.announce',
    course_id: quiz.course_id,
    target: `quiz:${quiz.id}`,
    after: { message: body.message, scope: target.userIds ? 'students' : 'all', recipients: sent, question_id: questionId },
  });
  res.json({ ok: true, recipients: target.userIds ? target.userIds.length : 'all', not_found: target.not_found });
});

proctorRouter.post('/attempt/:attemptId/action', (req: AuthedRequest, res) => {
  const attempt = attemptRepo.get(Number(req.params.attemptId));
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = String(body.action ?? '') as AttemptAction;
  if (!ATTEMPT_ACTIONS.includes(action)) {
    throw new AppError(400, `action must be one of: ${ATTEMPT_ACTIONS.join(', ')}.`);
  }
  const minutes = body.minutes === undefined || body.minutes === null || body.minutes === '' ? null : Number(body.minutes);
  const view = attemptAction(req.userId as number, attempt.id, action, {
    reason: typeof body.reason === 'string' ? body.reason : null,
    minutes,
  });
  writeAudit(req, {
    action: `attempt.${action}`,
    course_id: version.course_id,
    target: `attempt:${attempt.id}`,
    before: { status: attempt.status, expires_at: attempt.expires_at },
    after: { reason: body.reason ?? null, minutes },
  });
  res.json(view);
});
