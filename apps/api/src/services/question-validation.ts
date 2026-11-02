import { AppError } from '../auth.js';
import { QUESTION_TYPES, type QuestionType } from '../types.js';

/**
 * Shape and size checks for a question, shared by the quiz editor and question
 * banks (a bank question becomes a real exam question when a random slot draws it).
 */
export interface Validated {
  qtype: QuestionType;
  options?: string[];
  answer: unknown;
  tolerance?: number;
  points?: number;
  /** Marks taken off for a wrong (not blank) answer; 0 for hand-marked questions. */
  negative_points?: number;
}

const MAX_QUESTION_TEXT = 20_000;
const MAX_OPTIONS = 26;
const MAX_OPTION_TEXT = 2_000;
const POINTS_ERROR = 'Points must be greater than 0 and at most 1000.';

/**
 * Points are optional only when the key is omitted (callers default/create or
 * preserve/update). Once present, anything that isn't a positive finite number
 * (or numeric string) up to 1000 is rejected instead of being coerced.
 */
function parsePoints(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0 || raw > 1000) throw new AppError(400, POINTS_ERROR);
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const points = Number(raw);
    if (!Number.isFinite(points) || points <= 0 || points > 1000) throw new AppError(400, POINTS_ERROR);
    return points;
  }
  throw new AppError(400, POINTS_ERROR);
}

/**
 * Negative marking: marks deducted for a wrong answer (0 = none). Optional; only
 * auto-graded types can have it (a descriptive answer is marked by hand).
 */
function parseNegativePoints(raw: unknown, qtype: QuestionType): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return 0;
  const n = Number(raw);
  if (typeof raw === 'boolean' || !Number.isFinite(n) || n < 0 || n > 1000) {
    throw new AppError(400, 'Negative marks must be a number from 0 to 1000 (the marks taken off for a wrong answer).');
  }
  return qtype === 'descriptive' ? 0 : n;
}

export function validateQuestionData(data: {
  qtype: string;
  text: string;
  options?: unknown;
  answer: unknown;
  tolerance?: unknown;
  points?: unknown;
  negative_points?: unknown;
}): Validated {
  if (!QUESTION_TYPES.includes(data.qtype as QuestionType)) {
    throw new AppError(400, 'Invalid question type.');
  }
  const qtype = data.qtype as QuestionType;
  if (!String(data.text ?? '').trim()) throw new AppError(400, 'Question text is required.');
  if (String(data.text).length > MAX_QUESTION_TEXT) {
    throw new AppError(400, `Question text must be at most ${MAX_QUESTION_TEXT} characters.`);
  }
  const points = parsePoints(data.points);

  const negative_points = parseNegativePoints(data.negative_points, qtype);

  if (qtype === 'single' || qtype === 'multiple') {
    // Blank options are simply left out (the form always has spare empty rows).
    // The answer refers to positions in the list as sent, so it is renumbered to
    // the kept options; pointing at a blank option is an error, never a silent shift.
    const sent = Array.isArray(data.options) ? data.options.map((o) => String(o ?? '').trim()) : [];
    const newIndex = new Map<number, number>();
    const constOptions: string[] = [];
    sent.forEach((o, i) => {
      if (!o) return;
      newIndex.set(i, constOptions.length);
      constOptions.push(o);
    });
    const remap = (i: number): number => {
      if (Number.isInteger(i) && i >= 0 && i < sent.length && !newIndex.has(i)) {
        throw new AppError(400, 'The correct answer is a blank option. Tick an option that has text.');
      }
      return newIndex.get(i) ?? Number.NaN;
    };
    if (constOptions.length < 2) throw new AppError(400, 'Choice questions need at least two options with text.');
    if (constOptions.length > MAX_OPTIONS) throw new AppError(400, `Choice questions can have at most ${MAX_OPTIONS} options.`);
    if (constOptions.some((o) => o.length > MAX_OPTION_TEXT)) {
      throw new AppError(400, `Each option must be at most ${MAX_OPTION_TEXT} characters.`);
    }
    const index = (raw: unknown): number =>
      typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : Number.NaN;
    if (qtype === 'single') {
      const idx = remap(index(data.answer));
      if (!Number.isInteger(idx) || idx < 0 || idx >= constOptions.length) {
        throw new AppError(400, 'Answer must be a valid option index.');
      }
      return { qtype, options: constOptions, answer: idx, points, negative_points };
    }
    if (!Array.isArray(data.answer)) {
      throw new AppError(400, 'Answer must be a list of valid option indices.');
    }
    const idxs = data.answer.map(index).map(remap);
    if (idxs.length === 0 || idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= constOptions.length)) {
      throw new AppError(400, 'Answer must be a list of valid option indices.');
    }
    return { qtype, options: constOptions, answer: [...new Set(idxs)].sort((a, b) => a - b), points, negative_points };
  }

  if (qtype === 'numeric') {
    if ((typeof data.answer !== 'number' && typeof data.answer !== 'string') ||
        (typeof data.answer === 'string' && !data.answer.trim())) {
      throw new AppError(400, 'Numeric answer must be a number.');
    }
    const n = Number(data.answer);
    if (!Number.isFinite(n)) throw new AppError(400, 'Numeric answer must be a number.');
    const tol = data.tolerance == null || data.tolerance === '' ? 0 : Number(data.tolerance);
    if (!Number.isFinite(tol) || tol < 0) throw new AppError(400, 'Tolerance must be a non-negative number.');
    return { qtype, options: undefined, answer: n, tolerance: tol, points, negative_points };
  }

  if (qtype === 'descriptive') {
    // Not auto-graded: the "answer" is an optional model answer / marking guide for the grader.
    const guide = typeof data.answer === 'string' ? data.answer.trim() : '';
    if (guide.length > MAX_QUESTION_TEXT) {
      throw new AppError(400, `The marking guide must be at most ${MAX_QUESTION_TEXT} characters.`);
    }
    return { qtype, options: undefined, answer: guide, points, negative_points };
  }

  const text = String(data.answer ?? '').trim();
  if (!text) throw new AppError(400, 'Short-answer expected value is required.');
  if (text.length > MAX_OPTION_TEXT) throw new AppError(400, `Expected answer must be at most ${MAX_OPTION_TEXT} characters.`);
  return { qtype, options: undefined, answer: text, points, negative_points };
}

/** Optional per-question time limit (seconds); '' / null clears it. */
export function parseTimeLimit(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 5 || n > 7200) {
    throw new AppError(400, 'A question time limit must be between 5 and 7200 seconds.');
  }
  return n;
}

