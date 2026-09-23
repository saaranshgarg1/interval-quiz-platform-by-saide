import { db } from '../db.js';
import {
  attemptRepo,
  answerRepo,
  quizVersionRepo,
  questionRepo,
  courseRepo,
  resultRepo,
  policyRepo,
  reviewRepo,
  accommodationRepo,
} from '../repo.js';
import { AppError } from '../auth.js';
import { shuffle, nowUtc, addMinutes, jsonParse, makeReceipt, randomToken } from '../util.js';
import { gradeAttempt } from './grading.js';
import { applyIntegrityEvent } from './policy.js';
import type { IntegralAttemptView, AttemptAnswer, SaveAck, SubmitResult } from '../api-types.js';
import type { Attempt, AttemptStatus } from '../types.js';

/** Server-side deadline check. */
export function isExpired(attempt: Attempt): boolean {
  const a = attempt as unknown as { expires_at?: string | null };
  if (!a.expires_at) return false;
  return nowUtc() > a.expires_at;
}

export function finalize(
  attempt: Attempt,
  reason: 'submitted' | 'expired',
  submittedAt?: string,
): SubmitResult {
  const questions = questionRepo.listForVersion(attempt.quiz_version_id);
  const answers = answerRepo.listForAttempt(attempt.id);
  const graded = gradeAttempt(questions, answers);
  answerRepo.markSubmitted(attempt.id);

  const receipt = makeReceipt(attempt.id);
  const token = randomToken(12);

  resultRepo.upsert(attempt.id, attempt.quiz_version_id, attempt.user_id, graded.score, graded.maxScore);

  const version = quizVersionRepo.get(attempt.quiz_version_id);
  const showScores = version?.show_scores ?? 'release';
  if (showScores === 'immediate') {
    resultRepo.releaseByAttempt(attempt.id);
  }

  const status: AttemptStatus = reason === 'submitted' ? 'submitted' : 'expired';
  attemptRepo.updateStatus(attempt.id, status, {
    submitted_at: reason === 'submitted' ? submittedAt ?? nowUtc() : attempt.submitted_at,
    score: graded.score,
    max_score: graded.maxScore,
    graded_at: nowUtc(),
    receipt,
    release_token: token,
  });

  return {
    attempt_id: attempt.id,
    status,
    receipt,
    release_token: token,
    score: graded.score,
    max_score: graded.maxScore,
    graded_at: nowUtc(),
    acknowledged_answers: answers.length,
    policy: {
      recorded: policyRepo.listForAttempt(attempt.id).length,
    },
  };
}

/** Finalize as expired when the deadline has passed and the attempt is still open. */
export function finalizeIfExpired(attempt: Attempt): boolean {
  if (attempt.status === 'in_progress' && isExpired(attempt)) {
    policyRepo.log(attempt.id, 'expired', 'Server deadline reached.', 'server');
    finalize(attempt, 'expired');
    return true;
  }
  return false;
}

export function startAttempt(userId: number, quizVersionId: number): IntegralAttemptView {
  const version = quizVersionRepo.get(quizVersionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  if (version.status !== 'published') {
    throw new AppError(403, 'This quiz is not published yet.');
  }
  const courseRole = courseRepo.courseRole(version.course_id, userId);
  if (!courseRole) throw new AppError(403, 'You are not enrolled in this course.');

  const used = attemptRepo.usedAttempts(userId, quizVersionId);
  if (used >= version.attempts_allowed) {
    throw new AppError(403, `Attempt limit reached (${version.attempts_allowed}).`);
  }

  // Re-enter an in-progress attempt if one exists.
  const mine = attemptRepo.listForUserQuiz(userId, quizVersionId);
  const open = mine.find((a) => a.status === 'in_progress');
  if (open) {
    finalizeIfExpired(open);
    if (open.status === 'in_progress') return buildAttemptView(open.id, userId);
  }

  const questions = questionRepo.listForVersion(quizVersionId);
  if (questions.length === 0) throw new AppError(400, 'This quiz has no questions yet.');

  const seed = Math.floor(Math.random() * 1_000_000_000);
  let order = questions.map((q) => q.id);
  if (version.shuffle_questions) order = shuffle(order, seed);

  let duration = version.duration_minutes;
  if (duration) {
    const accommodation = accommodationRepo.get(version.course_id, userId);
    if (accommodation) {
      duration = Math.round(duration * (accommodation.time_multiplier || 1.0)) + (accommodation.extra_minutes || 0);
    }
  }

  const expiresAt = duration ? addMinutes(duration) : null;
  const attemptId = attemptRepo.create(quizVersionId, userId, JSON.stringify(order), seed, expiresAt);
  return buildAttemptView(attemptId, userId);
}

export function buildAttemptView(attemptId: number, viewerId?: number): IntegralAttemptView {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (viewerId !== undefined && attempt.user_id !== viewerId) {
    throw new AppError(403, 'Not your attempt.');
  }
  finalizeIfExpired(attempt);

  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');

  const orderIds = jsonParse<number[]>(attempt.question_order, []);
  const byId = new Map(questionRepo.listForVersion(attempt.quiz_version_id).map((q) => [q.id, q]));
  const questions = orderIds
    .map((id) => byId.get(id))
    .filter((q): q is NonNullable<typeof q> => Boolean(q))
    .map((q) => ({
      id: q.id,
      qtype: q.qtype,
      text: q.text,
      options: q.options,
      points: q.points,
      order_index: q.order_index,
    }));

  const answers = answerRepo.listForAttempt(attempt.id);
  const answerMap: Record<number, AttemptAnswer> = {};
  for (const a of answers) {
    answerMap[a.question_id] = {
      question_id: a.question_id,
      answer: jsonParse<unknown>(a.answer, null),
      revision: a.revision,
      status: a.status,
      saved_at: a.saved_at,
    };
  }

  const latestSavedAt = answers
    .map((a) => a.saved_at)
    .sort()
    .at(-1);

  return {
    attempt: {
      id: attempt.id,
      quiz_version_id: attempt.quiz_version_id,
      status: attempt.status,
      started_at: attempt.started_at,
      expires_at: attempt.expires_at,
      submitted_at: attempt.submitted_at,
      score: attempt.score,
      max_score: attempt.max_score,
      receipt: attempt.receipt,
      submitted_revision: attempt.submitted_revision,
      last_save_at: latestSavedAt ?? null,
      server_now: nowUtc(),
    },
    quiz: {
      id: version.id,
      title: version.title,
      instructions: version.instructions,
      integrity_policy: version.integrity_policy,
      policy_trigger: version.policy_trigger,
    },
    questions,
    answers: answerMap,
    events: policyRepo.listForAttempt(attempt.id).map((e) => ({
      id: e.id,
      kind: e.kind,
      detail: e.detail,
      recorded_at: e.recorded_at,
    })),
  };
}

export function saveAnswers(
  userId: number,
  attemptId: number,
  payload: { answers: { question_id: number; answer: unknown; revision: number }[] },
): { acks: SaveAck[]; attempt: IntegralAttemptView['attempt'] } {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (attempt.user_id !== userId) throw new AppError(403, 'Not your attempt.');
  if (attempt.status !== 'in_progress') {
    throw new AppError(409, `Attempt is already ${attempt.status}.`);
  }
  if (finalizeIfExpired(attempt)) {
    throw new AppError(409, 'The deadline has passed; attempt finalized as expired.');
  }

  const version = attempt.quiz_version_id;
  const legal = new Set(questionRepo.listForVersion(version).map((q) => q.id));
  const orderIds = jsonParse<number[]>(attempt.question_order, []);

  const acks: SaveAck[] = [];
  for (const item of payload.answers) {
    if (!legal.has(item.question_id)) continue;
    const position = orderIds.indexOf(item.question_id);
    const answerJson = JSON.stringify(item.answer) ?? 'null';
    const ack = answerRepo.save(
      attemptId,
      item.question_id,
      position,
      answerJson,
      item.revision,
    );
    acks.push({
      question_id: item.question_id,
      acknowledged: ack.acknowledged,
      revision: ack.revision,
      saved_at: ack.saved_at,
    });
  }

  return { acks, attempt: buildAttemptView(attemptId, userId).attempt };
}

export function submitAttempt(userId: number, attemptId: number): SubmitResult {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (attempt.user_id !== userId) throw new AppError(403, 'Not your attempt.');
  if (attempt.status === 'submitted') {
    if (attempt.receipt) {
      return {
        attempt_id: attempt.id,
        status: 'submitted',
        receipt: attempt.receipt,
        release_token: attempt.release_token,
        score: attempt.score,
        max_score: attempt.max_score,
        graded_at: attempt.graded_at,
        acknowledged_answers: answerRepo.listForAttempt(attempt.id).length,
        policy: { recorded: policyRepo.listForAttempt(attempt.id).length },
      };
    }
    throw new AppError(409, 'Attempt already submitted.');
  }
  if (attempt.status === 'locked' || attempt.status === 'under_review') {
    throw new AppError(409, 'This attempt is locked. Contact your instructor for review.');
  }
  if (attempt.status === 'expired') {
    throw new AppError(409, 'This attempt was finalized because the deadline passed.');
  }

  // Deadline policy: answers that reach the server after the deadline are not
  // silently accepted; the attempted final submission finalizes as expired.
  if (isExpired(attempt)) {
    return finalize(attempt, 'expired');
  }

  return finalize(attempt, 'submitted', nowUtc());
}

/**
 * Report a client-side focus/visibility event. Policy engine decides
 * whether it is ignored, recorded, or triggers a server-side lock.
 */
export function reportClientEvent(
  userId: number,
  attemptId: number,
  kind: string,
  detail: string | null,
): { action: 'ignored' | 'recorded' | 'locked'; lock: boolean; message?: string } {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (attempt.user_id !== userId) throw new AppError(403, 'Not your attempt.');
  if (attempt.status !== 'in_progress') {
    return { action: 'ignored', lock: false, message: 'No active attempt session.' };
  }
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) return { action: 'ignored', lock: false };

  return applyIntegrityEvent(attempt, version.integrity_policy, version.policy_trigger, kind, detail);
}

/** Authorized incident review. */
export function reviewAttempt(
  reviewerId: number,
  attemptId: number,
  decision: string,
  reason: string | null,
): IntegralAttemptView | { attempt_id: number; decision: string } {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  const role = courseRepo.courseRole(version.course_id, reviewerId);
  if (!role || role === 'student') throw new AppError(403, 'Review requires course staff access.');

  reviewRepo.add(attempt.id, reviewerId, decision, reason);

  switch (decision) {
    case 'reinstate': {
      const extendsTo = version.duration_minutes ? addMinutes(version.duration_minutes) : null;
      attemptRepo.updateStatus(attempt.id, 'in_progress');
      dbSetExpiry(attempt.id, extendsTo);
      policyRepo.log(attempt.id, 'reinstated', reason ?? 'Reviewer reinstated the attempt.', 'server');
      return buildAttemptView(attempt.id);
    }
    case 'lock': {
      attemptRepo.updateStatus(attempt.id, 'locked');
      policyRepo.log(attempt.id, 'locked_confirm', reason ?? 'Reviewer confirmed the lock.', 'server');
      return { attempt_id: attempt.id, decision };
    }
    case 'allow_submit': {
      finalize(attempt, 'submitted', nowUtc());
      policyRepo.log(attempt.id, 'review_submitted', reason ?? 'Reviewed and submitted on behalf.', 'server');
      return buildAttemptView(attempt.id);
    }
    default:
      throw new AppError(400, `Unknown review decision '${decision}'.`);
  }
}

function dbSetExpiry(attemptId: number, expiresAt: string | null): void {
  db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(expiresAt, attemptId);
}