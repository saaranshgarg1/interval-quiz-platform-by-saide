import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { attemptRepo, quizVersionRepo, courseRepo, resultRepo } from '../repo.js';
import {
  startAttempt,
  buildAttemptView,
  saveAnswers,
  submitAttempt,
  reportClientEvent,
} from '../services/attempts.js';

export const attemptsRouter = Router();

attemptsRouter.use(requireAuth);

function ensureOwner(req: AuthedRequest, attemptId: number) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (attempt.user_id !== (req.userId as number)) throw new AppError(403, 'Not your attempt.');
  return attempt;
}

attemptsRouter.post('/quiz/:quizVersionId', (req: AuthedRequest, res) => {
  const view = startAttempt(req.userId as number, Number(req.params.quizVersionId));
  res.status(201).json(view);
});

attemptsRouter.get('/quiz/:quizVersionId/mine', (req: AuthedRequest, res) => {
  const versionId = Number(req.params.quizVersionId);
  const version = quizVersionRepo.get(versionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  const attempts = attemptRepo
    .listForUserQuiz(req.userId as number, versionId)
    .map((a) => {
      const canSeeScore =
        a.status === 'submitted' &&
        (version.show_scores === 'immediate' ||
          (version.show_scores === 'release' && resultReleased(a.id)));
      return {
        id: a.id,
        status: a.status,
        started_at: a.started_at,
        expires_at: a.expires_at,
        submitted_at: a.submitted_at,
        receipt: a.receipt,
        attempt_number: a.id,
        score: canSeeScore ? a.score : null,
        max_score: canSeeScore ? a.max_score : null,
        can_view_result: canSeeScore,
      };
    });
  res.json({ attempts });
});

function resultReleased(attemptId: number): boolean {
  const r = resultRepo.getByAttempt(attemptId);
  return Boolean(r?.released);
}

attemptsRouter.get('/:attemptId', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  res.json(buildAttemptView(attempt.id, req.userId as number));
});

attemptsRouter.put('/:attemptId/answers', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  const payload = req.body ?? {};
  if (!Array.isArray(payload.answers)) throw new AppError(400, 'answers array is required.');
  const result = saveAnswers(attempt.id, req.userId as number, {
    answers: payload.answers,
  });
  res.json({ acks: result.acks, attempt: result.attempt });
});

attemptsRouter.post('/:attemptId/submit', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  res.json(submitAttempt(attempt.id, req.userId as number));
});

attemptsRouter.post('/:attemptId/events', (req: AuthedRequest, res) => {
  const attempt = ensureOwner(req, Number(req.params.attemptId));
  const { kind, detail } = req.body ?? {};
  if (!kind) throw new AppError(400, 'event kind is required.');
  const outcome = reportClientEvent(
    attempt.id,
    req.userId as number,
    String(kind),
    typeof detail === 'string' ? detail : null,
  );
  if (outcome.lock) {
    res.status(423).json(outcome);
    return;
  }
  res.json(outcome);
});

attemptsRouter.get('/course/:courseId/incidents', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const course = courseRepo.get(courseId);
  if (!course) throw new AppError(404, 'Course not found.');
  const role = courseRepo.courseRole(courseId, req.userId as number);
  if (!role || role === 'student') {
    if (req.userRole !== 'admin') throw new AppError(403, 'Staff access required.');
  }
  const versions = quizVersionRepo.activeVersionForCourse(courseId);
  const incidents = versions.flatMap((v) => {
    return attemptRepo.listForVersion(v.id)
      .filter((a) => ['locked', 'under_review', 'expired'].includes(a.status))
      .map((a) => ({
        attempt_id: a.id,
        quiz_version_id: v.id,
        quiz_title: v.title,
        status: a.status,
        started_at: a.started_at,
        expires_at: a.expires_at,
        user_id: a.user_id,
      }));
  });
  res.json({ incidents });
});