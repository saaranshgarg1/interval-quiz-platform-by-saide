import { db, transaction } from '../db.js';
import {
  attemptRepo,
  answerRepo,
  courseRepo,
  policyRepo,
  quizRepo,
  quizVersionRepo,
  questionRepo,
  resultRepo,
  reviewRepo,
} from '../repo.js';
import { announcementRepo, extensionRepo } from '../exam-repo.js';
import { AppError } from '../auth.js';
import { fromMs, jsonParse, nowUtc, toMs } from '../util.js';
import { finalize, lockAttempt, FINALIZE_LABELS, LOCK_LABELS } from './finalize.js';
import {
  buildAttemptView,
  limitFor,
  processTimers,
  SESSION_STALE_MS,
} from './attempts.js';
import { presetOf, publicSettings, resolveSettings, studentRules } from './exam-settings.js';
import { flagsForQuiz, type FlagLevel } from './flags.js';
import type { Attempt, AttemptStatus, Quiz, QuizVersion, User } from '../types.js';

/**
 * Live exam control for course staff: the monitor snapshot, time extensions,
 * pause/resume, end-now, announcements and per-attempt rulings. Every mutation
 * is recorded on the affected attempts' timelines; routes add the audit row.
 */

const OPEN_STATUSES: AttemptStatus[] = ['in_progress', 'locked', 'under_review'];

export interface ExamTarget {
  quiz: Quiz;
  /** Latest published version: the one students start now. */
  version: QuizVersion;
}

export function examTarget(quizId: number): ExamTarget {
  const quiz = quizRepo.get(quizId);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const version = quizVersionRepo.latestPublished(quiz.id);
  if (!version) throw new AppError(409, 'This quiz has no published version yet.', 'not_published');
  return { quiz, version };
}

/** Attempts on any version of the quiz in the given statuses. */
function attemptsForQuiz(quizId: number, statuses: AttemptStatus[], userIds?: number[]): Attempt[] {
  const marks = statuses.map(() => '?').join(', ');
  const userFilter = userIds ? ` AND a.user_id IN (${userIds.map(() => '?').join(', ') || 'NULL'})` : '';
  const ids = db
    .prepare(
      `SELECT a.id FROM attempts a JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       WHERE qv.quiz_id = ? AND a.status IN (${marks})${userFilter} ORDER BY a.id`,
    )
    .all(quizId, ...statuses, ...(userIds ?? [])) as { id: number }[];
  return ids.map((r) => attemptRepo.get(Number(r.id))).filter((a): a is Attempt => Boolean(a));
}

// ---------------------------------------------------------------- identities

export interface ResolvedStudents {
  users: Pick<User, 'id' | 'name' | 'email' | 'entry_number'>[];
  not_found: string[];
}

/**
 * Resolve what an instructor typed — entry numbers ("2022CSB1234"), emails, or
 * an email's local part — to enrolled students of the course.
 */
export function resolveStudents(courseId: number, identifiers: string[]): ResolvedStudents {
  const tokens = [...new Set(identifiers.map((t) => t.trim()).filter(Boolean))].slice(0, 2000);
  const users: ResolvedStudents['users'] = [];
  const not_found: string[] = [];
  const seen = new Set<number>();
  for (const token of tokens) {
    const row = (
      token.includes('@')
        ? db
            .prepare(
              `SELECT u.id, u.name, u.email, u.entry_number FROM users u
               JOIN memberships m ON m.user_id = u.id AND m.course_id = ? AND m.role = 'student'
               WHERE u.email = ? COLLATE NOCASE`,
            )
            .get(courseId, token)
        : db
            .prepare(
              `SELECT u.id, u.name, u.email, u.entry_number FROM users u
               JOIN memberships m ON m.user_id = u.id AND m.course_id = ? AND m.role = 'student'
               WHERE u.entry_number = ? COLLATE NOCASE
                  OR lower(substr(u.email, 1, instr(u.email, '@') - 1)) = lower(?)
               LIMIT 1`,
            )
            .get(courseId, token, token)
    ) as ResolvedStudents['users'][number] | undefined;
    if (!row) {
      not_found.push(token);
      continue;
    }
    if (!seen.has(Number(row.id))) {
      seen.add(Number(row.id));
      users.push({ ...row, id: Number(row.id) });
    }
  }
  return { users, not_found };
}

/** Accept a list or a comma/space/newline separated string of identifiers. */
export function parseIdentifiers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  if (typeof raw === 'string') return raw.split(/[\s,;]+/);
  return [];
}

// ---------------------------------------------------------------- monitor

export interface MonitorRow {
  user_id: number;
  name: string;
  email: string;
  entry_number: string | null;
  attempt_count: number;
  attempt: {
    id: number;
    quiz_version_id: number;
    status: AttemptStatus;
    started_at: string;
    expires_at: string | null;
    submitted_at: string | null;
    time_left_seconds: number | null;
    online: boolean;
    last_seen_at: string | null;
    violation_count: number;
    resume_count: number;
    current_index: number;
    total_questions: number;
    answered: number;
    score: number | null;
    max_score: number | null;
    start_ip: string | null;
    last_ip: string | null;
    ip_changed: boolean;
    extra_seconds: number;
    lock_reason: string | null;
    finalize_reason: string | null;
    reentry_allowed: boolean;
    flag_score: number;
    flag_level: FlagLevel;
    open_flags: number;
    signals: Record<string, number>;
  } | null;
}

export function monitorSnapshot(quizId: number) {
  const { quiz, version } = examTarget(quizId);
  const settings = resolveSettings(version);
  const now = Date.now();
  const pausedAt = quiz.paused_at ? toMs(quiz.paused_at) : null;

  const rows = db
    .prepare(
      `SELECT u.id AS student_id, u.name AS student_name, u.email AS student_email, u.entry_number AS student_entry,
              (SELECT COUNT(*) FROM attempts x JOIN quiz_versions xv ON xv.id = x.quiz_version_id
                WHERE x.user_id = u.id AND xv.quiz_id = ?) AS attempt_count,
              a.*,
              (SELECT COUNT(*) FROM answer_revisions r
                WHERE r.attempt_id = a.id AND r.answer NOT IN ('null', '""', '[]')) AS answered
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN attempts a ON a.id = (
         SELECT MAX(a2.id) FROM attempts a2 JOIN quiz_versions v2 ON v2.id = a2.quiz_version_id
         WHERE a2.user_id = u.id AND v2.quiz_id = ?)
       WHERE m.course_id = ? AND m.role = 'student'
       ORDER BY u.name COLLATE NOCASE`,
    )
    .all(quiz.id, quiz.id, quiz.course_id) as Record<string, unknown>[];
  const flags = flagsForQuiz(quiz.id);

  const summary = {
    enrolled: rows.length,
    not_started: 0,
    in_progress: 0,
    online: 0,
    submitted: 0,
    expired: 0,
    locked: 0,
    flagged: 0,
  };

  const students: MonitorRow[] = rows.map((r) => {
    // a.* carries its own user_id (NULL when not started) — read the aliased student columns.
    const base = {
      user_id: Number(r.student_id),
      name: String(r.student_name),
      email: String(r.student_email),
      entry_number: r.student_entry == null ? null : String(r.student_entry),
      attempt_count: Number(r.attempt_count ?? 0),
    };
    if (r.id == null) {
      summary.not_started++;
      return { ...base, attempt: null };
    }
    const status = r.status as AttemptStatus;
    const expiresAt = r.expires_at == null ? null : String(r.expires_at);
    const lastSeen = r.last_seen_at == null ? null : String(r.last_seen_at);
    const live = status === 'in_progress';
    const online = Boolean(live && lastSeen && !r.session_left_at && now - toMs(lastSeen) < SESSION_STALE_MS);
    const reference = pausedAt ?? now;
    const timeLeft =
      OPEN_STATUSES.includes(status) && expiresAt ? Math.max(0, Math.round((toMs(expiresAt) - reference) / 1000)) : null;
    const startIp = r.start_ip == null ? null : String(r.start_ip);
    const lastIp = r.last_ip == null ? null : String(r.last_ip);
    const violations = Number(r.violation_count ?? 0);

    if (live) summary.in_progress++;
    if (online) summary.online++;
    if (status === 'submitted') summary.submitted++;
    if (status === 'expired') summary.expired++;
    if (status === 'locked' || status === 'under_review') summary.locked++;
    const f = flags.get(Number(r.id));
    if (f && f.level !== 'none') summary.flagged++;

    return {
      ...base,
      attempt: {
        id: Number(r.id),
        quiz_version_id: Number(r.quiz_version_id),
        status,
        started_at: String(r.started_at),
        expires_at: expiresAt,
        submitted_at: r.submitted_at == null ? null : String(r.submitted_at),
        time_left_seconds: timeLeft,
        online,
        last_seen_at: lastSeen,
        violation_count: violations,
        resume_count: Number(r.resume_count ?? 0),
        current_index: Number(r.current_index ?? 0),
        total_questions: jsonParse<number[]>(String(r.question_order ?? '[]'), []).length,
        answered: Number(r.answered ?? 0),
        score: r.score == null ? null : Number(r.score),
        max_score: r.max_score == null ? null : Number(r.max_score),
        start_ip: startIp,
        last_ip: lastIp,
        ip_changed: Boolean(startIp && lastIp && startIp !== lastIp),
        extra_seconds: Number(r.extra_seconds ?? 0),
        lock_reason: r.lock_reason == null ? null : String(r.lock_reason),
        finalize_reason: r.finalize_reason == null ? null : String(r.finalize_reason),
        reentry_allowed: Boolean(r.reentry_allowed),
        flag_score: f?.score ?? 0,
        flag_level: f?.level ?? 'none',
        open_flags: f?.open_manual ?? 0,
        signals: f?.signals ?? {},
      },
    };
  });

  const globalExtra = extensionRepo.globalSeconds(quiz.id);
  const windowCloses =
    version.quiz_type === 'scheduled' && version.window_opens_at && version.window_duration_minutes
      ? fromMs(toMs(version.window_opens_at) + version.window_duration_minutes * 60_000 + globalExtra * 1000)
      : null;

  return {
    server_now: nowUtc(),
    quiz: {
      quiz_id: quiz.id,
      course_id: quiz.course_id,
      version_id: version.id,
      version: version.version,
      title: version.title,
      quiz_type: version.quiz_type,
      duration_minutes: version.duration_minutes,
      window_opens_at: version.window_opens_at,
      window_closes_at: windowCloses,
      attempts_allowed: version.attempts_allowed,
      question_count: questionRepo.countForVersion(version.id),
      paused_at: quiz.paused_at,
      closed_at: quiz.closed_at,
      extra_seconds_all: globalExtra,
      preset: presetOf(settings),
      settings: { ...publicSettings(settings), access_code: settings.access_code, allowed_networks: settings.allowed_networks },
      rules: studentRules(settings, {
        duration_minutes: version.duration_minutes,
        question_count: questionRepo.countForVersion(version.id),
        quiz_type: version.quiz_type,
      }),
    },
    summary,
    students,
    extensions: extensionRepo.listForQuiz(quiz.id).slice(0, 50),
    announcements: announcementRepo.listForQuiz(quiz.id).slice(0, 50),
    labels: { finalize: FINALIZE_LABELS, lock: LOCK_LABELS },
  };
}

/** Recent attempt events across the whole quiz (the monitor's activity feed). */
export function recentEvents(quizId: number, afterId = 0, limit = 100) {
  return db
    .prepare(
      `SELECT pe.id, pe.attempt_id, pe.kind, pe.detail, pe.recorded_at, pe.source,
              u.id AS user_id, u.name AS user_name, u.entry_number
       FROM policy_events pe
       JOIN attempts a ON a.id = pe.attempt_id
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       JOIN users u ON u.id = a.user_id
       WHERE qv.quiz_id = ? AND pe.id > ?
       ORDER BY pe.id DESC LIMIT ?`,
    )
    .all(quizId, afterId, Math.min(Math.max(limit, 1), 500));
}

// ---------------------------------------------------------------- time

export interface ExtendInput {
  /** null = every student. */
  userIds: number[] | null;
  minutes: number;
  /** Also lengthen attempts that start after this moment. */
  includeNew: boolean;
  /** Reopen attempts that already ran out of time (named students only). */
  reopenExpired: boolean;
  reason: string | null;
}

function shift(ts: string | null, seconds: number): string | null {
  return ts ? fromMs(toMs(ts) + seconds * 1000) : null;
}

/**
 * Give students more time. In-progress (and locked) attempts get the minutes
 * on their deadline and current question; the scheduled window closes later;
 * with `includeNew`, students who have not started yet get them on their
 * duration too. Named students may also have a timed-out attempt reopened.
 */
export function extendTime(actorId: number, quizId: number, input: ExtendInput) {
  const { quiz } = examTarget(quizId);
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 600) {
    throw new AppError(400, 'Extra time must be between 1 and 600 minutes.');
  }
  const seconds = input.minutes * 60;
  const reason = input.reason?.trim().slice(0, 300) || null;
  const label = `+${input.minutes} min${reason ? ` (${reason})` : ''}`;
  let extended = 0;
  let reopened = 0;
  let untimed = 0;

  transaction(() => {
    for (const userId of input.userIds ?? [null]) {
      extensionRepo.add({
        quiz_id: quiz.id,
        user_id: userId,
        seconds,
        applies_to_new: input.includeNew,
        kind: 'extension',
        reason,
        created_by: actorId,
      });
    }
    for (const a of attemptsForQuiz(quiz.id, OPEN_STATUSES, input.userIds ?? undefined)) {
      if (!a.expires_at && !a.question_expires_at) {
        untimed++;
        continue;
      }
      attemptRepo.patch(a.id, {
        expires_at: shift(a.expires_at, seconds),
        question_expires_at: shift(a.question_expires_at, seconds),
        extra_seconds: a.extra_seconds + seconds,
      });
      policyRepo.log(a.id, 'time_extended', `Instructor added time: ${label}.`, 'instructor');
      extended++;
    }
    if (input.reopenExpired && input.userIds) {
      for (const a of attemptsForQuiz(quiz.id, ['expired'], input.userIds)) {
        if (reopenTimedOut(a, seconds, label)) reopened++;
      }
    }
  });
  return { extended, reopened, untimed };
}

/** Reopen an attempt that was finalized only because time ran out. */
function reopenTimedOut(a: Attempt, seconds: number, label: string): boolean {
  if (a.finalize_reason !== 'time_expired' && a.finalize_reason !== 'question_time_elapsed') return false;
  if (resultRepo.getByAttempt(a.id)?.released) return false; // never reopen after results went out
  // Only the student's latest attempt can be reopened.
  const latest = attemptRepo.listForUserAcrossQuiz(a.user_id, quizVersionRepo.get(a.quiz_version_id)?.quiz_id ?? 0)[0];
  if (latest?.id !== a.id) return false;
  const now = Date.now();
  const deadline = Math.max(a.expires_at ? toMs(a.expires_at) : now, now) + seconds * 1000;
  const version = quizVersionRepo.get(a.quiz_version_id);
  const settings = version ? resolveSettings(version) : null;
  let questionExpires: string | null = null;
  if (settings && settings.question_timer !== 'off') {
    const order = jsonParse<number[]>(a.question_order, []);
    const q = questionRepo.get(order[a.current_index] as number);
    questionExpires = fromMs(Math.min(now + limitFor(q, settings) * 1000 + seconds * 1000, deadline));
  }
  resultRepo.removeForAttempt(a.id);
  answerRepo.markSaved(a.id);
  attemptRepo.patch(a.id, {
    status: 'in_progress',
    expires_at: fromMs(deadline),
    question_expires_at: questionExpires,
    submitted_at: null,
    score: null,
    max_score: null,
    graded_at: null,
    receipt: null,
    release_token: null,
    finalize_reason: null,
    reentry_allowed: 1,
    extra_seconds: a.extra_seconds + seconds,
  });
  policyRepo.log(a.id, 'reopened', `Instructor reopened the timed-out attempt: ${label}.`, 'instructor');
  return true;
}

// ---------------------------------------------------------------- pause / close

export function pauseQuiz(quizId: number): { paused_at: string } {
  const { quiz } = examTarget(quizId);
  if (quiz.closed_at) throw new AppError(409, 'This quiz has already been closed.');
  if (quiz.paused_at) return { paused_at: quiz.paused_at };
  const pausedAt = nowUtc();
  quizRepo.setPaused(quiz.id, pausedAt);
  return { paused_at: pausedAt };
}

/**
 * Resume a paused quiz. Every open attempt's clock is pushed back by the length
 * of the pause (so nobody loses time) and the scheduled window closes later.
 */
export function resumeQuiz(actorId: number, quizId: number): { paused_seconds: number } {
  const { quiz } = examTarget(quizId);
  if (!quiz.paused_at) return { paused_seconds: 0 };
  const seconds = Math.max(0, Math.ceil((Date.now() - toMs(quiz.paused_at)) / 1000));
  transaction(() => {
    extensionRepo.add({
      quiz_id: quiz.id,
      user_id: null,
      seconds,
      applies_to_new: false,
      kind: 'pause',
      reason: 'Quiz paused by instructor',
      created_by: actorId,
    });
    for (const a of attemptsForQuiz(quiz.id, OPEN_STATUSES)) {
      attemptRepo.patch(a.id, {
        expires_at: shift(a.expires_at, seconds),
        question_expires_at: shift(a.question_expires_at, seconds),
      });
    }
    quizRepo.setPaused(quiz.id, null);
  });
  return { paused_seconds: seconds };
}

/** End the quiz now: submit every in-progress attempt and refuse new starts. */
export function closeQuiz(quizId: number): { submitted: number; closed_at: string } {
  const { quiz } = examTarget(quizId);
  const closedAt = nowUtc();
  let submitted = 0;
  transaction(() => {
    quizRepo.setPaused(quiz.id, null);
    quizRepo.setClosed(quiz.id, closedAt);
    for (const a of attemptsForQuiz(quiz.id, ['in_progress'])) {
      finalize(a, 'submitted', 'closed_by_instructor');
      submitted++;
    }
  });
  return { submitted, closed_at: closedAt };
}

export function reopenQuiz(quizId: number): void {
  const { quiz } = examTarget(quizId);
  quizRepo.setClosed(quiz.id, null);
}

// ---------------------------------------------------------------- announcements

export function announce(
  actorId: number,
  quizId: number,
  message: string,
  userIds: number[] | null,
  questionId: number | null = null,
): number {
  const { quiz } = examTarget(quizId);
  const text = message.trim();
  if (!text) throw new AppError(400, 'Write a message to send.');
  if (text.length > 1000) throw new AppError(400, 'Announcements are limited to 1000 characters.');
  if (questionId !== null) {
    // A clarification pinned to a question of this quiz (any version).
    const q = questionRepo.get(questionId);
    const v = q ? quizVersionRepo.get(q.quiz_version_id) : undefined;
    if (!v || v.quiz_id !== quiz.id) throw new AppError(400, 'That question is not part of this quiz.');
  }
  return transaction(() => {
    for (const userId of userIds ?? [null]) announcementRepo.add(quiz.id, userId, text, actorId, questionId);
    return (userIds ?? [null]).length;
  });
}

// ---------------------------------------------------------------- per-attempt rulings

export type AttemptAction =
  | 'lock'
  | 'reinstate'
  | 'force_submit'
  | 'allow_reentry'
  | 'reset_session'
  | 'reset_violations';

export const ATTEMPT_ACTIONS: AttemptAction[] = [
  'lock',
  'reinstate',
  'force_submit',
  'allow_reentry',
  'reset_session',
  'reset_violations',
];

/** Time the student had left when the attempt was locked (from the lock event). */
function secondsLeftAtLock(a: Attempt): number {
  if (!a.expires_at) return 0;
  const lockEvent = policyRepo
    .listForAttempt(a.id)
    .reverse()
    .find((e) => e.kind === 'locked');
  const lockedAt = lockEvent ? toMs(lockEvent.recorded_at) : Date.now();
  return Math.max(0, Math.round((toMs(a.expires_at) - lockedAt) / 1000));
}

export function attemptAction(
  actorId: number,
  attemptId: number,
  action: AttemptAction,
  opts: { reason?: string | null; minutes?: number | null } = {},
) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const reason = opts.reason?.trim().slice(0, 500) || null;
  const why = reason ? ` Reason: ${reason}` : '';
  const isOpen = OPEN_STATUSES.includes(attempt.status);

  switch (action) {
    case 'lock': {
      if (attempt.status !== 'in_progress') throw new AppError(409, `Cannot lock an attempt that is ${attempt.status}.`);
      lockAttempt(attempt, 'instructor', `Locked by the instructor.${why}`);
      break;
    }
    case 'reinstate': {
      if (attempt.status !== 'locked' && attempt.status !== 'under_review') {
        throw new AppError(409, `Only locked attempts can be reinstated (this one is ${attempt.status}).`);
      }
      const now = Date.now();
      let expires = attempt.expires_at;
      let note = '';
      if (opts.minutes != null) {
        const minutes = Number(opts.minutes);
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 600) {
          throw new AppError(400, 'Extra minutes must be between 0 and 600.');
        }
        expires = shift(expires, minutes * 60);
        if (minutes) note = ` Added ${minutes} min.`;
      }
      if (expires && toMs(expires) < now + 30_000) {
        if (opts.minutes != null) {
          throw new AppError(400, 'The deadline would still be in the past. Add more minutes to reinstate.', 'deadline_passed');
        }
        // No minutes given: give back the time the student had when the lock happened.
        const restore = Math.max(120, secondsLeftAtLock(attempt));
        expires = fromMs(now + restore * 1000);
        note = ` Deadline had passed while locked; restored ${Math.round(restore / 60)} min.`;
      }
      const version = quizVersionRepo.get(attempt.quiz_version_id);
      const settings = version ? resolveSettings(version) : null;
      let questionExpires = attempt.question_expires_at;
      if (settings && settings.question_timer !== 'off' && questionExpires && toMs(questionExpires) < now + 10_000) {
        const order = jsonParse<number[]>(attempt.question_order, []);
        const q = questionRepo.get(order[attempt.current_index] as number);
        const fresh = now + limitFor(q, settings) * 1000;
        questionExpires = fromMs(expires ? Math.min(fresh, toMs(expires)) : fresh);
      }
      transaction(() => {
        attemptRepo.patch(attempt.id, {
          status: 'in_progress',
          expires_at: expires,
          question_expires_at: questionExpires,
          lock_reason: null,
          reentry_allowed: 1,
          extra_seconds:
            attempt.extra_seconds +
            (expires && attempt.expires_at ? Math.max(0, Math.round((toMs(expires) - toMs(attempt.expires_at)) / 1000)) : 0),
        });
        policyRepo.log(attempt.id, 'reinstated', `Reinstated by the instructor.${note}${why}`, 'instructor');
      });
      break;
    }
    case 'force_submit': {
      if (!isOpen) throw new AppError(409, `This attempt is already ${attempt.status}.`);
      transaction(() => {
        policyRepo.log(attempt.id, 'force_submitted', `Submitted by the instructor from saved answers.${why}`, 'instructor');
        finalize(attempt, 'submitted', 'instructor_forced');
      });
      break;
    }
    case 'allow_reentry': {
      if (!isOpen) throw new AppError(409, `This attempt is already ${attempt.status}.`);
      if (attempt.status !== 'in_progress') return attemptAction(actorId, attemptId, 'reinstate', opts);
      attemptRepo.patch(attempt.id, { reentry_allowed: 1 });
      policyRepo.log(attempt.id, 'reentry_allowed', `Instructor allowed one re-entry.${why}`, 'instructor');
      break;
    }
    case 'reset_session': {
      if (attempt.status !== 'in_progress') throw new AppError(409, `This attempt is ${attempt.status}.`);
      attemptRepo.patch(attempt.id, { session_hash: null, reentry_allowed: 1 });
      policyRepo.log(
        attempt.id,
        'session_reset',
        `Instructor disconnected the current window so the student can continue elsewhere.${why}`,
        'instructor',
      );
      break;
    }
    case 'reset_violations': {
      attemptRepo.patch(attempt.id, { violation_count: 0, last_violation_at: null });
      policyRepo.log(attempt.id, 'violations_cleared', `Instructor cleared the violation count.${why}`, 'instructor');
      break;
    }
    default:
      throw new AppError(400, `Unknown action '${String(action)}'.`);
  }
  reviewRepo.add(attempt.id, actorId, action, reason);
  return buildAttemptView(attempt.id);
}

/**
 * Legacy incident-review decisions (reinstate / lock / allow_submit) mapped
 * onto the same rulings the live monitor uses.
 */
export function reviewAttempt(
  reviewerId: number,
  attemptId: number,
  decision: string,
  reason: string | null,
  minutes?: number | null,
) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  const role = courseRepo.courseRole(version.course_id, reviewerId);
  if (role === 'student') throw new AppError(403, 'Review requires course staff access.');

  switch (decision) {
    case 'reinstate':
      return attemptAction(reviewerId, attemptId, 'reinstate', { reason, minutes });
    case 'lock': {
      // Confirming an existing lock is a recorded no-op; locking a live attempt locks it.
      if (attempt.status === 'in_progress') return attemptAction(reviewerId, attemptId, 'lock', { reason });
      reviewRepo.add(attempt.id, reviewerId, 'lock', reason);
      policyRepo.log(attempt.id, 'locked_confirm', reason ?? 'Reviewer confirmed the lock.', 'instructor');
      return { attempt_id: attempt.id, decision };
    }
    case 'allow_submit':
      return attemptAction(reviewerId, attemptId, 'force_submit', { reason });
    default:
      throw new AppError(400, `Unknown review decision '${decision}'.`);
  }
}

/** Re-check a single attempt's timers (used by the monitor before acting). */
export function refreshAttempt(attemptId: number): Attempt | undefined {
  const a = attemptRepo.get(attemptId);
  return a ? processTimers(a) : undefined;
}

// ---------------------------------------------------------------- live now

/**
 * Every quiz the viewer can proctor that is running right now — several can be
 * live at once, in the same course or in different courses, each with its own
 * clock, pause state, extensions and announcements.
 */
export function liveExams(userId: number, isAdmin: boolean) {
  const now = nowUtc();
  const rows = db
    .prepare(
      `SELECT q.id AS quiz_id, q.course_id, q.paused_at, c.code AS course_code, c.name AS course_name,
              qv.id AS version_id, qv.title, qv.quiz_type, qv.window_opens_at, qv.window_duration_minutes,
              qv.duration_minutes,
              (SELECT COUNT(*) FROM attempts a JOIN quiz_versions v ON v.id = a.quiz_version_id
                WHERE v.quiz_id = q.id AND a.status = 'in_progress') AS in_progress,
              (SELECT COUNT(*) FROM attempts a JOIN quiz_versions v ON v.id = a.quiz_version_id
                WHERE v.quiz_id = q.id AND a.status IN ('locked', 'under_review')) AS locked,
              (SELECT COUNT(*) FROM attempts a JOIN quiz_versions v ON v.id = a.quiz_version_id
                WHERE v.quiz_id = q.id AND a.status IN ('submitted', 'expired')) AS finished,
              (SELECT COUNT(*) FROM memberships m WHERE m.course_id = q.course_id AND m.role = 'student') AS enrolled
       FROM quizzes q
       JOIN courses c ON c.id = q.course_id
       JOIN quiz_versions qv ON qv.id = (
         SELECT id FROM quiz_versions WHERE quiz_id = q.id AND status = 'published' ORDER BY version DESC LIMIT 1)
       WHERE q.closed_at IS NULL
         AND (? = 1 OR EXISTS (SELECT 1 FROM memberships m WHERE m.course_id = q.course_id
                                 AND m.user_id = ? AND m.role IN ('ta', 'instructor')))`,
    )
    .all(isAdmin ? 1 : 0, userId) as Record<string, unknown>[];
  return rows
    .map((r) => {
      const scheduled = r.quiz_type === 'scheduled' && r.window_opens_at && r.window_duration_minutes;
      const extra = extensionRepo.globalSeconds(Number(r.quiz_id));
      const closesAt = scheduled
        ? fromMs(toMs(String(r.window_opens_at)) + Number(r.window_duration_minutes) * 60_000 + extra * 1000)
        : null;
      const windowOpen = Boolean(scheduled && String(r.window_opens_at) <= now && closesAt && now < closesAt);
      const upcoming = Boolean(scheduled && String(r.window_opens_at) > now);
      const inProgress = Number(r.in_progress);
      const online = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM attempts a JOIN quiz_versions v ON v.id = a.quiz_version_id
             WHERE v.quiz_id = ? AND a.status = 'in_progress' AND a.session_left_at IS NULL AND a.last_seen_at > ?`,
          )
          .get(Number(r.quiz_id), fromMs(Date.now() - SESSION_STALE_MS)) as { n: number }
      ).n;
      const flagged = [...flagsForQuiz(Number(r.quiz_id)).values()].filter((f) => f.level !== 'none').length;
      return {
        quiz_id: Number(r.quiz_id),
        course_id: Number(r.course_id),
        course_code: String(r.course_code),
        course_name: String(r.course_name),
        version_id: Number(r.version_id),
        title: String(r.title),
        quiz_type: String(r.quiz_type),
        window_opens_at: r.window_opens_at == null ? null : String(r.window_opens_at),
        window_closes_at: closesAt,
        duration_minutes: r.duration_minutes == null ? null : Number(r.duration_minutes),
        paused: Boolean(r.paused_at),
        state: r.paused_at ? 'paused' : inProgress > 0 || windowOpen ? 'live' : upcoming ? 'upcoming' : 'idle',
        enrolled: Number(r.enrolled),
        in_progress: inProgress,
        online: Number(online),
        locked: Number(r.locked),
        finished: Number(r.finished),
        flagged,
      };
    })
    .filter((x) => x.state !== 'idle')
    .sort((a, b) => (a.state === b.state ? a.title.localeCompare(b.title) : a.state === 'upcoming' ? 1 : -1));
}
