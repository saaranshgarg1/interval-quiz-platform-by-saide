export type Role = 'student' | 'instructor' | 'admin';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  entry_number?: string | null;
}

export interface Course {
  id: number;
  code: string;
  name: string;
  my_role?: string;
  created_at: string;
}

export interface MyCoursesResponse {
  courses: Course[];
}

export interface RosterMember {
  id: number;
  name: string;
  email: string;
  role: string;
  entry_number?: string | null;
}

export interface PendingEnrollment {
  id: number;
  course_id: number;
  email: string;
  role: string;
  entry_number: string | null;
  name: string | null;
  created_at: string;
}

export interface RosterResponse {
  roster: RosterMember[];
}

/** 'descriptive' = a written answer the instructor marks by hand. */
export type QuestionType = 'single' | 'multiple' | 'short' | 'numeric' | 'descriptive';
export type GradingMode = 'normal' | 'full_marks' | 'dropped';
export type IntegrityPolicy = 'off' | 'warn' | 'strict';
export type ShowScores = 'never' | 'release' | 'immediate';
export type QuizType = 'anytime' | 'scheduled';

// ---------------------------------------------------------------- exam settings

export type Navigation = 'free' | 'sequential';
export type QuestionTimer = 'off' | 'uniform' | 'per_question';
export type ViolationAction = 'none' | 'lock' | 'submit';
export type ReentryAction = 'lock' | 'submit';
export type SettingsPreset = 'practice' | 'standard' | 'strict';

/** Every instructor-configurable exam rule (mirrors api/services/exam-settings.ts). */
export interface ExamSettings {
  navigation: Navigation;
  question_timer: QuestionTimer;
  question_time_seconds: number;
  allow_tab_switch: boolean;
  allow_window_switch: boolean;
  allow_copy_paste: boolean;
  allow_right_click: boolean;
  require_fullscreen: boolean;
  /** Chrome/Edge: Windows key, Alt+Tab and Esc go to the quiz while in full screen. */
  lock_keyboard: boolean;
  allow_resume: boolean;
  reentry_action: ReentryAction;
  violation_action: ViolationAction;
  max_violations: number;
  watermark: boolean;
  access_code: string;
  allowed_networks: string[];
  late_entry_minutes: number | null;
  questions_per_attempt: number | null;
}

/** What a student's browser receives: no access code or network list. */
export type PublicExamSettings = Omit<ExamSettings, 'access_code' | 'allowed_networks'> & {
  requires_access_code: boolean;
  network_restricted: boolean;
};

export interface QuestionEditor {
  id: number;
  qtype: QuestionType;
  text: string;
  options: string[];
  points: number;
  order_index: number;
  answer: unknown;
  tolerance: number | null;
  time_limit_seconds: number | null;
  allow_assumptions?: boolean;
  grading_mode?: GradingMode;
  accept_also?: unknown[];
}

export interface MyAttemptSummary {
  count: number;
  in_progress: number | null;
  locked: number | null;
  best_score: number | null;
  last_status: string | null;
  last_attempt_id: number | null;
  last_receipt: string | null;
}

export interface VersionDetail {
  id: number;
  quiz_id: number;
  version: number;
  status: 'draft' | 'published' | 'archived';
  title: string;
  instructions: string;
  duration_minutes: number | null;
  shuffle_questions: number;
  shuffle_options: number;
  attempts_allowed: number;
  integrity_policy: IntegrityPolicy;
  policy_trigger: string;
  show_scores: ShowScores;
  quiz_type: QuizType;
  window_opens_at: string | null;
  window_duration_minutes: number | null;
  window_closes_at: string | null;
  published_at: string | null;
  created_at: string;
  question_count: number;
  total_points: number;
  /** Full settings for staff; the student-safe subset for students. */
  exam_settings: ExamSettings | PublicExamSettings;
  preset: SettingsPreset | 'custom';
  rules: string[];
  paused: boolean;
  closed: boolean;
  /** Staff only: students never receive question content outside an attempt. */
  questions: QuestionEditor[];
  /** Staff only: random questions drawn per student from a bank. */
  slots: QuestionSlot[];
  my_attempts?: MyAttemptSummary;
  attempts?: {
    total: number;
    statuses: Record<string, number>;
    avg_score: number | null;
    best: number | null;
  };
}

export interface QuizList {
  quiz_id: number;
  published: VersionDetail | null;
  draft: VersionDetail | null;
}

export interface CourseQuizzesResponse {
  quizzes: QuizList[];
}

export interface QuizDetailResponse {
  quiz_id: number;
  course_id: number;
  paused_at?: string | null;
  closed_at?: string | null;
  versions: VersionDetail[];
}

export interface AttemptQuestion {
  id: number;
  qtype: QuestionType;
  text: string;
  /** In this student's display order. */
  options: string[];
  points: number;
  order_index: number;
  /** 0-based position within this attempt. */
  position: number;
  time_limit_seconds: number | null;
  allow_assumptions: boolean;
}

export interface AttemptAnswer {
  question_id: number;
  answer: unknown;
  revision: number;
  status: 'pending' | 'saved' | 'submitted';
  saved_at: string | null;
  assumption: string | null;
}

export interface AttemptMeta {
  id: number;
  quiz_version_id: number;
  status: string;
  started_at: string;
  expires_at: string | null;
  submitted_at: string | null;
  score: number | null;
  max_score: number | null;
  receipt: string | null;
  submitted_revision: number;
  last_save_at: string | null;
  server_now: string;
  total_questions: number;
  current_index: number;
  question_expires_at: string | null;
  violation_count: number;
  resume_count: number;
  extra_seconds: number;
  lock_reason: string | null;
  finalize_reason: string | null;
}

export interface Announcement {
  id: number;
  message: string;
  created_at: string;
  personal: boolean;
  /** Clarification pinned to this question. */
  question_id: number | null;
}

/** A question the student asked the invigilators during the exam. */
export interface Hand {
  id: number;
  question_id: number | null;
  message: string;
  status: 'open' | 'answered' | 'dismissed';
  reply: string | null;
  broadcast: boolean;
  created_at: string;
  answered_at: string | null;
}

export interface AttemptView {
  attempt: AttemptMeta;
  quiz: {
    id: number;
    quiz_id: number;
    title: string;
    instructions: string;
    integrity_policy: IntegrityPolicy;
    policy_trigger: string;
    show_scores: ShowScores;
    settings: PublicExamSettings;
    rules: string[];
    paused: boolean;
  };
  student: { name: string; email: string; entry_number: string | null };
  questions: AttemptQuestion[];
  answers: Record<number, AttemptAnswer>;
  events: { id: number; kind: string; detail: string | null; recorded_at: string }[];
  announcements: Announcement[];
  hands: Hand[];
  heartbeat_ms: number;
}

/** Start / claim responses carry the per-window session token. */
export type AttemptSessionResponse = AttemptView & { session_token: string | null };

export interface HeartbeatResult {
  server_now: string;
  status: string;
  expires_at: string | null;
  question_expires_at: string | null;
  current_index: number;
  paused: boolean;
  closed: boolean;
  violation_count: number;
  max_violations: number;
  lock_reason: string | null;
  finalize_reason: string | null;
  announcements: Announcement[];
  hands: Hand[];
  heartbeat_ms: number;
}

export interface EventOutcome {
  action: 'ignored' | 'recorded' | 'locked' | 'submitted';
  lock: boolean;
  violation: boolean;
  violation_count: number;
  max_violations: number;
  violation_action: ViolationAction;
  message?: string;
}

export interface SaveAck {
  question_id: number;
  acknowledged: boolean;
  revision: number;
  saved_at: string;
}

export interface SubmitResult {
  attempt_id: number;
  status: string;
  receipt: string | null;
  release_token: string | null;
  score: number | null;
  max_score: number | null;
  graded_at: string | null;
  acknowledged_answers: number;
  pending_manual?: number;
  finalize_reason: string | null;
  policy: { recorded: number };
}

export interface ResultRow {
  id: number;
  attempt_id: number;
  quiz_version_id: number;
  quiz_title: string;
  course_code: string;
  course_name: string;
  version: number;
  score: number;
  max_score: number;
  released: number;
  answer_key_released: number;
  released_at: string | null;
  submitted_at: string | null;
}

export interface ResultDetail extends ResultRow {
  pending_manual?: number;
  per_question: {
    question_id: number;
    text: string;
    qtype: QuestionType;
    options: string[];
    your_answer: unknown;
    answered: boolean;
    assumption?: string | null;
    correct_answer: unknown;
    accept_also?: unknown[];
    earned: number;
    points: number;
    source?: 'auto' | 'manual' | 'full_marks' | 'dropped' | 'pending' | 'unanswered';
    pending?: boolean;
    bonus?: number;
    grading_mode?: GradingMode;
    feedback?: string | null;
  }[];
}

export interface Incident {
  attempt_id: number;
  quiz_version_id: number;
  quiz_id: number;
  quiz_title: string;
  status: string;
  started_at: string;
  expires_at: string | null;
  user_id: number;
  user_name: string;
  user_email: string;
  entry_number: string | null;
  violation_count: number;
  lock_reason: string | null;
  finalize_reason: string | null;
}

export interface Audit {
  attempt: {
    id: number;
    status: string;
    started_at: string;
    expires_at: string | null;
    submitted_at: string | null;
    score: number | null;
    max_score: number | null;
    receipt: string | null;
    quiz_version_id: number;
    quiz_id: number;
    quiz_title: string;
    version: number;
    violation_count: number;
    resume_count: number;
    lock_reason: string | null;
    finalize_reason: string | null;
    start_ip: string | null;
    last_ip: string | null;
    user_agent: string | null;
    extra_seconds: number;
    last_seen_at: string | null;
  };
  student: User | null;
  answers: { question_id: number; position: number; answer: unknown; revision: number; saved_at: string; status: string; assumption?: string | null }[];
  history: { question_id: number; answer: unknown; revision: number; saved_at: string; assumption?: string | null }[];
  flags?: ManualFlag[];
  hands?: (Hand & { attempt_id: number })[];
  appeals?: Appeal[];
  /** question id → paper label ("Q3", "Q5·B") */
  labels?: Record<string, string>;
  events: { id: number; attempt_id: number; kind: string; detail: string | null; recorded_at: string; source: string }[];
  decisions: { id: number; attempt_id: number; decided_by: number; decision: string; reason: string | null; created_at: string; decided_by_name: string; decided_by_email: string }[];
}

export interface QuestionBank {
  id: number;
  course_id: number;
  name: string;
  description: string;
  created_by: number;
  created_at: string;
  question_count?: number;
}

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface BankQuestion {
  id: number;
  bank_id: number;
  qtype: QuestionType;
  text: string;
  options: string[];
  answer: unknown;
  tolerance: number | null;
  points: number;
  tags: string[];
  difficulty: Difficulty;
  allow_assumptions?: number;
  created_at: string;
}

/** A quiz item that draws a different bank question for each student. */
export interface QuestionSlot {
  id: number;
  quiz_version_id: number;
  bank_id: number;
  bank_name: string;
  difficulty: Difficulty | null;
  tag: string | null;
  points: number;
  time_limit_seconds: number | null;
  order_index: number;
  /** How many bank questions match the slot's filter right now. */
  pool_size: number;
}

export interface StudentAccommodation {
  id: number;
  course_id: number;
  user_id: number;
  user_name?: string;
  user_email?: string;
  time_multiplier: number;
  extra_minutes: number;
  notes: string;
  created_at: string;
}

export interface QuestionAnalyticsItem {
  question_id: number;
  order_index: number;
  text: string;
  qtype: QuestionType;
  points: number;
  total_answers: number;
  correct_answers: number;
  accuracy_rate: number;
  discrimination_index: number;
}

export interface ScoreBucket {
  range: string;
  count: number;
}

export interface SubmissionItem {
  attempt_id: number;
  user_id: number;
  user_name: string;
  user_email: string;
  entry_number: string | null;
  violation_count: number;
  finalize_reason: string | null;
  status: string;
  score: number | null;
  max_score: number | null;
  started_at: string;
  submitted_at: string | null;
  receipt: string | null;
}

export interface QuizAnalytics {
  quiz_id: number;
  quiz_version_id: number;
  title: string;
  total_attempts: number;
  submitted_count: number;
  locked_count: number;
  expired_count: number;
  mean_score: number;
  median_score: number;
  max_score: number;
  highest_score: number;
  lowest_score: number;
  score_buckets: ScoreBucket[];
  question_analytics: QuestionAnalyticsItem[];
  submissions: SubmissionItem[];
}
// ---------------------------------------------------------------- live monitor

export interface MonitorAttempt {
  id: number;
  quiz_version_id: number;
  status: string;
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
}

export interface MonitorRow {
  user_id: number;
  name: string;
  email: string;
  entry_number: string | null;
  attempt_count: number;
  attempt: MonitorAttempt | null;
}

export interface TimeExtension {
  id: number;
  user_id: number | null;
  seconds: number;
  applies_to_new: number;
  kind: 'extension' | 'pause';
  reason: string | null;
  created_at: string;
  user_name?: string | null;
  user_entry_number?: string | null;
  created_by_name?: string | null;
}

export interface MonitorAnnouncement {
  id: number;
  user_id: number | null;
  message: string;
  created_at: string;
  created_by_name?: string | null;
  user_name?: string | null;
}

export interface MonitorSnapshot {
  server_now: string;
  quiz: {
    quiz_id: number;
    course_id: number;
    version_id: number;
    version: number;
    title: string;
    quiz_type: QuizType;
    duration_minutes: number | null;
    window_opens_at: string | null;
    window_closes_at: string | null;
    attempts_allowed: number;
    question_count: number;
    paused_at: string | null;
    closed_at: string | null;
    extra_seconds_all: number;
    preset: SettingsPreset | 'custom';
    settings: ExamSettings & { requires_access_code: boolean; network_restricted: boolean };
    rules: string[];
  };
  summary: {
    enrolled: number;
    not_started: number;
    in_progress: number;
    online: number;
    submitted: number;
    expired: number;
    locked: number;
    flagged: number;
  };
  students: MonitorRow[];
  extensions: TimeExtension[];
  announcements: MonitorAnnouncement[];
  labels: { finalize: Record<string, string>; lock: Record<string, string> };
  /** The viewer's course role: TAs monitor and announce; instructors also control time and rulings. */
  viewer_role: 'ta' | 'instructor';
}

export interface MonitorEvent {
  id: number;
  attempt_id: number;
  kind: string;
  detail: string | null;
  recorded_at: string;
  source: string;
  user_id: number;
  user_name: string;
  entry_number: string | null;
}

// ---------------------------------------------------------------- flags + live overview

export type FlagLevel = 'none' | 'low' | 'medium' | 'high';
export type FlagSeverity = 'low' | 'medium' | 'high';

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

export interface FlaggedCandidate {
  attempt_id: number;
  user_id: number;
  name: string;
  email: string;
  entry_number: string | null;
  status: string;
  violation_count: number;
  lock_reason: string | null;
  finalize_reason: string | null;
  start_ip: string | null;
  last_ip: string | null;
  score: number | null;
  max_score: number | null;
  flag_score: number;
  level: FlagLevel;
  signals: Record<string, number>;
  manual_flags: ManualFlag[];
}

export interface FlagReport {
  candidates: FlaggedCandidate[];
  signal_labels: Record<string, string>;
}

export interface LiveExam {
  quiz_id: number;
  course_id: number;
  course_code: string;
  course_name: string;
  version_id: number;
  title: string;
  quiz_type: QuizType;
  window_opens_at: string | null;
  window_closes_at: string | null;
  duration_minutes: number | null;
  paused: boolean;
  state: 'live' | 'paused' | 'upcoming';
  enrolled: number;
  in_progress: number;
  online: number;
  locked: number;
  finished: number;
  flagged: number;
}

// ---------------------------------------------------------------- accessibility

export interface AccessibilityPrefs {
  text_size: 'normal' | 'large' | 'x-large';
  contrast: 'normal' | 'high';
  reduce_motion: boolean;
  dyslexia_font: boolean;
  line_spacing: 'normal' | 'relaxed';
  underline_links: boolean;
}

export interface AccessibilityProfile {
  prefs: AccessibilityPrefs;
  /** Account-wide extra time (admin-granted), 1 = none. */
  time_multiplier: number;
  /** Set while an attempt is in progress: preferences cannot change then. */
  locked_by_attempt: number | null;
}

// ---------------------------------------------------------------- post-exam insights

export interface GradingQueueQuestion {
  question_id: number;
  label: string;
  qtype: QuestionType;
  text: string;
  points: number;
  options: string[];
  model_answer: string;
  allow_assumptions: boolean;
  total: number;
  marked: number;
  needs_marks: number;
}

export interface GradingQueueItem {
  attempt_id: number;
  question_id: number;
  student: { name: string; entry_number: string | null; email: string };
  answer_text: string;
  assumption: string | null;
  reason: 'descriptive' | 'assumption';
  auto_marks: number | null;
  marks: number | null;
  feedback: string;
  graded_by_name: string | null;
  graded_at: string | null;
}

export interface GradingQueue {
  quiz_version_id: number;
  questions: GradingQueueQuestion[];
  items: GradingQueueItem[];
  pending: number;
}

export interface QuestionStat {
  question_id: number;
  label: string;
  qtype: QuestionType;
  text: string;
  points: number;
  slot_id: number | null;
  bank_id: number | null;
  bank_question_id: number | null;
  grading_mode: GradingMode;
  answer_text: string;
  accept_also_text: string[];
  answer: unknown;
  accept_also: unknown[];
  tolerance: number | null;
  options: string[];
  bonus: number;
  dealt: number;
  answered: number;
  correct: number;
  pending: number;
  mean_fraction: number | null;
  discrimination: number | null;
  observed_difficulty: Difficulty | null;
  bank_difficulty: Difficulty | null;
  suggested_difficulty: Difficulty | null;
  distribution: { answer: string; count: number; correct: boolean }[];
}

export interface QuestionReview {
  quiz_version_id: number;
  graded_attempts: number;
  min_sample: number;
  questions: QuestionStat[];
}

export interface FairnessSlot {
  slot: { id: number; bank_id: number; difficulty: Difficulty | null; tag: string | null; points: number };
  label: string;
  verdict: 'fair' | 'unfair' | 'not_enough_data';
  gap: number;
  p_value: number | null;
  small_sample: boolean;
  normalized: boolean;
  proposed_bonus: Record<number, number>;
  variants: QuestionStat[];
}

export interface FairnessReport {
  quiz_version_id: number;
  graded_attempts: number;
  min_sample: number;
  slots: FairnessSlot[];
}

export interface CollusionStudent {
  attempt_id: number;
  name: string;
  entry_number: string | null;
  score: number | null;
  max_score: number | null;
}

export interface CollusionPair {
  a: CollusionStudent;
  b: CollusionStudent;
  level: 'high' | 'medium' | 'low';
  shared_wrong: number;
  both_wrong: number;
  expected_by_chance: number;
  p_value: number;
  adjusted_p: number;
  shared_questions: { question_id: number; label: string; answer: string }[];
  text_matches: { question_id: number; label: string; similarity: number }[];
  same_network: boolean;
  close_saves: number;
  submitted_gap_seconds: number | null;
}

export interface CollusionReport {
  quiz_version_id: number;
  analysed_attempts: number;
  pairs_checked: number;
  questions_used: number;
  flagged: number;
  pairs: CollusionPair[];
  generated_at: string;
}

export interface Appeal {
  id: number;
  attempt_id: number;
  user_id: number;
  kind: 'grading' | 'integrity';
  question_id: number | null;
  message: string;
  status: 'open' | 'accepted' | 'rejected';
  response: string | null;
  resolved_by_name?: string | null;
  resolved_at: string | null;
  created_at: string;
  student_name?: string;
  student_entry?: string | null;
}

export interface AppealWithContext extends Appeal {
  attempt: {
    id: number;
    status: string;
    score: number | null;
    max_score: number | null;
    violation_count: number;
    lock_reason: string | null;
    finalize_reason: string | null;
  };
  question: {
    id: number;
    label: string;
    text: string;
    qtype: QuestionType;
    points: number;
    answer_text: string;
    student_answer: string;
    assumption: string | null;
    earned: number;
  } | null;
  open_flags: number;
}

export interface QuestionHealthRow {
  question_id: number;
  label: string;
  qtype: QuestionType;
  text: string;
  dealt: number;
  answered: number;
  correct: number | null;
  correct_rate: number | null;
  changes_per_answer: number;
  hands: number;
  warnings: string[];
}

export interface StaffHand extends Hand {
  attempt_id: number;
  user_id: number;
  student_name: string;
  student_entry: string | null;
  replied_by_name: string | null;
  question_label: string | null;
}
