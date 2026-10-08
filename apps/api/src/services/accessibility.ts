import { db } from '../db.js';
import { AppError } from '../auth.js';
import { jsonParse } from '../util.js';
import type { User } from '../types.js';

/**
 * Display preferences that follow a user across every page and every exam.
 * They change how the page looks, never what is asked or how long it lasts,
 * so a student may set them freely — just not in the middle of an exam,
 * where a sudden layout change could be used as an excuse ("the page
 * changed"). Extra time is an accommodation and only an admin can grant it.
 */
export interface AccessibilityPrefs {
  text_size: 'normal' | 'large' | 'x-large';
  contrast: 'normal' | 'high';
  reduce_motion: boolean;
  dyslexia_font: boolean;
  line_spacing: 'normal' | 'relaxed';
  underline_links: boolean;
}

export const DEFAULT_PREFS: AccessibilityPrefs = {
  text_size: 'normal',
  contrast: 'normal',
  reduce_motion: false,
  dyslexia_font: false,
  line_spacing: 'normal',
  underline_links: false,
};

export interface AccessibilityProfile {
  prefs: AccessibilityPrefs;
  /** Account-wide time accommodation (1 = none). */
  time_multiplier: number;
  /** Students cannot change preferences while an attempt is in progress. */
  locked_by_attempt: number | null;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

export function readPrefs(user: Pick<User, 'a11y'> | undefined): AccessibilityPrefs {
  const raw = jsonParse<Partial<AccessibilityPrefs>>(user?.a11y ?? '{}', {});
  return normalizePrefs(raw, DEFAULT_PREFS);
}

/** Merge a partial update into `base`; rejects unknown values rather than guessing. */
export function normalizePrefs(input: unknown, base: AccessibilityPrefs = DEFAULT_PREFS): AccessibilityPrefs {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const bool = (k: keyof AccessibilityPrefs) => (p[k] === undefined ? (base[k] as boolean) : Boolean(p[k]));
  return {
    text_size: oneOf(p.text_size ?? base.text_size, ['normal', 'large', 'x-large'] as const, base.text_size),
    contrast: oneOf(p.contrast ?? base.contrast, ['normal', 'high'] as const, base.contrast),
    reduce_motion: bool('reduce_motion'),
    dyslexia_font: bool('dyslexia_font'),
    line_spacing: oneOf(p.line_spacing ?? base.line_spacing, ['normal', 'relaxed'] as const, base.line_spacing),
    underline_links: bool('underline_links'),
  };
}

function activeAttempt(userId: number): number | null {
  const row = db
    .prepare(`SELECT id FROM attempts WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1`)
    .get(userId) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

export function profileFor(user: User): AccessibilityProfile {
  return {
    prefs: readPrefs(user),
    time_multiplier: Number(user.time_multiplier ?? 1) || 1,
    locked_by_attempt: activeAttempt(user.id),
  };
}

/** Self-service change. Refused while the user is writing an exam. */
export function updateOwnPrefs(user: User, input: unknown): AccessibilityProfile {
  const attemptId = activeAttempt(user.id);
  if (attemptId !== null) {
    throw new AppError(
      409,
      'You can change accessibility settings before or after an exam, not during one.',
      'attempt_in_progress',
      { attempt_id: attemptId },
    );
  }
  const prefs = normalizePrefs(input, readPrefs(user));
  db.prepare('UPDATE users SET a11y = ? WHERE id = ?').run(JSON.stringify(prefs), user.id);
  return { prefs, time_multiplier: Number(user.time_multiplier ?? 1) || 1, locked_by_attempt: null };
}

/** Admin change: display preferences and/or the account-wide time accommodation. */
export function adminUpdateProfile(user: User, input: { prefs?: unknown; time_multiplier?: unknown }): AccessibilityProfile {
  const prefs = input.prefs === undefined ? readPrefs(user) : normalizePrefs(input.prefs, readPrefs(user));
  let multiplier = Number(user.time_multiplier ?? 1) || 1;
  if (input.time_multiplier !== undefined) {
    multiplier = Number(input.time_multiplier);
    if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 3) {
      throw new AppError(400, 'Extra time must be between 1× (none) and 3×.');
    }
    multiplier = Math.round(multiplier * 100) / 100;
  }
  db.prepare('UPDATE users SET a11y = ?, time_multiplier = ? WHERE id = ?').run(JSON.stringify(prefs), multiplier, user.id);
  return { prefs, time_multiplier: multiplier, locked_by_attempt: activeAttempt(user.id) };
}
