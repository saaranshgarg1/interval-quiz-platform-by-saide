import { db } from '../db.js';
import { attemptRepo, policyRepo } from '../repo.js';
import { AppError } from '../auth.js';
import { nowUtc } from '../util.js';

/**
 * Candidate flags: every sign of unauthorized activity on an attempt, rolled
 * into one severity so staff can see at a glance whom to look at.
 *
 *   automatic — browser and server signals recorded during the attempt
 *   manual    — flags raised by staff (seen in the hall, odd answer pattern…)
 *
 * A flag is a prompt for human review, never a verdict: browser signals have
 * innocent explanations, so nothing here changes a grade by itself.
 */

export type FlagLevel = 'none' | 'low' | 'medium' | 'high';
export type FlagSeverity = 'low' | 'medium' | 'high';

interface SignalSpec {
  label: string;
  weight: number;
}

/** Event kinds that count as signals, their label, and how much each one weighs. */
export const SIGNALS: Record<string, SignalSpec> = {
  tab_hidden: { label: 'Tab switches', weight: 3 },
  window_blur: { label: 'Window / app switches', weight: 3 },
  fullscreen_exit: { label: 'Left full screen', weight: 3 },
  session_takeover: { label: 'Opened on a second device while active', weight: 3 },
  reentry_blocked: { label: 'Re-entered after leaving (no-resume quiz)', weight: 4 },
  multiple_screens: { label: 'Extra display connected', weight: 2 },
  ip_changed: { label: 'Network address changed', weight: 2 },
  devtools_attempt: { label: 'Developer-tools shortcuts', weight: 2 },
  copy_attempt: { label: 'Copy attempts (blocked)', weight: 1 },
  cut_attempt: { label: 'Cut attempts (blocked)', weight: 1 },
  paste_attempt: { label: 'Paste attempts (blocked)', weight: 1 },
  drop_attempt: { label: 'Drag-in attempts (blocked)', weight: 1 },
  context_menu: { label: 'Right-click attempts (blocked)', weight: 1 },
  print_attempt: { label: 'Print attempts (blocked)', weight: 1 },
  system_key_attempt: { label: 'Windows key / Alt+Tab / Esc (blocked)', weight: 1 },
  reconnected: { label: 'Offline gaps', weight: 1 },
  resumed: { label: 'Resumed in a new window', weight: 1 },
};

const MANUAL_WEIGHT: Record<FlagSeverity, number> = { low: 2, medium: 4, high: 9 };

export function levelFor(score: number): FlagLevel {
  if (score <= 0) return 'none';
  if (score < 4) return 'low';
  if (score < 9) return 'medium';
  return 'high';
}

export interface ManualFlag {
  id: number;
  attempt_id: number;
  severity: FlagSeverity;
  reason: string;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
  resolution: string | null;
}

export interface AttemptFlags {
  attempt_id: number;
  score: number;
  level: FlagLevel;
  signals: Record<string, number>;
  open_manual: number;
}

const SIGNAL_KINDS = Object.keys(SIGNALS);

/** Signal counts + unresolved manual flags for every attempt on a quiz (all versions). */
export function flagsForQuiz(quizId: number): Map<number, AttemptFlags> {
  const marks = SIGNAL_KINDS.map(() => '?').join(', ');
  const counts = db
    .prepare(
      `SELECT pe.attempt_id, pe.kind, COUNT(*) AS n
       FROM policy_events pe
       JOIN attempts a ON a.id = pe.attempt_id
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       WHERE qv.quiz_id = ? AND pe.source IN ('client', 'server') AND pe.kind IN (${marks})
       GROUP BY pe.attempt_id, pe.kind`,
    )
    .all(quizId, ...SIGNAL_KINDS) as { attempt_id: number; kind: string; n: number }[];
  const manual = db
    .prepare(
      `SELECT f.attempt_id, f.severity, COUNT(*) AS n
       FROM attempt_flags f
       JOIN attempts a ON a.id = f.attempt_id
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       WHERE qv.quiz_id = ? AND f.resolved_at IS NULL
       GROUP BY f.attempt_id, f.severity`,
    )
    .all(quizId) as { attempt_id: number; severity: FlagSeverity; n: number }[];

  const out = new Map<number, AttemptFlags>();
  const entry = (attemptId: number) => {
    let e = out.get(attemptId);
    if (!e) out.set(attemptId, (e = { attempt_id: attemptId, score: 0, level: 'none', signals: {}, open_manual: 0 }));
    return e;
  };
  for (const row of counts) {
    const e = entry(Number(row.attempt_id));
    e.signals[row.kind] = Number(row.n);
    e.score += (SIGNALS[row.kind]?.weight ?? 0) * Number(row.n);
  }
  for (const row of manual) {
    const e = entry(Number(row.attempt_id));
    e.open_manual += Number(row.n);
    e.score += MANUAL_WEIGHT[row.severity] * Number(row.n);
  }
  for (const e of out.values()) e.level = levelFor(e.score);
  return out;
}

export function manualFlagsForQuiz(quizId: number): ManualFlag[] {
  return db
    .prepare(
      `SELECT f.*, c.name AS created_by_name, r.name AS resolved_by_name
       FROM attempt_flags f
       JOIN attempts a ON a.id = f.attempt_id
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       LEFT JOIN users c ON c.id = f.created_by
       LEFT JOIN users r ON r.id = f.resolved_by
       WHERE qv.quiz_id = ? ORDER BY f.id DESC`,
    )
    .all(quizId) as ManualFlag[];
}

export function manualFlagsForAttempt(attemptId: number): ManualFlag[] {
  return db
    .prepare(
      `SELECT f.*, c.name AS created_by_name, r.name AS resolved_by_name
       FROM attempt_flags f
       LEFT JOIN users c ON c.id = f.created_by
       LEFT JOIN users r ON r.id = f.resolved_by
       WHERE f.attempt_id = ? ORDER BY f.id DESC`,
    )
    .all(attemptId) as ManualFlag[];
}

/**
 * The flagged-candidates report: everyone with a signal or an open flag,
 * most serious first, with a plain-language breakdown.
 */
export function flagReport(quizId: number) {
  const flags = flagsForQuiz(quizId);
  const manual = manualFlagsForQuiz(quizId);
  if (flags.size === 0 && manual.length === 0) return { candidates: [], signal_labels: labels() };
  const rows = db
    .prepare(
      `SELECT a.id AS attempt_id, a.status, a.violation_count, a.lock_reason, a.finalize_reason,
              a.start_ip, a.last_ip, a.started_at, a.submitted_at, a.score, a.max_score,
              u.id AS user_id, u.name, u.email, u.entry_number
       FROM attempts a
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       JOIN users u ON u.id = a.user_id
       WHERE qv.quiz_id = ?`,
    )
    .all(quizId) as Record<string, unknown>[];
  const candidates = rows
    .map((r) => {
      const id = Number(r.attempt_id);
      const f = flags.get(id);
      const own = manual.filter((m) => Number(m.attempt_id) === id);
      if (!f && own.length === 0) return null;
      return {
        attempt_id: id,
        user_id: Number(r.user_id),
        name: String(r.name),
        email: String(r.email),
        entry_number: r.entry_number == null ? null : String(r.entry_number),
        status: String(r.status),
        violation_count: Number(r.violation_count ?? 0),
        lock_reason: r.lock_reason == null ? null : String(r.lock_reason),
        finalize_reason: r.finalize_reason == null ? null : String(r.finalize_reason),
        start_ip: r.start_ip == null ? null : String(r.start_ip),
        last_ip: r.last_ip == null ? null : String(r.last_ip),
        score: r.score == null ? null : Number(r.score),
        max_score: r.max_score == null ? null : Number(r.max_score),
        flag_score: f?.score ?? 0,
        level: f?.level ?? 'none',
        signals: f?.signals ?? {},
        manual_flags: own,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.flag_score - a.flag_score || a.name.localeCompare(b.name));
  return { candidates, signal_labels: labels() };
}

function labels(): Record<string, string> {
  return Object.fromEntries(Object.entries(SIGNALS).map(([k, v]) => [k, v.label]));
}

export function raiseFlag(actorId: number, attemptId: number, severity: unknown, reason: unknown): ManualFlag {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (severity !== 'low' && severity !== 'medium' && severity !== 'high') {
    throw new AppError(400, "severity must be 'low', 'medium' or 'high'.");
  }
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw new AppError(400, 'Describe what you observed.');
  if (text.length > 1000) throw new AppError(400, 'Keep the reason under 1000 characters.');
  const res = db
    .prepare('INSERT INTO attempt_flags (attempt_id, severity, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(attemptId, severity, text, actorId, nowUtc());
  policyRepo.log(attemptId, 'flag_raised', `Staff flag (${severity}): ${text}`, 'instructor');
  return manualFlagsForAttempt(attemptId).find((f) => f.id === Number(res.lastInsertRowid)) as ManualFlag;
}

export function flagById(flagId: number): (ManualFlag & { course_id: number }) | undefined {
  return db
    .prepare(
      `SELECT f.*, qv.course_id FROM attempt_flags f
       JOIN attempts a ON a.id = f.attempt_id
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       WHERE f.id = ?`,
    )
    .get(flagId) as (ManualFlag & { course_id: number }) | undefined;
}

export function resolveFlag(actorId: number, flagId: number, resolution: unknown): void {
  const flag = flagById(flagId);
  if (!flag) throw new AppError(404, 'Flag not found.');
  if (flag.resolved_at) throw new AppError(409, 'This flag is already resolved.');
  const text = typeof resolution === 'string' ? resolution.trim().slice(0, 1000) : '';
  if (!text) throw new AppError(400, 'Record how the flag was resolved.');
  db.prepare('UPDATE attempt_flags SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?').run(
    nowUtc(),
    actorId,
    text,
    flagId,
  );
  policyRepo.log(flag.attempt_id, 'flag_resolved', `Staff flag resolved: ${text}`, 'instructor');
}
