import type { AttemptStatus, QuestionType, IntegrityPolicy, PolicyTrigger, ShowScores } from './types.js';
import type { PublicExamSettings } from './services/exam-settings.js';

/** A question as shown inside an attempt — never includes the answer key. */
export interface AttemptQuestion {
  id: number;
  qtype: QuestionType;
  text: string;
  /** Options in this student's display order (shuffled per attempt when enabled). */
  options: string[];
  points: number;
  order_index: number;
  /** 0-based position of the question in this student's attempt. */
  position: number;
  /** Effective per-question limit when question timers are on. */
  time_limit_seconds: number | null;
  /** The student may write down an assumption with the answer. */
  allow_assumptions: boolean;
}

export interface AttemptAnswer {
  question_id: number;
  /** In display space (option indices refer to `AttemptQuestion.options`). */
  answer: unknown;
  revision: number;
  status: 'pending' | 'saved' | 'submitted';
  saved_at: string | null;
  assumption: string | null;
}

export interface AttemptMeta {
  id: number;
  quiz_version_id: number;
  status: AttemptStatus;
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

export interface AttemptEventView {
  id: number;
  kind: string;
  detail: string | null;
  recorded_at: string;
}

export interface AnnouncementView {
  id: number;
  message: string;
  created_at: string;
  personal: boolean;
  /** Clarification pinned to this question. */
  question_id: number | null;
}

/** A student's raised hand and the invigilator's reply. */
export interface HandView {
  id: number;
  question_id: number | null;
  message: string;
  status: 'open' | 'answered' | 'dismissed';
  reply: string | null;
  broadcast: boolean;
  created_at: string;
  answered_at: string | null;
}

export interface IntegralAttemptView {
  attempt: AttemptMeta;
  quiz: {
    /** quiz_version id (kept for existing clients). */
    id: number;
    quiz_id: number;
    title: string;
    instructions: string;
    integrity_policy: IntegrityPolicy;
    policy_trigger: PolicyTrigger;
    show_scores: ShowScores;
    settings: PublicExamSettings;
    rules: string[];
    paused: boolean;
  };
  student: { name: string; email: string; entry_number: string | null };
  /** In-progress attempts only; sequential quizzes reveal just the current question. */
  questions: AttemptQuestion[];
  answers: Record<number, AttemptAnswer>;
  events: AttemptEventView[];
  announcements: AnnouncementView[];
  hands: HandView[];
  heartbeat_ms: number;
}

export interface SaveAck {
  question_id: number;
  acknowledged: boolean;
  revision: number;
  saved_at: string;
  /** Why an item was not stored ('not_current' | 'invalid'). */
  reason?: string;
}

export interface SubmitResult {
  attempt_id: number;
  status: AttemptStatus;
  receipt: string | null;
  release_token: string | null;
  /** Only present when the quiz shows scores immediately. */
  score: number | null;
  max_score: number | null;
  graded_at: string | null;
  acknowledged_answers: number;
  /** Written answers waiting for the instructor's marks (score hidden until then). */
  pending_manual: number;
  finalize_reason: string | null;
  policy: { recorded: number };
}

export interface HeartbeatResult {
  server_now: string;
  status: AttemptStatus;
  expires_at: string | null;
  question_expires_at: string | null;
  current_index: number;
  paused: boolean;
  closed: boolean;
  violation_count: number;
  max_violations: number;
  lock_reason: string | null;
  finalize_reason: string | null;
  announcements: AnnouncementView[];
  hands: HandView[];
  heartbeat_ms: number;
}

export interface EventOutcome {
  action: 'ignored' | 'recorded' | 'locked' | 'submitted';
  lock: boolean;
  violation: boolean;
  violation_count: number;
  max_violations: number;
  violation_action: 'none' | 'lock' | 'submit';
  message?: string;
}

export interface QuizListItem {
  quiz_id: number;
  quiz_version_id: number;
  version: number;
  status: string;
  title: string;
  question_count: number;
  duration_minutes: number | null;
  integrity_policy: IntegrityPolicy;
  show_scores: string;
  published_at: string | null;
  attempts_allowed: number;
  my_attempts: number;
  my_in_progress: number;
  my_best: number | null;
  my_status: string | null;
}

export interface ResultView {
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
  /** Written answers still waiting for the instructor's marks. */
  pending_manual: number;
  per_question: {
    question_id: number;
    text: string;
    qtype: QuestionType;
    options: string[];
    your_answer: unknown;
    answered?: boolean;
    assumption?: string | null;
    correct_answer: unknown;
    accept_also?: unknown[];
    earned: number;
    points: number;
    source?: string;
    pending?: boolean;
    bonus?: number;
    grading_mode?: string;
    feedback?: string | null;
  }[];
}
