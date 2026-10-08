import { transaction } from '../db.js';
import { attemptRepo, policyRepo } from '../repo.js';
import type { Attempt, IntegrityPolicy, PolicyTrigger } from '../types.js';
import { fromMs, nowUtc, toMs } from '../util.js';
import type { EventOutcome } from '../api-types.js';
import { finalize, lockAttempt } from './finalize.js';
import {
  EVENT_LABELS,
  isMonitored,
  isViolation,
  normalizeEventKind,
  settingsFromLegacy,
  type ExamSettings,
} from './exam-settings.js';

/**
 * Integrity policy engine (G3 in the proposal).
 *
 * Each client event is classified against the quiz's exam settings:
 *   - not monitored        → ignored (practice quizzes collect nothing)
 *   - informational        → recorded for the instructor (e.g. a blocked paste)
 *   - violation            → counted; the student is warned with the running count
 *   - violation limit hit  → the configured action: lock for review, or submit
 *
 * Browser signals never prove misconduct, so the student only ever sees a
 * policy consequence, never a verdict. One real-world switch often fires both
 * `blur` and `visibilitychange`; violations within DEDUPE_MS count once.
 */
const DEDUPE_MS = 1500;

export function applyEvent(
  attempt: Attempt,
  settings: ExamSettings,
  rawKind: string,
  detail: string | null,
  opts: { paused?: boolean } = {},
): EventOutcome {
  const base = {
    lock: false,
    violation: false,
    violation_count: attempt.violation_count,
    max_violations: settings.max_violations,
    violation_action: settings.violation_action,
  };
  if (attempt.status !== 'in_progress') {
    return { ...base, action: 'ignored', message: 'No active attempt session.' };
  }
  if (!isMonitored(settings)) {
    return { ...base, action: 'ignored', message: 'Focus monitoring is disabled for this quiz.' };
  }
  const kind = normalizeEventKind(rawKind);
  const note = detail ? detail.slice(0, 500) : null;

  if (kind === 'page_exit') {
    // The session is gone (tab closed / navigated away); matters for exit & resume rules.
    transaction(() => {
      attemptRepo.patch(attempt.id, { session_left_at: nowUtc() });
      policyRepo.log(attempt.id, 'page_exit', note ?? 'The quiz page was closed or navigated away.', 'client');
    });
    return { ...base, action: 'recorded' };
  }

  const label = EVENT_LABELS[kind] ?? kind;
  if (opts.paused || !isViolation(kind, settings)) {
    // While paused nothing counts; tag it so flag reports skip it too.
    policyRepo.log(attempt.id, kind, note ?? `Student ${label}.`, opts.paused ? 'client-paused' : 'client');
    return { ...base, action: 'recorded' };
  }

  const now = Date.now();
  if (attempt.last_violation_at && now - toMs(attempt.last_violation_at) < DEDUPE_MS) {
    policyRepo.log(attempt.id, kind, `${note ?? `Student ${label}.`} (same incident — not counted again)`, 'client-duplicate');
    return { ...base, action: 'recorded' };
  }

  const count = attempt.violation_count + 1;
  transaction(() => {
    attemptRepo.patch(attempt.id, { violation_count: count, last_violation_at: fromMs(now) });
    policyRepo.log(attempt.id, kind, `Violation ${count}: student ${label}.${note ? ` ${note}` : ''}`, 'client');
  });
  const counted = { ...base, violation: true, violation_count: count };
  const limitReached = settings.violation_action !== 'none' && count >= settings.max_violations;

  if (limitReached && settings.violation_action === 'lock') {
    lockAttempt(
      attempt,
      'violation_limit',
      `Violation limit reached (${count}/${settings.max_violations}). Saved answers are kept and the deadline keeps running.`,
    );
    return {
      ...counted,
      action: 'locked',
      lock: true,
      message:
        `You ${label}. That was violation ${count} of ${settings.max_violations}, so your attempt is now locked. ` +
        'Your saved answers are kept. Ask your instructor to review it.',
    };
  }
  if (limitReached && settings.violation_action === 'submit') {
    finalize(attemptRepo.get(attempt.id) ?? attempt, 'submitted', 'violation_limit');
    return {
      ...counted,
      action: 'submitted',
      message:
        `You ${label}. That was violation ${count} of ${settings.max_violations}, so your attempt was submitted ` +
        'automatically with your saved answers.',
    };
  }
  return { ...counted, action: 'recorded', message: warningText(label, count, settings) };
}

function warningText(label: string, count: number, s: ExamSettings): string {
  if (s.violation_action === 'none') {
    return `You ${label}. This has been recorded for your instructor (violation ${count}).`;
  }
  const consequence = s.violation_action === 'lock' ? 'locked for instructor review' : 'submitted automatically';
  return `You ${label}. Warning ${count} of ${s.max_violations}: at ${s.max_violations} violations your attempt will be ${consequence}.`;
}

/** Back-compat entry point for the original off/warn/strict policy. */
export function applyIntegrityEvent(
  attempt: Attempt,
  policy: IntegrityPolicy,
  trigger: PolicyTrigger,
  kind: string,
  detail: string | null,
): EventOutcome {
  return applyEvent(attempt, settingsFromLegacy(policy, trigger), kind, detail);
}

export function policyLabel(policy: IntegrityPolicy): string {
  switch (policy) {
    case 'off':
      return 'Off — no focus-event collection';
    case 'warn':
      return 'Warn & record — events are logged and explained';
    case 'strict':
      return 'Strict — configured triggers lock the attempt pending review';
  }
}
