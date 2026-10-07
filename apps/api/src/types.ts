export type Role = 'student' | 'instructor' | 'admin';
export type CourseRole = 'student' | 'ta' | 'instructor';

export interface User {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: string;
}

export type PublicUser = Pick<User, 'id' | 'name' | 'email' | 'role'>;

export interface Course {
  id: number;
  code: string;
  name: string;
  created_by: number;
  created_at: string;
}

export interface Quiz {
  id: number;
  course_id: number;
  created_by: number;
  created_at: string;
}

export type QuizStatus = 'draft' | 'published' | 'archived';
export type IntegrityPolicy = 'off' | 'warn' | 'strict';
export type PolicyTrigger = 'focus_exit' | 'page_hidden';
export type ShowScores = 'never' | 'release' | 'immediate';
export type QuizType = 'anytime' | 'scheduled';

export interface QuizVersion {
  id: number;
  quiz_id: number;
  course_id: number;
  created_by: number;
  version: number;
  status: QuizStatus;
  title: string;
  instructions: string;
  duration_minutes: number | null;
  shuffle_questions: number;
  shuffle_options: number;
  attempts_allowed: number;
  integrity_policy: IntegrityPolicy;
  policy_trigger: PolicyTrigger;
  show_scores: ShowScores;
  quiz_type: QuizType;
  window_opens_at: string | null;
  window_duration_minutes: number | null;
  published_at: string | null;
  archived_at: string | null;
  created_at: string;
}

export type QuestionType = 'single' | 'multiple' | 'short' | 'numeric';

export interface Question {
  id: number;
  quiz_version_id: number;
  version: number;
  qtype: QuestionType;
  text: string;
  options: string[];
  answer: unknown;
  tolerance: number | null;
  points: number;
  order_index: number;
  is_latest: number;
  created_at: string;
}

export type AttemptStatus =
  | 'in_progress'
  | 'submitted'
  | 'expired'
  | 'locked'
  | 'under_review'
  | 'reinstated';

export interface Attempt {
  id: number;
  quiz_version_id: number;
  user_id: number;
  status: AttemptStatus;
  started_at: string;
  expires_at: string | null;
  submitted_at: string | null;
  question_order: string;
  seed: number;
  score: number | null;
  max_score: number | null;
  graded_at: string | null;
  receipt: string | null;
  release_token: string | null;
  submitted_revision: number;
  created_at: string;
}

export type AnswerStatus = 'pending' | 'saved' | 'submitted';

export interface AnswerRevision {
  id: number;
  attempt_id: number;
  question_id: number;
  position: number;
  answer: string;
  revision: number;
  saved_at: string;
  status: AnswerStatus;
}

export interface PolicyEvent {
  id: number;
  attempt_id: number;
  kind: string;
  detail: string | null;
  recorded_at: string;
  source: string;
}

export interface ReviewDecision {
  id: number;
  attempt_id: number;
  decided_by: number;
  decision: string;
  reason: string | null;
  created_at: string;
}

export interface Result {
  id: number;
  attempt_id: number;
  quiz_version_id: number;
  user_id: number;
  score: number;
  max_score: number;
  answer_key_released: number;
  released: number;
  released_at: string | null;
  graded_at: string;
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
  created_at: string;
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