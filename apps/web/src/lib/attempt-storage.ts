/**
 * Browser-side attempt state.
 *
 * Session token → sessionStorage: it belongs to this tab only. A reload keeps
 * it (so a reload is never treated as leaving the exam); a new tab, window or
 * device does not have it and must claim the attempt under the quiz's
 * exit & resume rule.
 *
 * Unsaved answers → localStorage: if the network drops and the page is
 * reloaded or the browser crashes, answers typed meanwhile are restored and
 * sent once the connection is back. Cleared when the attempt ends.
 */

const PREFIX = 'interval.attempt.';
const sessionKey = (attemptId: number) => `${PREFIX}${attemptId}.session`;
const pendingKey = (attemptId: number) => `${PREFIX}${attemptId}.pending`;

export function getAttemptSession(attemptId: number): string | null {
  try {
    return sessionStorage.getItem(sessionKey(attemptId));
  } catch {
    return null;
  }
}

export function setAttemptSession(attemptId: number, token: string | null): void {
  try {
    if (token) sessionStorage.setItem(sessionKey(attemptId), token);
    else sessionStorage.removeItem(sessionKey(attemptId));
  } catch {
    /* storage unavailable: the session lives in memory for this page only */
  }
}

export function sessionHeaders(token: string | null): Record<string, string> {
  return token ? { 'X-Attempt-Session': token } : {};
}

export interface PendingAnswer {
  value: unknown;
  revision: number;
  /** Written assumption, for questions that allow one. */
  assumption?: string;
}

export function loadPending(attemptId: number): Record<number, PendingAnswer> {
  try {
    const raw = localStorage.getItem(pendingKey(attemptId));
    const parsed = raw ? (JSON.parse(raw) as Record<string, PendingAnswer>) : {};
    const out: Record<number, PendingAnswer> = {};
    for (const [qid, a] of Object.entries(parsed)) {
      if (a && typeof a.revision === 'number') out[Number(qid)] = a;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePending(attemptId: number, pending: Record<number, PendingAnswer>): void {
  try {
    if (Object.keys(pending).length === 0) localStorage.removeItem(pendingKey(attemptId));
    else localStorage.setItem(pendingKey(attemptId), JSON.stringify(pending));
  } catch {
    /* quota or privacy mode: answers still save normally while online */
  }
}

export function clearAttemptStorage(attemptId: number): void {
  try {
    localStorage.removeItem(pendingKey(attemptId));
    sessionStorage.removeItem(sessionKey(attemptId));
  } catch {
    /* ignore */
  }
}

/** On sign-out: leave nothing from any attempt behind on a shared machine. */
export function clearAllAttemptStorage(): void {
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (const key of Object.keys(store)) if (key.startsWith(PREFIX)) store.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
