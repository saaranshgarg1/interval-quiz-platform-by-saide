import type { Question, AnswerRevision } from '../types.js';
import { jsonParse } from '../util.js';

export interface GradedQuestion {
  question_id: number;
  correct: boolean;
  earned: number;
  /** What the question counts for on this paper (0 when dropped). */
  points: number;
  /** How the mark was decided. */
  source: 'auto' | 'manual' | 'full_marks' | 'dropped' | 'pending' | 'unanswered';
  /** Answered descriptive question with no marks yet. */
  pending: boolean;
  /** Fairness bonus included in `earned`. */
  bonus: number;
}

export interface GradeResult {
  score: number;
  maxScore: number;
  /** Descriptive answers still to be marked by hand. */
  pending: number;
  perQuestion: GradedQuestion[];
}

/** Marks an instructor gave for one question of one attempt. */
export interface ManualMark {
  marks: number;
  feedback: string;
}

function normalizeIndices(v: unknown): number[] {
  if (Array.isArray(v)) {
    return (v.filter((x) => Number.isInteger(x)) as number[]).slice().sort((a, b) => a - b);
  }
  if (typeof v === 'number') return [v];
  return [];
}

export function normalizeUserAnswer(qtype: Question['qtype'], raw: unknown): unknown {
  if (qtype === 'single') {
    const idx = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(idx) ? idx : null;
  }
  if (qtype === 'multiple') {
    return normalizeIndices(raw);
  }
  if (qtype === 'numeric') {
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (qtype === 'short') {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  }
  if (qtype === 'descriptive') {
    return typeof raw === 'string' ? raw.trim() : '';
  }
  return raw;
}

/** True when the student left the question blank. */
export function isBlank(qtype: Question['qtype'], raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (qtype === 'multiple') return normalizeIndices(raw).length === 0;
  if (qtype === 'numeric') return !Number.isFinite(Number(raw)) || (typeof raw === 'string' && raw.trim() === '');
  if (typeof raw === 'string') return raw.trim() === '';
  return false;
}

function matchesKey(q: Question, key: unknown, user: unknown): boolean {
  switch (q.qtype) {
    case 'single':
      return user === Number(key);
    case 'multiple': {
      const correct = normalizeIndices(key);
      const given = normalizeIndices(user);
      return given.length > 0 && given.length === correct.length && given.every((g) => correct.includes(g));
    }
    case 'numeric': {
      if (user === null) return false;
      return Math.abs(Number(user) - Number(key)) <= (q.tolerance ?? 0);
    }
    case 'short': {
      const correct = String(key ?? '').trim().toLowerCase();
      return correct.length > 0 && String(user ?? '') === correct;
    }
    default:
      return false;
  }
}

/** Auto-check against the key and any answers accepted later by a regrade. Descriptive: never. */
export function isAnswerCorrect(q: Question, userRaw: unknown): boolean {
  if (q.qtype === 'descriptive') return false;
  const user = normalizeUserAnswer(q.qtype, userRaw);
  return [q.answer, ...(q.accept_also ?? [])].some((key) => matchesKey(q, key, user));
}

/** Grade one question. `manual` (if any) overrides the automatic mark. */
export function gradeQuestion(q: Question, rawAnswer: unknown, manual?: ManualMark): GradedQuestion {
  const points = Number(q.points) || 1;
  const base = { question_id: q.id, bonus: 0, pending: false };
  if (q.grading_mode === 'dropped') {
    return { ...base, correct: false, earned: 0, points: 0, source: 'dropped' };
  }
  if (q.grading_mode === 'full_marks') {
    return { ...base, correct: true, earned: points, points, source: 'full_marks' };
  }
  const blank = isBlank(q.qtype, rawAnswer);
  let earned = 0;
  let source: GradedQuestion['source'];
  if (manual) {
    earned = Math.max(0, Math.min(points, manual.marks));
    source = 'manual';
  } else if (blank) {
    source = 'unanswered';
  } else if (q.qtype === 'descriptive') {
    return { ...base, correct: false, earned: 0, points, source: 'pending', pending: true };
  } else {
    earned = isAnswerCorrect(q, rawAnswer) ? points : 0;
    source = 'auto';
  }
  const bonus = q.bonus > 0 ? Math.min(q.bonus, points - earned) : 0;
  return {
    ...base,
    correct: earned >= points,
    earned: round2(earned + bonus),
    points,
    source,
    bonus: round2(bonus),
  };
}

export function gradeAttempt(
  questions: Question[],
  answers: (AnswerRevision | undefined)[],
  manual: Map<number, ManualMark> = new Map(),
): GradeResult {
  let score = 0;
  let maxScore = 0;
  let pending = 0;
  const perQuestion: GradedQuestion[] = [];
  for (const q of questions) {
    const answer = answers.find((a) => a?.question_id === q.id);
    const raw = answer ? jsonParse<unknown>(answer.answer, null) : null;
    const g = gradeQuestion(q, raw, manual.get(q.id));
    score += g.earned;
    maxScore += g.points;
    if (g.pending) pending++;
    perQuestion.push(g);
  }
  return { score: round2(score), maxScore: round2(maxScore), pending, perQuestion };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { round2 };
