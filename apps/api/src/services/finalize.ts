import { transaction } from '../db.js';
import {
  attemptRepo,
  answerRepo,
  quizVersionRepo,
  questionRepo,
  resultRepo,
  policyRepo,
} from '../repo.js';
import { gradeAttempt, type GradeResult } from './grading.js';
import { manualGradeRepo } from '../insight-repo.js';
import { jsonParse, makeReceipt, nowUtc, randomToken } from '../util.js';
import type { SubmitResult } from '../api-types.js';
import type { Attempt, Question, QuizVersion } from '../types.js';

/**
 * Why an attempt ended — stored on `attempts.finalize_reason`, shown to the
 * student and exported to the gradebook.
 */
export type FinalizeReason =
  | 'submitted_by_student'
  | 'time_expired'
  | 'question_time_elapsed'
  | 'violation_limit'
  | 'reentry'
  | 'instructor_forced'
  | 'closed_by_instructor';

export const FINALIZE_LABELS: Record<string, string> = {
  submitted_by_student: 'Submitted by the student',
  time_expired: 'Time ran out — submitted automatically',
  question_time_elapsed: 'Question timers ran out — submitted automatically',
  violation_limit: 'Submitted automatically after reaching the violation limit',
  reentry: 'Submitted automatically when the student re-entered (exit & resume not allowed)',
  instructor_forced: 'Submitted by the instructor',
  closed_by_instructor: 'Submitted when the instructor ended the quiz',
};

export const LOCK_LABELS: Record<string, string> = {
  violation_limit: 'Locked after reaching the violation limit',
  reentry: 'Locked because the student re-entered (exit & resume not allowed)',
  instructor: 'Locked by the instructor',
  legacy: 'Locked by the integrity policy',
};

/** Questions this attempt was dealt, in the student's order (random draws grade only these). */
export function questionsForAttempt(attempt: Attempt, all?: Question[]): Question[] {
  const byId = new Map((all ?? questionRepo.listForVersion(attempt.quiz_version_id)).map((q) => [q.id, q]));
  return jsonParse<number[]>(attempt.question_order, [])
    .map((id) => byId.get(id))
    .filter((q): q is Question => Boolean(q));
}

/**
 * May the student see their score right now? Never while written answers are
 * still waiting for the instructor's marks (the total would be misleading).
 */
export function scoreVisible(attempt: Attempt, version: QuizVersion | undefined): boolean {
  if (attempt.status !== 'submitted' && attempt.status !== 'expired') return false;
  if (!version) return false;
  const result = resultRepo.getByAttempt(attempt.id);
  if (result && result.pending_manual > 0) return false;
  if (version.show_scores === 'immediate') return true;
  if (version.show_scores === 'release') return Boolean(result?.released);
  return false;
}

/** Current grade of an attempt: its dealt questions, saved answers and any marks given by hand. */
export function gradeOf(attempt: Attempt, all?: Question[]): GradeResult {
  return gradeAttempt(
    questionsForAttempt(attempt, all),
    answerRepo.listForAttempt(attempt.id),
    manualGradeRepo.forAttempt(attempt.id),
  );
}

/**
 * Recompute a finished attempt after marks were given or a question was
 * regraded. No-op for attempts that are not graded yet.
 */
export function regradeAttempt(attemptId: number, all?: Question[]): GradeResult | null {
  return transaction(() => {
    const attempt = attemptRepo.get(attemptId);
    if (!attempt || (attempt.status !== 'submitted' && attempt.status !== 'expired')) return null;
    const graded = gradeOf(attempt, all);
    resultRepo.upsert(attempt.id, attempt.quiz_version_id, attempt.user_id, graded.score, graded.maxScore, graded.pending);
    attemptRepo.patch(attempt.id, { score: graded.score, max_score: graded.maxScore, graded_at: nowUtc() });
    return graded;
  });
}

/** Regrade every finished attempt on a version; returns how many changed score. */
export function regradeVersion(quizVersionId: number): { regraded: number; changed: number } {
  return transaction(() => {
    const all = questionRepo.listForVersion(quizVersionId);
    let regraded = 0;
    let changed = 0;
    for (const a of attemptRepo.listByStatus(quizVersionId, ['submitted', 'expired'])) {
      const before = a.score;
      const g = regradeAttempt(a.id, all);
      if (!g) continue;
      regraded++;
      if (before !== g.score) changed++;
    }
    return { regraded, changed };
  });
}

function submitSummary(attempt: Attempt, version: QuizVersion | undefined): SubmitResult {
  const visible = scoreVisible(attempt, version);
  return {
    attempt_id: attempt.id,
    status: attempt.status,
    receipt: attempt.receipt,
    release_token: attempt.release_token,
    score: visible ? attempt.score : null,
    max_score: visible ? attempt.max_score : null,
    graded_at: attempt.graded_at,
    acknowledged_answers: answerRepo.listForAttempt(attempt.id).length,
    pending_manual: resultRepo.getByAttempt(attempt.id)?.pending_manual ?? 0,
    finalize_reason: attempt.finalize_reason,
    policy: { recorded: policyRepo.countForAttempt(attempt.id, 'client') },
  };
}

/** Summary for an attempt that is already finalized (idempotent submit). */
export function finalizedSummary(attempt: Attempt): SubmitResult {
  return submitSummary(attempt, quizVersionRepo.get(attempt.quiz_version_id));
}

/**
 * Grade and close an attempt. Idempotent: a second call on an already-final
 * attempt returns the original receipt. Runs in one transaction so a crash can
 * never leave a graded result without a closed attempt (or vice versa).
 */
export function finalize(
  attempt: Attempt,
  status: 'submitted' | 'expired',
  reason: FinalizeReason = status === 'submitted' ? 'submitted_by_student' : 'time_expired',
  submittedAt?: string,
): SubmitResult {
  return transaction(() => {
    const fresh = attemptRepo.get(attempt.id) ?? attempt;
    const version = quizVersionRepo.get(fresh.quiz_version_id);
    if ((fresh.status === 'submitted' || fresh.status === 'expired') && fresh.receipt) {
      return submitSummary(fresh, version);
    }
    const graded = gradeOf(fresh);
    answerRepo.markSubmitted(fresh.id);

    const now = nowUtc();
    resultRepo.upsert(fresh.id, fresh.quiz_version_id, fresh.user_id, graded.score, graded.maxScore, graded.pending);
    if (version?.show_scores === 'immediate') resultRepo.releaseByAttempt(fresh.id);

    attemptRepo.patch(fresh.id, {
      status,
      submitted_at: status === 'submitted' ? submittedAt ?? now : fresh.submitted_at,
      score: graded.score,
      max_score: graded.maxScore,
      graded_at: now,
      receipt: makeReceipt(fresh.id),
      release_token: randomToken(12),
      finalize_reason: reason,
      lock_reason: null,
    });
    policyRepo.log(fresh.id, status === 'submitted' ? 'submitted' : 'expired', FINALIZE_LABELS[reason] ?? reason, 'server');
    return submitSummary(attemptRepo.get(fresh.id) as Attempt, version);
  });
}

export function lockAttempt(attempt: Attempt, reason: keyof typeof LOCK_LABELS | string, detail: string): void {
  transaction(() => {
    attemptRepo.patch(attempt.id, { status: 'locked', lock_reason: reason });
    policyRepo.log(attempt.id, 'locked', detail, 'server');
  });
}
