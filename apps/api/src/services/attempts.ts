import { db, transaction } from '../db.js';
import {
  attemptRepo,
  answerRepo,
  quizRepo,
  quizVersionRepo,
  questionRepo,
  courseRepo,
  policyRepo,
  accommodationRepo,
  userRepo,
  bankRepo,
  slotRepo,
} from '../repo.js';
import crypto from 'node:crypto';
import { extensionRepo, announcementRepo, type Announcement } from '../exam-repo.js';
import { handRepo, type HandRaise } from '../insight-repo.js';
import { AppError } from '../auth.js';
import {
  shuffle,
  nowUtc,
  fromMs,
  toMs,
  jsonParse,
  randomToken,
  randomSeed,
  sha256,
  safeEqual,
  normalizeIp,
  ipAllowed,
} from '../util.js';
import { finalize, finalizedSummary, lockAttempt, questionsForAttempt, scoreVisible } from './finalize.js';
import { applyEvent } from './policy.js';
import {
  legacyPolicyOf,
  publicSettings,
  resolveSettings,
  studentRules,
  type ExamSettings,
} from './exam-settings.js';
import type {
  AnnouncementView,
  AttemptAnswer,
  HandView,
  EventOutcome,
  HeartbeatResult,
  IntegralAttemptView,
  SaveAck,
  SubmitResult,
} from '../api-types.js';
import type { Attempt, Question, QuestionSlot, Quiz, QuizVersion } from '../types.js';

export { finalize } from './finalize.js';

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Saves/submits arriving this long after a deadline still count (network latency). */
export const GRACE_MS = envInt('INTERVAL_SAVE_GRACE_MS', 5_000);
/** A session with no heartbeat for this long is considered gone. */
export const SESSION_STALE_MS = envInt('INTERVAL_SESSION_STALE_MS', 45_000);
/** How often the student client should check in. */
export const HEARTBEAT_MS = envInt('INTERVAL_HEARTBEAT_MS', 15_000);

/**
 * Who is calling, as seen by the HTTP layer. `session` is the per-attempt
 * session token from the X-Attempt-Session header. Internal callers (seed,
 * service tests) pass no context and are trusted.
 */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  session: string | null;
}

export type StartResult = IntegralAttemptView & { session_token: string | null };

interface ExamContext {
  version: QuizVersion;
  quiz: Quiz;
  settings: ExamSettings;
}

function examContext(attempt: Attempt): ExamContext {
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  const quiz = quizRepo.get(version.quiz_id);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  return { version, quiz, settings: resolveSettings(version) };
}

function ownAttempt(userId: number, attemptId: number): Attempt {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (attempt.user_id !== userId) throw new AppError(403, 'Not your attempt.');
  return attempt;
}

/** Per-question limit in seconds (only meaningful when a question timer is on). */
export function limitFor(q: Pick<Question, 'time_limit_seconds'> | undefined, s: ExamSettings): number {
  if (s.question_timer === 'per_question' && q?.time_limit_seconds) return q.time_limit_seconds;
  return s.question_time_seconds;
}

/** Scheduled-window bounds for one student, including any time extensions. */
function windowFor(version: QuizVersion, userId: number): { opensAt: number | null; closesAt: number | null } {
  if (version.quiz_type !== 'scheduled' || !version.window_opens_at || !version.window_duration_minutes) {
    return { opensAt: null, closesAt: null };
  }
  const opensAt = toMs(version.window_opens_at);
  const extra = extensionRepo.totals(version.quiz_id, userId).window;
  return { opensAt, closesAt: opensAt + version.window_duration_minutes * 60_000 + extra * 1000 };
}

/** Server-side deadline check. */
export function isExpired(attempt: Attempt): boolean {
  return attempt.expires_at ? Date.now() > toMs(attempt.expires_at) : false;
}

/**
 * Apply every timer that has run out: the overall deadline finalizes the
 * attempt; an elapsed question timer moves the cursor on (catching up across
 * several questions if the student was offline) and finalizes after the last.
 * Nothing moves while the quiz is paused.
 */
export function processTimers(attempt: Attempt, exam?: ExamContext): Attempt {
  if (attempt.status !== 'in_progress') return attempt;
  const { version, quiz, settings } = exam ?? examContext(attempt);
  if (quiz.paused_at) return attempt;
  const now = Date.now();

  if (attempt.expires_at && now > toMs(attempt.expires_at) + GRACE_MS) {
    finalize(attempt, 'expired', 'time_expired');
    return attemptRepo.get(attempt.id) as Attempt;
  }

  if (attempt.question_expires_at && now > toMs(attempt.question_expires_at) + GRACE_MS) {
    if (settings.question_timer === 'off') {
      attemptRepo.patch(attempt.id, { question_expires_at: null });
      return attemptRepo.get(attempt.id) as Attempt;
    }
    const order = jsonParse<number[]>(attempt.question_order, []);
    const byId = new Map(questionRepo.listForVersion(version.id).map((q) => [q.id, q]));
    const deadline = attempt.expires_at ? toMs(attempt.expires_at) : Number.POSITIVE_INFINITY;
    let idx = attempt.current_index;
    let qExp = toMs(attempt.question_expires_at);
    let qStart = qExp;
    while (now > qExp + GRACE_MS && idx < order.length - 1) {
      idx++;
      qStart = qExp;
      qExp = Math.min(qStart + limitFor(byId.get(order[idx] as number), settings) * 1000, deadline);
    }
    if (now > qExp + GRACE_MS) {
      transaction(() => {
        attemptRepo.patch(attempt.id, { current_index: idx });
        finalize(attempt, 'expired', 'question_time_elapsed');
      });
      return attemptRepo.get(attempt.id) as Attempt;
    }
    transaction(() => {
      attemptRepo.patch(attempt.id, {
        current_index: idx,
        question_started_at: fromMs(qStart),
        question_expires_at: fromMs(qExp),
      });
      policyRepo.log(
        attempt.id,
        'question_timeout',
        idx - attempt.current_index > 1
          ? `Question timers ran out while away: moved from question ${attempt.current_index + 1} to ${idx + 1}.`
          : `Time ran out on question ${attempt.current_index + 1}; moved on to question ${idx + 1}.`,
        'server',
      );
    });
    return attemptRepo.get(attempt.id) as Attempt;
  }
  return attempt;
}

/** Back-compat: finalize when the deadline has passed. Returns true when it did. */
export function finalizeIfExpired(attempt: Attempt): boolean {
  if (attempt.status !== 'in_progress') return false;
  return processTimers(attempt).status !== 'in_progress';
}

// ---------------------------------------------------------------- sessions

function sessionMatches(attempt: Attempt, token: string | null): boolean {
  return Boolean(token && attempt.session_hash && safeEqual(sha256(token), attempt.session_hash));
}

/** Is some other window still actively working on this attempt? */
function sessionLive(attempt: Attempt, now: number): boolean {
  return Boolean(
    attempt.session_hash &&
      !attempt.session_left_at &&
      attempt.last_seen_at &&
      now - toMs(attempt.last_seen_at) < SESSION_STALE_MS,
  );
}

/**
 * Only the window holding the attempt's session token may act on it. Two
 * windows (or two people) can never write to the same attempt at once.
 */
function assertSession(attempt: Attempt, ctx: ClientContext | undefined, settings: ExamSettings): void {
  if (!ctx || attempt.status !== 'in_progress') return;
  if (sessionMatches(attempt, ctx.session)) return;
  const details = {
    attempt_id: attempt.id,
    can_resume: settings.allow_resume || Boolean(attempt.reentry_allowed) || !attempt.session_hash,
    other_session_active: sessionLive(attempt, Date.now()),
    reentry_action: settings.allow_resume ? null : settings.reentry_action,
  };
  if (ctx.session) {
    throw new AppError(
      409,
      'This attempt was opened in another window or device, so this window was disconnected.',
      'session_replaced',
      details,
    );
  }
  throw new AppError(409, 'Continue this attempt from this window to carry on.', 'session_required', details);
}

/** Record presence for the active session (heartbeat, save, view). */
function touch(attempt: Attempt, ctx: ClientContext | undefined): void {
  if (!ctx) return;
  const ip = normalizeIp(ctx.ip);
  attemptRepo.patch(attempt.id, {
    last_seen_at: nowUtc(),
    session_left_at: null,
    ...(ip ? { last_ip: ip } : {}),
  });
  if (ip && attempt.last_ip && ip !== attempt.last_ip) {
    policyRepo.log(attempt.id, 'ip_changed', `Network address changed from ${attempt.last_ip} to ${ip}.`, 'server');
  }
}

function browserOf(ua: string | null | undefined): string {
  if (!ua) return 'unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
}

function describeClient(ctx: ClientContext | undefined): string {
  if (!ctx) return 'internal';
  return `IP ${normalizeIp(ctx.ip) ?? 'unknown'}, ${browserOf(ctx.userAgent)}`;
}

const SESSION_EVENT_TEXT = {
  session_started: 'Attempt opened.',
  resumed: 'Resumed in a new window.',
  session_takeover: 'Taken over from another active window, which was disconnected.',
  reentry_approved: 'Re-entered with instructor approval.',
} as const;

type SessionEvent = keyof typeof SESSION_EVENT_TEXT;

function grantSession(attempt: Attempt, ctx: ClientContext | undefined, event: SessionEvent): StartResult {
  const token = randomToken(32);
  const now = nowUtc();
  const ip = normalizeIp(ctx?.ip);
  transaction(() => {
    attemptRepo.patch(attempt.id, {
      session_hash: sha256(token),
      session_started_at: now,
      session_left_at: null,
      last_seen_at: now,
      last_ip: ip ?? attempt.last_ip,
      user_agent: ctx?.userAgent ? ctx.userAgent.slice(0, 300) : attempt.user_agent,
      reentry_allowed: 0,
      resume_count: event === 'session_started' ? attempt.resume_count : attempt.resume_count + 1,
    });
    const ipNote =
      ip && attempt.last_ip && ip !== attempt.last_ip ? ` Network address changed from ${attempt.last_ip}.` : '';
    policyRepo.log(attempt.id, event, `${SESSION_EVENT_TEXT[event]} ${describeClient(ctx)}.${ipNote}`, 'server');
  });
  return { ...buildAttemptView(attempt.id), session_token: token };
}

/**
 * Bind this window to an in-progress attempt. Applies the quiz's exit & resume
 * rule: with resume allowed the new window takes over (the old one is
 * disconnected); without it, re-entering after leaving locks or submits the
 * attempt. A reload in the same tab keeps its token and is never a re-entry.
 */
export function claimSession(
  userId: number,
  attemptId: number,
  ctx: ClientContext | undefined,
  opts: { takeover?: boolean } = {},
): StartResult {
  const attempt = ownAttempt(userId, attemptId);
  const exam = examContext(attempt);
  const current = processTimers(attempt, exam);
  if (current.status !== 'in_progress') return { ...buildAttemptView(current.id), session_token: null };
  if (!ctx) return grantSession(current, ctx, 'session_started');
  if (sessionMatches(current, ctx.session)) {
    touch(current, ctx);
    return { ...buildAttemptView(current.id), session_token: ctx.session };
  }

  const otherLive = sessionLive(current, Date.now());
  if (!current.session_hash) return grantSession(current, ctx, 'session_started');
  if (current.reentry_allowed) return grantSession(current, ctx, 'reentry_approved');
  if (exam.settings.allow_resume) {
    if (otherLive && !opts.takeover) {
      throw new AppError(409, 'This attempt is open in another window or device.', 'session_active', {
        can_takeover: true,
      });
    }
    return grantSession(current, ctx, otherLive ? 'session_takeover' : 'resumed');
  }
  if (otherLive) {
    throw new AppError(
      409,
      'This attempt is still open in another window. Exit & resume is not allowed for this quiz, so continue in that window.',
      'session_active',
      { can_takeover: false },
    );
  }
  const detail = `Re-entered after leaving the quiz (${describeClient(ctx)}); exit & resume is not allowed.`;
  if (exam.settings.reentry_action === 'submit') {
    policyRepo.log(current.id, 'reentry_blocked', detail, 'server');
    finalize(current, 'submitted', 'reentry');
    return { ...buildAttemptView(current.id), session_token: null };
  }
  lockAttempt(current, 'reentry', `${detail} Locked for instructor review.`);
  throw new AppError(
    423,
    'Exit & resume is not allowed for this quiz, so your attempt is locked until your instructor reviews it. Your saved answers are kept.',
    'attempt_locked',
    { lock_reason: 'reentry' },
  );
}

// ---------------------------------------------------------------- start

const accessFailures = new Map<string, { count: number; until: number }>();
const ACCESS_CODE_MAX_FAILURES = 5;
const ACCESS_CODE_LOCKOUT_MS = 5 * 60_000;

function checkAccessCode(userId: number, quizId: number, expected: string, provided: unknown): void {
  const key = `${userId}:${quizId}`;
  const now = Date.now();
  const entry = accessFailures.get(key);
  if (entry && entry.until > now && entry.count >= ACCESS_CODE_MAX_FAILURES) {
    throw new AppError(429, 'Too many wrong access codes. Wait a few minutes and try again.', 'access_code_locked');
  }
  const given = typeof provided === 'string' ? provided.trim() : '';
  if (!given) throw new AppError(403, 'Enter the access code announced by your instructor.', 'access_code_required');
  if (!safeEqual(given.toLowerCase(), expected.toLowerCase())) {
    accessFailures.set(
      key,
      entry && entry.until > now
        ? { count: entry.count + 1, until: entry.until }
        : { count: 1, until: now + ACCESS_CODE_LOCKOUT_MS },
    );
    throw new AppError(403, 'That access code is not correct.', 'access_code_invalid');
  }
  accessFailures.delete(key);
}

/**
 * This student's paper in authored order: every authored question, plus one
 * bank question drawn for each random slot. Within a paper a bank question is
 * never repeated; across the class each slot hands out its least-drawn
 * questions first, so neighbours rarely get the same one. Run in a transaction.
 */
function buildPaper(authored: Question[], slots: QuestionSlot[]): { id: number; order_index: number }[] {
  const items = authored.map((q) => ({ id: q.id, order_index: q.order_index }));
  const onPaper = new Set<number>();
  // Narrowest filters draw first so an "any difficulty" slot never takes the
  // only question a "hard" slot could have used. Paper order is by order_index.
  const specificity = (sl: QuestionSlot) => (sl.difficulty ? 0 : 1) + (sl.tag ? 0 : 1);
  for (const slot of [...slots].sort((a, b) => specificity(a) - specificity(b))) {
    const pool = bankRepo.pool(slot.bank_id, slot.difficulty, slot.tag).filter((q) => !onPaper.has(q.id));
    if (pool.length === 0) {
      throw new AppError(
        409,
        'This quiz cannot be started: its question bank no longer has enough matching questions. Tell your instructor.',
        'pool_exhausted',
      );
    }
    const used = slotRepo.drawCounts(slot.quiz_version_id);
    const least = Math.min(...pool.map((q) => used.get(q.id) ?? 0));
    const candidates = pool.filter((q) => (used.get(q.id) ?? 0) === least);
    const pick = candidates[crypto.randomInt(candidates.length)] as (typeof candidates)[number];
    onPaper.add(pick.id);
    items.push({ id: slotRepo.materialize(slot, pick), order_index: slot.order_index });
  }
  return items.sort((a, b) => a.order_index - b.order_index);
}

export function startAttempt(
  userId: number,
  quizVersionId: number,
  ctx?: ClientContext,
  opts: { accessCode?: unknown } = {},
): StartResult {
  const version = quizVersionRepo.get(quizVersionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  if (version.status !== 'published') {
    throw new AppError(403, 'This quiz is not published yet.');
  }
  const courseRole = courseRepo.courseRole(version.course_id, userId);
  if (!courseRole) throw new AppError(403, 'You are not enrolled in this course.');
  const quiz = quizRepo.get(version.quiz_id);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const settings = resolveSettings(version);

  // Continue an open attempt (on any version of this quiz) rather than starting another.
  const mine = attemptRepo.listForUserAcrossQuiz(userId, version.quiz_id);
  const open = mine.find((a) => a.status === 'in_progress');
  if (open && processTimers(open).status === 'in_progress') return claimSession(userId, open.id, ctx);
  if (mine.some((a) => a.status === 'locked' || a.status === 'under_review')) {
    throw new AppError(409, 'You have a locked attempt waiting for instructor review.', 'attempt_locked');
  }
  if (quiz.closed_at) throw new AppError(403, 'This quiz has been closed by the instructor.', 'quiz_closed');
  if (quiz.paused_at) {
    throw new AppError(403, 'This quiz is paused by the instructor. Try again when it resumes.', 'quiz_paused');
  }

  const now = Date.now();
  const { opensAt, closesAt } = windowFor(version, userId);
  // Scheduled quizzes are attemptable only inside their availability window. (item 8)
  if (version.quiz_type === 'scheduled') {
    if (opensAt === null || closesAt === null) {
      throw new AppError(403, 'This scheduled quiz has no availability window set.');
    }
    if (now < opensAt) {
      throw new AppError(403, `This quiz opens at ${version.window_opens_at} UTC.`, 'not_open', {
        opens_at: version.window_opens_at,
      });
    }
    if (now >= closesAt) throw new AppError(403, 'The availability window for this quiz has closed.', 'window_closed');
    if (settings.late_entry_minutes !== null && now > opensAt + settings.late_entry_minutes * 60_000) {
      throw new AppError(
        403,
        `Entry closed ${settings.late_entry_minutes} minutes after the quiz opened.`,
        'late_entry',
      );
    }
  }
  const ip = normalizeIp(ctx?.ip);
  if (ctx && !ipAllowed(ip, settings.allowed_networks)) {
    throw new AppError(403, 'This quiz can only be started from the exam-hall network.', 'network_blocked');
  }
  if (settings.access_code) checkAccessCode(userId, quiz.id, settings.access_code, opts.accessCode);

  if (mine.length >= version.attempts_allowed) {
    throw new AppError(403, `Attempt limit reached (${version.attempts_allowed}).`, 'attempt_limit');
  }

  const authored = questionRepo.listAuthored(quizVersionId);
  const slots = slotRepo.listForVersion(quizVersionId);
  if (authored.length + slots.length === 0) throw new AppError(400, 'This quiz has no questions yet.');

  const totals = extensionRepo.totals(quiz.id, userId);
  let expires: number | null = null;
  if (version.duration_minutes) {
    // Course accommodation (instructor) and account-wide accommodation (admin): the larger multiplier wins.
    const accommodation = accommodationRepo.get(version.course_id, userId);
    const multiplier = Math.max(accommodation?.time_multiplier || 1.0, userRepo.findById(userId)?.time_multiplier || 1.0);
    const minutes = version.duration_minutes * multiplier + (accommodation?.extra_minutes || 0);
    expires = now + Math.round(minutes * 60) * 1000 + totals.newAttempt * 1000;
  }
  // Scheduled quiz: the per-attempt timer never runs past the window close.
  if (closesAt !== null) expires = expires === null ? closesAt : Math.min(expires, closesAt);

  const seed = randomSeed();
  const token = randomToken(32);
  // Drawing bank questions and creating the attempt are one atomic step.
  const attemptId = transaction(() => {
    const paper = buildPaper(authored, slots);
    let order = paper.map((p) => p.id);
    const draw = settings.questions_per_attempt;
    const drawing = draw !== null && draw < order.length;
    if (version.shuffle_questions || drawing) order = shuffle(order, seed);
    if (drawing) {
      order = order.slice(0, draw);
      if (!version.shuffle_questions) {
        const rank = new Map(paper.map((p, i) => [p.id, i]));
        order.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      }
    }

    let questionExpires: number | null = null;
    if (settings.question_timer !== 'off') {
      questionExpires = now + limitFor(questionRepo.get(order[0] as number), settings) * 1000;
      if (expires !== null) questionExpires = Math.min(questionExpires, expires);
    }

    const id = attemptRepo.insert({
      quiz_version_id: quizVersionId,
      user_id: userId,
      question_order: JSON.stringify(order),
      seed,
      expires_at: expires === null ? null : fromMs(expires),
      started_at: fromMs(now),
      session_hash: sha256(token),
      start_ip: ip,
      user_agent: ctx?.userAgent ? ctx.userAgent.slice(0, 300) : null,
      question_expires_at: questionExpires === null ? null : fromMs(questionExpires),
    });
    if (totals.newAttempt) attemptRepo.patch(id, { extra_seconds: totals.newAttempt });
    policyRepo.log(id, 'started', `Attempt started. ${describeClient(ctx)}.`, 'server');
    return id;
  });
  return { ...buildAttemptView(attemptId), session_token: token };
}

// ---------------------------------------------------------------- view

/**
 * Per-attempt option order. Stored answers always use the author's original
 * option indices; students see (and send) indices into their shuffled list.
 */
export function optionPermutation(
  seed: number,
  q: Pick<Question, 'id' | 'qtype' | 'options'>,
  enabled: boolean,
): number[] {
  const identity = q.options.map((_, i) => i);
  if (!enabled || (q.qtype !== 'single' && q.qtype !== 'multiple') || identity.length < 2) return identity;
  return shuffle(identity, (seed ^ Math.imul(q.id, 0x9e3779b1)) >>> 0);
}

function toDisplay(q: Question, perm: number[], original: unknown): unknown {
  if (original === null || original === undefined) return null;
  if (q.qtype === 'single') {
    const d = perm.indexOf(Number(original));
    return d >= 0 ? d : null;
  }
  if (q.qtype === 'multiple') {
    if (!Array.isArray(original)) return [];
    return original
      .map((o) => perm.indexOf(Number(o)))
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);
  }
  return original;
}

function toOriginal(q: Question, perm: number[], display: unknown): unknown {
  if (display === null) return null;
  if (q.qtype === 'single') return perm[display as number] ?? null;
  if (q.qtype === 'multiple') return (display as number[]).map((d) => perm[d] as number).sort((a, b) => a - b);
  return display;
}

const MAX_SHORT_ANSWER = 2000;
const MAX_WRITTEN_ANSWER = 20_000;
const MAX_ASSUMPTION = 2000;

/** Shape-check one answer (display space). Half-typed numbers count as empty. */
function validateAnswer(q: Question, raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const n = q.options.length;
  switch (q.qtype) {
    case 'single': {
      const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? { ok: true, value: v } : { ok: false };
    }
    case 'multiple': {
      if (!Array.isArray(raw) || raw.length > n) return { ok: false };
      const values = raw.map(Number);
      if (values.some((v) => !Number.isInteger(v) || v < 0 || v >= n)) return { ok: false };
      return { ok: true, value: [...new Set(values)].sort((a, b) => a - b) };
    }
    case 'numeric': {
      if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
      const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
      return Number.isFinite(v) && Math.abs(v) <= 1e15 ? { ok: true, value: v } : { ok: true, value: null };
    }
    case 'short':
      return typeof raw === 'string' && raw.length <= MAX_SHORT_ANSWER ? { ok: true, value: raw } : { ok: false };
    case 'descriptive':
      return typeof raw === 'string' && raw.length <= MAX_WRITTEN_ANSWER ? { ok: true, value: raw } : { ok: false };
    default:
      return { ok: false };
  }
}

function toAnnouncementView(a: Announcement): AnnouncementView {
  return {
    id: a.id,
    message: a.message,
    created_at: a.created_at,
    personal: a.user_id !== null,
    question_id: a.question_id ?? null,
  };
}

/** Broadcasts, personal messages, and clarifications pinned to a question this student was given. */
function announcementsFor(attempt: Attempt, quizId: number, afterId = 0): AnnouncementView[] {
  const dealt = new Set(jsonParse<number[]>(attempt.question_order, []));
  return announcementRepo
    .forStudent(quizId, attempt.user_id, afterId)
    .filter((a) => a.question_id == null || dealt.has(Number(a.question_id)))
    .map(toAnnouncementView);
}

function toHandView(h: HandRaise): HandView {
  return {
    id: h.id,
    question_id: h.question_id,
    message: h.message,
    status: h.status,
    reply: h.reply,
    broadcast: Boolean(h.broadcast),
    created_at: h.created_at,
    answered_at: h.answered_at,
  };
}

export function buildAttemptView(attemptId: number, viewerId?: number): IntegralAttemptView {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (viewerId !== undefined && attempt.user_id !== viewerId) {
    throw new AppError(403, 'Not your attempt.');
  }
  const { version, quiz, settings } = examContext(attempt);
  const allQuestions = questionRepo.listForVersion(version.id);
  const dealt = questionsForAttempt(attempt, allQuestions);
  const inProgress = attempt.status === 'in_progress';
  // Sequential quizzes reveal only the current question; nothing is sent once the attempt is closed.
  const visible = !inProgress
    ? []
    : settings.navigation === 'sequential'
      ? dealt.slice(attempt.current_index, attempt.current_index + 1)
      : dealt;
  const perms = new Map(visible.map((q) => [q.id, optionPermutation(attempt.seed, q, Boolean(version.shuffle_options))]));
  const positions = new Map(dealt.map((q, i) => [q.id, i]));

  const questions = visible.map((q) => ({
    id: q.id,
    qtype: q.qtype,
    text: q.text,
    options: (perms.get(q.id) ?? []).map((i) => q.options[i] ?? ''),
    points: q.points,
    order_index: q.order_index,
    position: positions.get(q.id) ?? 0,
    time_limit_seconds: settings.question_timer === 'off' ? null : limitFor(q, settings),
    allow_assumptions: Boolean(q.allow_assumptions),
  }));

  const answers = answerRepo.listForAttempt(attempt.id);
  const visibleById = new Map(visible.map((q) => [q.id, q]));
  const answerMap: Record<number, AttemptAnswer> = {};
  for (const a of answers) {
    const q = visibleById.get(a.question_id);
    if (!q) continue;
    answerMap[a.question_id] = {
      question_id: a.question_id,
      answer: toDisplay(q, perms.get(q.id) ?? [], jsonParse<unknown>(a.answer, null)),
      revision: a.revision,
      status: a.status,
      saved_at: a.saved_at,
      assumption: a.assumption ?? null,
    };
  }

  const latestSavedAt = answers
    .map((a) => a.saved_at)
    .sort()
    .at(-1);
  const showScore = scoreVisible(attempt, version);
  const student = userRepo.findById(attempt.user_id);
  const legacy = legacyPolicyOf(settings);

  return {
    attempt: {
      id: attempt.id,
      quiz_version_id: attempt.quiz_version_id,
      status: attempt.status,
      started_at: attempt.started_at,
      expires_at: attempt.expires_at,
      submitted_at: attempt.submitted_at,
      score: showScore ? attempt.score : null,
      max_score: showScore ? attempt.max_score : null,
      receipt: attempt.receipt,
      submitted_revision: attempt.submitted_revision,
      last_save_at: latestSavedAt ?? null,
      server_now: nowUtc(),
      total_questions: dealt.length,
      current_index: attempt.current_index,
      question_expires_at: attempt.question_expires_at,
      violation_count: attempt.violation_count,
      resume_count: attempt.resume_count,
      extra_seconds: attempt.extra_seconds,
      lock_reason: attempt.lock_reason,
      finalize_reason: attempt.finalize_reason,
    },
    quiz: {
      id: version.id,
      quiz_id: version.quiz_id,
      title: version.title,
      instructions: version.instructions,
      integrity_policy: legacy.integrity_policy,
      policy_trigger: legacy.policy_trigger,
      show_scores: version.show_scores,
      settings: publicSettings(settings),
      rules: studentRules(settings, {
        duration_minutes: version.duration_minutes,
        question_count: questionRepo.countForVersion(version.id),
        quiz_type: version.quiz_type,
      }),
      paused: Boolean(quiz.paused_at),
    },
    student: {
      name: student?.name ?? '',
      email: student?.email ?? '',
      entry_number: student?.entry_number ?? null,
    },
    questions,
    answers: answerMap,
    events: policyRepo
      .listForAttempt(attempt.id)
      .slice(-50)
      .map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, recorded_at: e.recorded_at })),
    announcements: announcementsFor(attempt, quiz.id),
    hands: handRepo.forAttempt(attempt.id).map(toHandView),
    heartbeat_ms: HEARTBEAT_MS,
  };
}

/** The student's view of their attempt (session-checked while in progress). */
export function getAttemptForStudent(userId: number, attemptId: number, ctx?: ClientContext): IntegralAttemptView {
  const attempt = ownAttempt(userId, attemptId);
  const exam = examContext(attempt);
  const current = processTimers(attempt, exam);
  if (current.status === 'in_progress') {
    assertSession(current, ctx, exam.settings);
    touch(current, ctx);
  }
  return buildAttemptView(current.id);
}

// ---------------------------------------------------------------- saves

function liveMeta(attempt: Attempt) {
  return {
    id: attempt.id,
    status: attempt.status,
    expires_at: attempt.expires_at,
    question_expires_at: attempt.question_expires_at,
    current_index: attempt.current_index,
    violation_count: attempt.violation_count,
    server_now: nowUtc(),
  };
}

export function saveAnswers(
  userId: number,
  attemptId: number,
  payload: { answers: { question_id: number; answer: unknown; revision: number; assumption?: unknown }[] },
  ctx?: ClientContext,
): { acks: SaveAck[]; attempt: ReturnType<typeof liveMeta> } {
  const attempt = ownAttempt(userId, attemptId);
  const exam = examContext(attempt);
  if (attempt.status !== 'in_progress') {
    throw new AppError(409, `Attempt is already ${attempt.status}.`, 'attempt_not_active', { status: attempt.status });
  }
  assertSession(attempt, ctx, exam.settings);
  if (exam.quiz.paused_at) {
    throw new AppError(
      423,
      'The quiz is paused by your instructor. Your answers will be saved when it resumes.',
      'quiz_paused',
    );
  }
  const current = processTimers(attempt, exam);
  if (current.status !== 'in_progress') {
    throw new AppError(409, 'The deadline has passed; attempt finalized as expired.', 'deadline_passed', {
      status: current.status,
    });
  }
  if (!Array.isArray(payload.answers)) throw new AppError(400, 'answers array is required.');

  const order = jsonParse<number[]>(current.question_order, []);
  if (payload.answers.length > order.length) throw new AppError(400, 'Too many answers in one save.');
  const byId = new Map(questionRepo.listForVersion(current.quiz_version_id).map((q) => [q.id, q]));
  const writable =
    exam.settings.navigation === 'sequential' ? new Set([order[current.current_index]]) : new Set(order);

  const acks: SaveAck[] = [];
  transaction(() => {
    for (const item of payload.answers) {
      const questionId = Number(item?.question_id);
      const q = byId.get(questionId);
      if (!q || !order.includes(questionId)) continue;
      const revision = Number(item.revision);
      if (!writable.has(questionId)) {
        acks.push({ question_id: questionId, acknowledged: false, revision: 0, saved_at: '', reason: 'not_current' });
        continue;
      }
      const checked = validateAnswer(q, item.answer);
      if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000_000 || !checked.ok) {
        acks.push({ question_id: questionId, acknowledged: false, revision: 0, saved_at: '', reason: 'invalid' });
        continue;
      }
      const rawAssumption = q.allow_assumptions && typeof item.assumption === 'string' ? item.assumption : '';
      if (rawAssumption.length > MAX_ASSUMPTION) {
        acks.push({ question_id: questionId, acknowledged: false, revision: 0, saved_at: '', reason: 'invalid' });
        continue;
      }
      const perm = optionPermutation(current.seed, q, Boolean(exam.version.shuffle_options));
      const stored = JSON.stringify(toOriginal(q, perm, checked.value)) ?? 'null';
      const ack = answerRepo.save(
        current.id,
        questionId,
        order.indexOf(questionId),
        stored,
        revision,
        rawAssumption.trim() ? rawAssumption : null,
      );
      acks.push({ question_id: questionId, acknowledged: ack.acknowledged, revision: ack.revision, saved_at: ack.saved_at });
    }
    touch(current, ctx);
  });

  return { acks, attempt: liveMeta(attemptRepo.get(current.id) as Attempt) };
}

/** Sequential navigation: move from `fromIndex` to the next question (idempotent). */
export function advanceQuestion(
  userId: number,
  attemptId: number,
  fromIndex: number,
  ctx?: ClientContext,
): IntegralAttemptView {
  const attempt = ownAttempt(userId, attemptId);
  const exam = examContext(attempt);
  assertSession(attempt, ctx, exam.settings);
  if (attempt.status === 'in_progress' && exam.quiz.paused_at) {
    throw new AppError(423, 'The quiz is paused by your instructor.', 'quiz_paused');
  }
  const current = processTimers(attempt, exam);
  if (current.status !== 'in_progress') return buildAttemptView(current.id);
  if (exam.settings.navigation !== 'sequential') {
    throw new AppError(400, 'This quiz uses free navigation; there is nothing to advance.');
  }
  const order = jsonParse<number[]>(current.question_order, []);
  if (fromIndex !== current.current_index || current.current_index >= order.length - 1) {
    return buildAttemptView(current.id); // stale request, or already on the last question
  }
  const next = current.current_index + 1;
  const now = Date.now();
  let questionExpires: number | null = null;
  if (exam.settings.question_timer !== 'off') {
    questionExpires = now + limitFor(questionRepo.get(order[next] as number), exam.settings) * 1000;
    if (current.expires_at) questionExpires = Math.min(questionExpires, toMs(current.expires_at));
  }
  transaction(() => {
    attemptRepo.patch(current.id, {
      current_index: next,
      question_started_at: fromMs(now),
      question_expires_at: questionExpires === null ? null : fromMs(questionExpires),
    });
    touch(current, ctx);
  });
  return buildAttemptView(current.id);
}

// ---------------------------------------------------------------- submit

export function submitAttempt(userId: number, attemptId: number, ctx?: ClientContext): SubmitResult {
  const attempt = ownAttempt(userId, attemptId);
  if (attempt.status === 'submitted') {
    if (attempt.receipt) return finalizedSummary(attempt);
    throw new AppError(409, 'Attempt already submitted.');
  }
  if (attempt.status === 'locked' || attempt.status === 'under_review') {
    throw new AppError(409, 'This attempt is locked. Contact your instructor for review.', 'attempt_locked');
  }
  if (attempt.status === 'expired') {
    throw new AppError(409, 'This attempt was finalized because the deadline passed.', 'deadline_passed');
  }
  const exam = examContext(attempt);
  assertSession(attempt, ctx, exam.settings);

  // Deadline policy: a submission at or after the deadline (the browser
  // auto-submits when the timer hits zero) is recorded as time running out.
  // Saves that arrived within the grace period are already stored and graded.
  if (!exam.quiz.paused_at && attempt.expires_at && Date.now() >= toMs(attempt.expires_at)) {
    return finalize(attempt, 'expired', 'time_expired');
  }
  return finalize(attempt, 'submitted', 'submitted_by_student', nowUtc());
}

// ---------------------------------------------------------------- events + heartbeat

/**
 * Report a client-side focus/visibility/clipboard event. The policy engine
 * decides whether it is ignored, recorded, counted, or triggers the
 * configured lock / auto-submit.
 */
export function reportClientEvent(
  userId: number,
  attemptId: number,
  kind: string,
  detail: string | null,
  ctx?: ClientContext,
): EventOutcome {
  const attempt = ownAttempt(userId, attemptId);
  const exam = examContext(attempt);
  const current = processTimers(attempt, exam);
  if (current.status !== 'in_progress') {
    return {
      action: 'ignored',
      lock: false,
      violation: false,
      violation_count: current.violation_count,
      max_violations: exam.settings.max_violations,
      violation_action: exam.settings.violation_action,
      message: 'No active attempt session.',
    };
  }
  assertSession(current, ctx, exam.settings);
  return applyEvent(current, exam.settings, kind, detail, { paused: Boolean(exam.quiz.paused_at) });
}

/**
 * Presence ping. Keeps the session alive, syncs the clock, and carries
 * everything the instructor may have changed: extensions (new expires_at),
 * pause state, locks, forced submissions and announcements.
 */
export function heartbeat(
  userId: number,
  attemptId: number,
  body: { last_announcement_id?: unknown } = {},
  ctx?: ClientContext,
): HeartbeatResult {
  const attempt = ownAttempt(userId, attemptId);
  const exam = examContext(attempt);
  const current = processTimers(attempt, exam);
  if (current.status === 'in_progress') {
    assertSession(current, ctx, exam.settings);
    if (ctx) {
      const gap = current.last_seen_at ? Date.now() - toMs(current.last_seen_at) : 0;
      transaction(() => {
        touch(current, ctx);
        if (gap > SESSION_STALE_MS) {
          policyRepo.log(
            current.id,
            'reconnected',
            `Back in contact after about ${Math.round(gap / 1000)} s without a heartbeat.`,
            'server',
          );
        }
      });
    }
  }
  const afterId = Number(body?.last_announcement_id);
  return {
    server_now: nowUtc(),
    status: current.status,
    expires_at: current.expires_at,
    question_expires_at: current.question_expires_at,
    current_index: current.current_index,
    paused: Boolean(exam.quiz.paused_at),
    closed: Boolean(exam.quiz.closed_at),
    violation_count: current.violation_count,
    max_violations: exam.settings.max_violations,
    lock_reason: current.lock_reason,
    finalize_reason: current.finalize_reason,
    announcements: announcementsFor(current, exam.quiz.id, Number.isFinite(afterId) ? afterId : 0),
    hands: handRepo.forAttempt(current.id).map(toHandView),
    heartbeat_ms: HEARTBEAT_MS,
  };
}

// ---------------------------------------------------------------- raise hand

const MAX_OPEN_HANDS = 2;
const MAX_HANDS_PER_ATTEMPT = 10;
const MAX_HAND_MESSAGE = 500;

/**
 * A private question to the invigilators during the exam (e.g. "Q3 seems to
 * have a typo"). The reply arrives as a personal message, or as a
 * clarification for everyone if the instructor chooses to broadcast it.
 */
export function raiseHand(
  userId: number,
  attemptId: number,
  body: { message?: unknown; question_id?: unknown },
  ctx?: ClientContext,
): HandView {
  const attempt = ownAttempt(userId, attemptId);
  const exam = examContext(attempt);
  const current = processTimers(attempt, exam);
  if (current.status !== 'in_progress') {
    throw new AppError(409, `Attempt is already ${current.status}.`, 'attempt_not_active', { status: current.status });
  }
  assertSession(current, ctx, exam.settings);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new AppError(400, 'Write your question for the invigilator.');
  if (message.length > MAX_HAND_MESSAGE) {
    throw new AppError(400, `Keep it under ${MAX_HAND_MESSAGE} characters.`);
  }
  let questionId: number | null = null;
  if (body.question_id !== undefined && body.question_id !== null && body.question_id !== '') {
    questionId = Number(body.question_id);
    if (!jsonParse<number[]>(current.question_order, []).includes(questionId)) {
      throw new AppError(400, 'That question is not on your paper.');
    }
  }
  const counts = handRepo.counts(current.id);
  if (counts.open >= MAX_OPEN_HANDS) {
    throw new AppError(429, 'Please wait for a reply to your earlier question first.', 'hand_limit');
  }
  if (counts.total >= MAX_HANDS_PER_ATTEMPT) {
    throw new AppError(429, 'You have reached the limit of questions for this exam.', 'hand_limit');
  }
  const id = transaction(() => {
    const handId = handRepo.add(exam.quiz.id, current.id, userId, questionId, message);
    policyRepo.log(current.id, 'hand_raised', message.slice(0, 200), 'server');
    return handId;
  });
  return toHandView(handRepo.get(id) as HandRaise);
}

// ---------------------------------------------------------------- background sweep

/**
 * Finalize attempts whose timers ran out while nobody was looking (closed
 * laptop, dead battery). Returns how many due attempts were examined.
 */
export function sweepDueAttempts(limit = 200): number {
  const cutoff = fromMs(Date.now() - GRACE_MS);
  const rows = db
    .prepare(
      `SELECT a.id FROM attempts a
       JOIN quiz_versions qv ON qv.id = a.quiz_version_id
       JOIN quizzes q ON q.id = qv.quiz_id
       WHERE a.status = 'in_progress' AND q.paused_at IS NULL
         AND ((a.expires_at IS NOT NULL AND a.expires_at < ?)
           OR (a.question_expires_at IS NOT NULL AND a.question_expires_at < ?))
       LIMIT ?`,
    )
    .all(cutoff, cutoff, limit) as { id: number }[];
  for (const row of rows) {
    const attempt = attemptRepo.get(Number(row.id));
    if (!attempt) continue;
    try {
      processTimers(attempt);
    } catch (e) {
      console.error('[interval-api][sweep] failed to process attempt', row.id, e);
    }
  }
  return rows.length;
}

let sweeper: NodeJS.Timeout | null = null;

export function startSweeper(intervalMs = 5_000): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    try {
      // Bounded so one tick can never monopolise the event loop.
      for (let batch = 0; batch < 5 && sweepDueAttempts(200) === 200; batch++);
    } catch (e) {
      console.error('[interval-api][sweep]', e);
    }
  }, intervalMs);
  sweeper.unref();
}

export function stopSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
