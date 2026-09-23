import { attemptRepo, policyRepo } from '../repo.js';
import type { Attempt, IntegrityPolicy, PolicyTrigger } from '../types.js';
import { nowUtc } from '../util.js';

/**
 * Integrity policy engine (G3 in the proposal).
 *
 *   off   : no focus-event collection. Events are ignored.
 *   warn  : supported events are logged and explained; the attempt continues.
 *   strict: on the configured trigger the server locks the attempt, records the
 *           reason, keeps acknowledged answers and the running deadline, and
 *           permits re-entry only after an authorized review decision.
 *
 * Page visibility and focus are different browser signals; neither proves
 * misconduct, so we never announce a verdict, only a policy consequence.
 */
export function applyIntegrityEvent(
  attempt: Attempt,
  policy: IntegrityPolicy,
  trigger: PolicyTrigger,
  kind: string,
  detail: string | null,
): { action: 'ignored' | 'recorded' | 'locked'; lock: boolean; message?: string } {
  if (policy === 'off') {
    return { action: 'ignored', lock: false, message: 'Focus monitoring is disabled for this quiz.' };
  }

  const supported = policyRepo.log(
    attempt.id,
    kind,
    detail ?? null,
    'client',
  );
  void supported;

  if (policy === 'warn') {
    return {
      action: 'recorded',
      lock: false,
      message: `Focus change recorded (${kind}). You may continue; review is available to your instructor.`,
    };
  }

  // strict
  if (kind !== trigger) {
    return {
      action: 'recorded',
      lock: false,
      message: `Event '${kind}' recorded but does not trigger the strict policy.`,
    };
  }

  if (attempt.status !== 'in_progress') {
    return { action: 'ignored', lock: false, message: 'No active attempt session.' };
  }

  attemptRepo.updateStatus(attempt.id, 'locked');
  policyRepo.log(
    attempt.id,
    'locked',
    `Trigger '${kind}' fired the strict policy. Deadline is preserved, acknowledged answers are kept.`,
    'server',
  );

  return {
    action: 'locked',
    lock: true,
    message:
      'Strict policy triggered. This attempt is locked and your answers are preserved. ' +
      'Request review from your instructor to re-enter.',
  };
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

export function heartbeatExpiry(ids: number[]): void {
  const now = nowUtc();
  for (const id of ids) {
    const attempt = attemptRepo.get(id);
    if (!attempt) continue;
    if (attempt.status === 'in_progress' && attempt.expires_at && now > attempt.expires_at) {
      attemptRepo.updateStatus(attempt.id, 'expired');
      policyRepo.log(attempt.id, 'expired', 'Server deadline reached (heartbeat).', 'server');
    }
  }
}