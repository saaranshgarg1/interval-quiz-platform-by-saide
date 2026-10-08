import { AppError } from '../auth.js';
import type { IntegrityPolicy, PolicyTrigger, QuizVersion } from '../types.js';
import { isValidNetwork, jsonParse } from '../util.js';

/**
 * Exam settings — every instructor-configurable rule for running a quiz as a
 * strict exam. Stored as JSON on `quiz_versions.exam_settings`, so they version
 * (and freeze on publish) together with the questions.
 *
 * Browser-detectable behaviour (tab/window switches, leaving full screen) can
 * only be *detected*, so it counts as a violation. Clipboard and context-menu
 * use can be *blocked*, so blocked attempts are logged for the instructor but
 * never counted against the student.
 */

export type Navigation = 'free' | 'sequential';
export type QuestionTimer = 'off' | 'uniform' | 'per_question';
export type ViolationAction = 'none' | 'lock' | 'submit';
export type ReentryAction = 'lock' | 'submit';
export type SettingsPreset = 'practice' | 'standard' | 'strict';

export interface ExamSettings {
  /** free = jump between questions; sequential = forward only, no going back. */
  navigation: Navigation;
  /** Per-question countdown. Any timer forces sequential navigation. */
  question_timer: QuestionTimer;
  /** Limit used by 'uniform', and the fallback for questions without their own limit. */
  question_time_seconds: number;

  allow_tab_switch: boolean;
  allow_window_switch: boolean;
  allow_copy_paste: boolean;
  allow_right_click: boolean;
  require_fullscreen: boolean;
  /**
   * Chrome/Edge Keyboard Lock while in full screen: the Windows key, Alt+Tab and
   * Esc reach the quiz instead of the OS/browser (leaving full screen then needs
   * Esc held down). Implies require_fullscreen.
   */
  lock_keyboard: boolean;

  /** Exit & continue: may the student close the quiz and resume later (or on another device)? */
  allow_resume: boolean;
  /** When resume is not allowed and the student re-enters: lock for review, or submit. */
  reentry_action: ReentryAction;

  /** What happens when violations reach `max_violations`. 'none' = record and warn only. */
  violation_action: ViolationAction;
  max_violations: number;

  /** Overlay the student's name + entry number on the question surface. */
  watermark: boolean;

  /** Quiz password announced in the exam hall; '' = none. Never sent to students. */
  access_code: string;
  /** IP / CIDR allow-list (exam-hall network); [] = any network. */
  allowed_networks: string[];
  /** Scheduled quizzes: no new starts this many minutes after the window opens. */
  late_entry_minutes: number | null;
  /** Draw this many questions at random per student; null = all questions. */
  questions_per_attempt: number | null;
}

/** Settings a student's browser needs to enforce the rules — no secrets. */
export type PublicExamSettings = Omit<ExamSettings, 'access_code' | 'allowed_networks'> & {
  requires_access_code: boolean;
  network_restricted: boolean;
};

const PRACTICE: ExamSettings = {
  navigation: 'free',
  question_timer: 'off',
  question_time_seconds: 60,
  allow_tab_switch: true,
  allow_window_switch: true,
  allow_copy_paste: true,
  allow_right_click: true,
  require_fullscreen: false,
  lock_keyboard: false,
  allow_resume: true,
  reentry_action: 'lock',
  violation_action: 'none',
  max_violations: 3,
  watermark: false,
  access_code: '',
  allowed_networks: [],
  late_entry_minutes: null,
  questions_per_attempt: null,
};

/** Proctoring-only keys a preset sets; timing/access settings are left alone. */
const PROCTORING_KEYS = [
  'allow_tab_switch',
  'allow_window_switch',
  'allow_copy_paste',
  'allow_right_click',
  'require_fullscreen',
  'lock_keyboard',
  'allow_resume',
  'reentry_action',
  'violation_action',
  'max_violations',
  'watermark',
] as const;

type ProctoringSettings = Pick<ExamSettings, (typeof PROCTORING_KEYS)[number]>;

export const PRESETS: Record<SettingsPreset, ProctoringSettings> = {
  // Low stakes: nothing monitored.
  practice: pick(PRACTICE),
  // Monitored: switches are recorded and the student is warned, nothing automatic.
  standard: {
    allow_tab_switch: false,
    allow_window_switch: false,
    allow_copy_paste: false,
    allow_right_click: false,
    require_fullscreen: false,
    lock_keyboard: false,
    allow_resume: true,
    reentry_action: 'lock',
    violation_action: 'none',
    max_violations: 3,
    watermark: true,
  },
  // Exam conditions: full screen, no re-entry, lock after three violations.
  strict: {
    allow_tab_switch: false,
    allow_window_switch: false,
    allow_copy_paste: false,
    allow_right_click: false,
    require_fullscreen: true,
    lock_keyboard: true,
    allow_resume: false,
    reentry_action: 'lock',
    violation_action: 'lock',
    max_violations: 3,
    watermark: true,
  },
};

function pick(s: ExamSettings): ProctoringSettings {
  const out = {} as Record<string, unknown>;
  for (const k of PROCTORING_KEYS) out[k] = s[k];
  return out as ProctoringSettings;
}

export function defaultSettings(): ExamSettings {
  return { ...PRACTICE, allowed_networks: [] };
}

/** Map the original off/warn/strict policy onto explicit settings (back-compat). */
export function settingsFromLegacy(policy: IntegrityPolicy, trigger: PolicyTrigger): ExamSettings {
  const base = defaultSettings();
  if (policy === 'warn') {
    return { ...base, allow_tab_switch: false, allow_window_switch: false, violation_action: 'none' };
  }
  if (policy === 'strict') {
    return {
      ...base,
      allow_tab_switch: false,
      // A page_hidden trigger only locks on tab changes; focus moves are merely recorded.
      allow_window_switch: trigger === 'page_hidden',
      violation_action: 'lock',
      max_violations: 1,
    };
  }
  return base;
}

/** The legacy coarse label kept in sync for display and old clients. */
export function legacyPolicyOf(s: ExamSettings): { integrity_policy: IntegrityPolicy; policy_trigger: PolicyTrigger } {
  const monitored = isMonitored(s);
  const integrity_policy: IntegrityPolicy = !monitored
    ? 'off'
    : s.violation_action !== 'none' || !s.allow_resume
      ? 'strict'
      : 'warn';
  return { integrity_policy, policy_trigger: s.allow_window_switch ? 'page_hidden' : 'focus_exit' };
}

/** Does any rule require the browser to watch the student? */
export function isMonitored(s: ExamSettings): boolean {
  return (
    !s.allow_tab_switch ||
    !s.allow_window_switch ||
    !s.allow_copy_paste ||
    !s.allow_right_click ||
    s.require_fullscreen ||
    !s.allow_resume
  );
}

export function presetOf(s: ExamSettings): SettingsPreset | 'custom' {
  for (const [name, preset] of Object.entries(PRESETS) as [SettingsPreset, ProctoringSettings][]) {
    if (PROCTORING_KEYS.every((k) => preset[k] === s[k])) return name;
  }
  return 'custom';
}

/** Effective settings for a version: legacy-derived defaults overlaid by explicit settings. */
export function resolveSettings(
  version: Pick<QuizVersion, 'exam_settings' | 'integrity_policy' | 'policy_trigger'>,
): ExamSettings {
  const base = settingsFromLegacy(version.integrity_policy, version.policy_trigger);
  const stored = jsonParse<Record<string, unknown>>(version.exam_settings ?? '{}', {});
  if (!stored || typeof stored !== 'object' || Object.keys(stored).length === 0) return base;
  try {
    return normalizeSettings(stored, base);
  } catch {
    // A stored blob that no longer validates must never take an exam offline.
    return base;
  }
}

function bool(v: unknown, field: string): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return Boolean(v);
  throw new AppError(400, `${field} must be true or false.`);
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new AppError(400, `${field} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new AppError(400, `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

/**
 * Validate a (partial) settings object on top of `base`. Unknown keys are
 * ignored; every known key is type- and range-checked. Throws AppError(400).
 */
export function normalizeSettings(input: unknown, base: ExamSettings = defaultSettings()): ExamSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'exam_settings must be an object.');
  }
  const src = input as Record<string, unknown>;
  const out: ExamSettings = { ...base, allowed_networks: [...base.allowed_networks] };
  const has = (k: keyof ExamSettings) => src[k] !== undefined;

  if (has('navigation')) out.navigation = oneOf(src.navigation, 'navigation', ['free', 'sequential'] as const);
  if (has('question_timer')) {
    out.question_timer = oneOf(src.question_timer, 'question_timer', ['off', 'uniform', 'per_question'] as const);
  }
  if (has('question_time_seconds')) {
    out.question_time_seconds = int(src.question_time_seconds, 'question_time_seconds', 5, 7200);
  }
  for (const k of [
    'allow_tab_switch',
    'allow_window_switch',
    'allow_copy_paste',
    'allow_right_click',
    'require_fullscreen',
    'lock_keyboard',
    'allow_resume',
    'watermark',
  ] as const) {
    if (has(k)) out[k] = bool(src[k], k);
  }
  if (has('reentry_action')) out.reentry_action = oneOf(src.reentry_action, 'reentry_action', ['lock', 'submit'] as const);
  if (has('violation_action')) {
    out.violation_action = oneOf(src.violation_action, 'violation_action', ['none', 'lock', 'submit'] as const);
  }
  if (has('max_violations')) out.max_violations = int(src.max_violations, 'max_violations', 1, 100);

  if (has('access_code')) {
    if (typeof src.access_code !== 'string') throw new AppError(400, 'access_code must be text.');
    const code = src.access_code.trim();
    if (code.length > 64) throw new AppError(400, 'access_code must be at most 64 characters.');
    out.access_code = code;
  }
  if (has('allowed_networks')) {
    const rawList = Array.isArray(src.allowed_networks)
      ? src.allowed_networks
      : typeof src.allowed_networks === 'string'
        ? src.allowed_networks.split(/[\s,;]+/)
        : null;
    if (!rawList) throw new AppError(400, 'allowed_networks must be a list of IPs or CIDR ranges.');
    const list = rawList.map((e) => String(e).trim()).filter(Boolean);
    if (list.length > 100) throw new AppError(400, 'At most 100 allowed networks.');
    const bad = list.filter((e) => !isValidNetwork(e));
    if (bad.length) throw new AppError(400, `Not a valid IP or CIDR range: ${bad.join(', ')}`);
    out.allowed_networks = [...new Set(list)];
  }
  if (has('late_entry_minutes')) {
    out.late_entry_minutes =
      src.late_entry_minutes === null || src.late_entry_minutes === ''
        ? null
        : int(src.late_entry_minutes, 'late_entry_minutes', 0, 1440);
  }
  if (has('questions_per_attempt')) {
    out.questions_per_attempt =
      src.questions_per_attempt === null || src.questions_per_attempt === ''
        ? null
        : int(src.questions_per_attempt, 'questions_per_attempt', 1, 1000);
  }

  // A question timer only makes sense when students cannot go back.
  if (out.question_timer !== 'off') out.navigation = 'sequential';
  // Keyboard Lock only works in full screen.
  if (out.lock_keyboard) out.require_fullscreen = true;
  return out;
}

/** Apply a named preset's proctoring rules, keeping timing and access settings. */
export function applyPreset(base: ExamSettings, preset: SettingsPreset): ExamSettings {
  return { ...base, ...PRESETS[preset] };
}

export function isPreset(value: unknown): value is SettingsPreset {
  return typeof value === 'string' && Object.hasOwn(PRESETS, value);
}

/** Old clients set only off/warn/strict: overlay that policy's rules, keep timing and access. */
export function withLegacyPolicy(base: ExamSettings, policy: IntegrityPolicy, trigger: PolicyTrigger): ExamSettings {
  return { ...base, ...pick(settingsFromLegacy(policy, trigger)) };
}

export function publicSettings(s: ExamSettings): PublicExamSettings {
  const { access_code, allowed_networks, ...rest } = s;
  return { ...rest, requires_access_code: access_code !== '', network_restricted: allowed_networks.length > 0 };
}

// ---------------------------------------------------------------- violations

/** Client event kinds the server understands. Old clients sent focus_exit/page_hidden. */
const KIND_ALIASES: Record<string, string> = {
  focus_exit: 'window_blur',
  page_hidden: 'tab_hidden',
};

export const KNOWN_EVENT_KINDS = new Set([
  'tab_hidden',
  'window_blur',
  'fullscreen_exit',
  'copy_attempt',
  'cut_attempt',
  'paste_attempt',
  'drop_attempt',
  'context_menu',
  'print_attempt',
  'devtools_attempt',
  'multiple_screens',
  'system_key_attempt',
  'focus_return',
  'network_offline',
  'network_online',
  'page_exit',
]);

export function normalizeEventKind(kind: string): string {
  const k = kind.trim().toLowerCase();
  const aliased = KIND_ALIASES[k] ?? k;
  return KNOWN_EVENT_KINDS.has(aliased) ? aliased : 'other';
}

/** Does this event count toward the violation limit under these settings? */
export function isViolation(kind: string, s: ExamSettings): boolean {
  switch (kind) {
    case 'tab_hidden':
      return !s.allow_tab_switch;
    case 'window_blur':
      return !s.allow_window_switch;
    case 'fullscreen_exit':
      return s.require_fullscreen;
    default:
      return false;
  }
}

export const EVENT_LABELS: Record<string, string> = {
  tab_hidden: 'left the quiz tab',
  window_blur: 'switched to another window or app',
  fullscreen_exit: 'left full-screen mode',
  copy_attempt: 'tried to copy',
  cut_attempt: 'tried to cut',
  paste_attempt: 'tried to paste',
  drop_attempt: 'tried to drag content in',
  context_menu: 'opened the right-click menu',
  print_attempt: 'tried to print',
  devtools_attempt: 'tried to open developer tools',
  multiple_screens: 'has more than one screen connected',
  system_key_attempt: 'pressed a blocked system key (Windows key, Alt+Tab or Esc)',
};

// ---------------------------------------------------------------- disclosure

/**
 * Plain-language rules shown to students before they start (G3: the rules are
 * disclosed up front, in the same words the instructor saw while authoring).
 */
export function studentRules(
  s: ExamSettings,
  meta: { duration_minutes: number | null; question_count: number; quiz_type?: string },
): string[] {
  const rules: string[] = [];
  const n = s.questions_per_attempt && s.questions_per_attempt < meta.question_count
    ? s.questions_per_attempt
    : meta.question_count;
  rules.push(
    s.questions_per_attempt && s.questions_per_attempt < meta.question_count
      ? `You will get ${n} questions drawn at random from a pool of ${meta.question_count}.`
      : `There ${n === 1 ? 'is 1 question' : `are ${n} questions`}.`,
  );
  if (meta.duration_minutes) {
    rules.push(`You have ${meta.duration_minutes} minutes. The timer runs on the server and does not stop if you close the page.`);
  }
  if (s.question_timer === 'uniform') {
    rules.push(`Each question has its own ${formatSeconds(s.question_time_seconds)} timer. When it runs out you move on automatically.`);
  } else if (s.question_timer === 'per_question') {
    rules.push('Each question has its own timer, shown on the question. When it runs out you move on automatically.');
  }
  if (s.navigation === 'sequential') {
    rules.push('Questions are shown one at a time. You cannot go back to a previous question.');
  } else {
    rules.push('You can move between questions and change answers until you submit.');
  }
  if (s.require_fullscreen) {
    rules.push('The quiz opens in full screen when you start. Leaving full screen counts as a violation.');
  }
  if (s.lock_keyboard) {
    rules.push(
      'The Windows key, Alt+Tab and Esc are disabled during the quiz. Use an up-to-date Chrome or Edge on a laptop or desktop.',
    );
  }
  if (!s.allow_tab_switch && !s.allow_window_switch) {
    rules.push('Do not switch tabs, windows or apps. Each switch counts as a violation.');
  } else if (!s.allow_tab_switch) {
    rules.push('Do not switch browser tabs. Each tab switch counts as a violation.');
  } else if (!s.allow_window_switch) {
    rules.push('Do not switch to other windows or apps. Each switch counts as a violation.');
  }
  if (!s.allow_copy_paste) rules.push('Copy, cut and paste are disabled. Attempts are logged for your instructor.');
  if (!s.allow_right_click) rules.push('The right-click menu is disabled.');
  if (isMonitored(s) && (!s.allow_tab_switch || !s.allow_window_switch || s.require_fullscreen)) {
    if (s.violation_action === 'lock') {
      rules.push(
        `After ${plural(s.max_violations, 'violation')} your attempt is locked until your instructor reviews it. Your saved answers are kept.`,
      );
    } else if (s.violation_action === 'submit') {
      rules.push(`After ${plural(s.max_violations, 'violation')} your attempt is submitted automatically with your saved answers.`);
    } else {
      rules.push('Violations are recorded and shown to your instructor. You will see a warning each time.');
    }
  }
  if (s.allow_resume) {
    rules.push('If you get disconnected or close the page, you can continue where you left off while time remains.');
  } else {
    rules.push(
      s.reentry_action === 'submit'
        ? 'Exit & resume is not allowed: if you close the quiz and come back, your attempt is submitted automatically. Reloading the page is fine.'
        : 'Exit & resume is not allowed: if you close the quiz and come back, your attempt is locked until your instructor reviews it. Reloading the page is fine.',
    );
  }
  if (s.watermark) rules.push('Your name and entry number are shown as a watermark on the questions.');
  if (s.access_code) rules.push('You need the access code announced by your instructor to start.');
  if (s.allowed_networks.length) rules.push('This quiz can only be started from the exam-hall network.');
  if (s.late_entry_minutes !== null && meta.quiz_type === 'scheduled') {
    rules.push(`Entry closes ${plural(s.late_entry_minutes, 'minute')} after the quiz opens.`);
  }
  return rules;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatSeconds(total: number): string {
  if (total < 60) return plural(total, 'second');
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? plural(m, 'minute') : `${m} min ${s} s`;
}
