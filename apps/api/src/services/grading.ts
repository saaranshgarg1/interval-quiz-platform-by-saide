import type { Question, AnswerRevision } from '../types.js';
import { jsonParse } from '../util.js';

export interface GradedQuestion {
  question_id: number;
  correct: boolean;
  earned: number;
  points: number;
}

export interface GradeResult {
  score: number;
  maxScore: number;
  perQuestion: GradedQuestion[];
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
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (qtype === 'short') {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  }
  return raw;
}

export function isAnswerCorrect(q: Question, userRaw: unknown): boolean {
  const user = normalizeUserAnswer(q.qtype, userRaw);
  switch (q.qtype) {
    case 'single': {
      const correct = Number(q.answer);
      return user === correct;
    }
    case 'multiple': {
      const correct = normalizeIndices(q.answer);
      const given = normalizeIndices(user);
      return given.length > 0 && given.length === correct.length && given.every((g) => correct.includes(g));
    }
    case 'numeric': {
      const correct = Number(q.answer);
      const given = Number(user);
      const tol = q.tolerance ?? 0;
      return Math.abs(given - correct) <= tol;
    }
    case 'short': {
      const correct = String(q.answer ?? '').trim().toLowerCase();
      const given = String(user ?? '').trim().toLowerCase();
      return correct.length > 0 && given === correct;
    }
    default:
      return false;
  }
}

export function gradeAttempt(
  questions: Question[],
  answers: (AnswerRevision | undefined)[],
): GradeResult {
  let score = 0;
  let maxScore = 0;
  const perQuestion: GradedQuestion[] = [];
  for (const q of questions) {
    const answer = answers.find((a) => a?.question_id === q.id);
    const points = Number(q.points) || 1;
    maxScore += points;
    let earned = 0;
    if (answer) {
      const userAnswer = jsonParse<unknown>(answer.answer, null);
      if (isAnswerCorrect(q, userAnswer)) earned = points;
    }
    score += earned;
    perQuestion.push({
      question_id: q.id,
      correct: earned > 0,
      earned,
      points,
    });
  }
  return { score: round2(score), maxScore: round2(maxScore), perQuestion };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { round2 };