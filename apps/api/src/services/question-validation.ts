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
}

const MAX_QUESTION_TEXT = 20_000;
const MAX_OPTIONS = 26;
const MAX_OPTION_TEXT = 2_000;
const POINTS_ERROR = 'Points must be between 0 and 1000.';

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

export function validateQuestionData(data: {
  qtype: string;
  text: string;
  options?: unknown;
  answer: unknown;
  tolerance?: unknown;
  points?: unknown;
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

  if (qtype === 'single' || qtype === 'multiple') {
    const constOptions = Array.isArray(data.options) ? data.options.map(String).map((s) => s.trim()) : [];
    if (constOptions.some((option) => !option)) throw new AppError(400, 'Option cannot be empty.');
    if (constOptions.length < 2) throw new AppError(400, 'Choice questions need at least two options.');
    if (constOptions.length > MAX_OPTIONS) throw new AppError(400, `Choice questions can have at most ${MAX_OPTIONS} options.`);
    if (constOptions.some((o) => o.length > MAX_OPTION_TEXT)) {
      throw new AppError(400, `Each option must be at most ${MAX_OPTION_TEXT} characters.`);
    }
    const index = (raw: unknown): number =>
      typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : Number.NaN;
    if (qtype === 'single') {
      const idx = index(data.answer);
      if (!Number.isInteger(idx) || idx < 0 || idx >= constOptions.length) {
        throw new AppError(400, 'Answer must be a valid option index.');
      }
      return { qtype, options: constOptions, answer: idx, points };
    }
    if (!Array.isArray(data.answer)) {
      throw new AppError(400, 'Answer must be a list of valid option indices.');
    }
    const idxs = data.answer.map(index);
    if (idxs.length === 0 || idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= constOptions.length)) {
      throw new AppError(400, 'Answer must be a list of valid option indices.');
    }
    return { qtype, options: constOptions, answer: [...new Set(idxs)].sort((a, b) => a - b), points };
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
    return { qtype, options: undefined, answer: n, tolerance: tol, points };
  }

  if (qtype === 'descriptive') {
    // Not auto-graded: the "answer" is an optional model answer / marking guide for the grader.
    const guide = typeof data.answer === 'string' ? data.answer.trim() : '';
    if (guide.length > MAX_QUESTION_TEXT) {
      throw new AppError(400, `The marking guide must be at most ${MAX_QUESTION_TEXT} characters.`);
    }
    return { qtype, options: undefined, answer: guide, points };
  }

  const text = String(data.answer ?? '').trim();
  if (!text) throw new AppError(400, 'Short-answer expected value is required.');
  if (text.length > MAX_OPTION_TEXT) throw new AppError(400, `Expected answer must be at most ${MAX_OPTION_TEXT} characters.`);
  return { qtype, options: undefined, answer: text, points };
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

