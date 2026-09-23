import type { AttemptStatus, QuestionType, IntegrityPolicy, PolicyTrigger } from './types.js';

/** A question as shown inside an attempt — never includes the answer key. */
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
}

export interface AttemptEventView {
  id: number;
  kind: string;
  detail: string | null;
  recorded_at: string;
}

export interface IntegralAttemptView {
  attempt: AttemptMeta;
  quiz: {
    id: number;
    title: string;
    instructions: string;
    integrity_policy: IntegrityPolicy;
    policy_trigger: PolicyTrigger;
  };
  questions: AttemptQuestion[];
  answers: Record<number, AttemptAnswer>;
  events: AttemptEventView[];
}

export interface SaveAck {
  question_id: number;
  acknowledged: boolean;
  revision: number;
  saved_at: string;
}

export interface SubmitResult {
  attempt_id: number;
  status: AttemptStatus;
  receipt: string | null;
  release_token: string | null;
  score: number | null;
  max_score: number | null;
  graded_at: string | null;
  acknowledged_answers: number;
  policy: { recorded: number };
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
  per_question: {
    question_id: number;
    text: string;
    qtype: QuestionType;
    options: string[];
    your_answer: unknown;
    correct_answer: unknown;
    earned: number;
    points: number;
  }[];
}