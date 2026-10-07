export type Role = 'student' | 'instructor' | 'admin';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
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
}

export interface RosterResponse {
  roster: RosterMember[];
}

export type QuestionType = 'single' | 'multiple' | 'short' | 'numeric';
export type IntegrityPolicy = 'off' | 'warn' | 'strict';
export type ShowScores = 'never' | 'release' | 'immediate';
export type QuizType = 'anytime' | 'scheduled';

export interface QuestionEditor {
  id: number;
  qtype: QuestionType;
  text: string;
  options: string[];
  points: number;
  order_index: number;
  answer: unknown;
  tolerance: number | null;
}

export interface MyAttemptSummary {
  count: number;
  in_progress: number | null;
  best_score: number | null;
  last_status: string | null;
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
  published_at: string | null;
  created_at: string;
  questions: QuestionEditor[];
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
  versions: VersionDetail[];
}

export interface AttemptQuestion {
  id: number;
  qtype: QuestionType;
  text: string;
  options: string[];
  points: number;
  order_index: number;
}

export interface AttemptAnswer {
  question_id: number;
  answer: unknown;
  revision: number;
  status: 'pending' | 'saved' | 'submitted';
  saved_at: string | null;
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
}

export interface AttemptView {
  attempt: AttemptMeta;
  quiz: {
    id: number;
    title: string;
    instructions: string;
    integrity_policy: IntegrityPolicy;
    policy_trigger: string;
  };
  questions: AttemptQuestion[];
  answers: Record<number, AttemptAnswer>;
  events: { id: number; kind: string; detail: string | null; recorded_at: string }[];
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
  per_question: {
    question_id: number;
    text: string;
    qtype: QuestionType;
    options: string[];
    your_answer: unknown;
    answered: boolean;
    correct_answer: unknown;
    earned: number;
    points: number;
  }[];
}

export interface Incident {
  attempt_id: number;
  quiz_version_id: number;
  quiz_title: string;
  status: string;
  started_at: string;
  expires_at: string | null;
  user_id: number;
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
    quiz_title: string;
    version: number;
  };
  student: User | null;
  answers: { question_id: number; position: number; answer: unknown; revision: number; saved_at: string; status: string }[];
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