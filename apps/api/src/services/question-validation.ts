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
}

const MAX_QUESTION_TEXT = 20_000;
const MAX_OPTIONS = 26;
const MAX_OPTION_TEXT = 2_000;

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
  if (data.points !== undefined && data.points !== null && data.points !== '') {
    const p = Number(data.points);
    if (!Number.isFinite(p) || p <= 0 || p > 1000) throw new AppError(400, 'Points must be between 0 and 1000.');
  }

  if (qtype === 'single' || qtype === 'multiple') {
    const constOptions = Array.isArray(data.options) ? data.options.map(String).map((s) => s.trim()).filter(Boolean) : [];
    if (constOptions.length < 2) throw new AppError(400, 'Choice questions need at least two options.');
    if (constOptions.length > MAX_OPTIONS) throw new AppError(400, `Choice questions can have at most ${MAX_OPTIONS} options.`);
    if (constOptions.some((o) => o.length > MAX_OPTION_TEXT)) {
      throw new AppError(400, `Each option must be at most ${MAX_OPTION_TEXT} characters.`);
    }
    const answerIdx = Array.isArray(data.answer)
      ? data.answer.map(Number)
      : [Number(data.answer)];
    if (qtype === 'single') {
      const idx = Number(data.answer);
      if (!Number.isInteger(idx) || idx < 0 || idx >= constOptions.length) {
        throw new AppError(400, 'Answer must be a valid option index.');
      }
    } else {
      const idxs = answerIdx;
      if (idxs.length === 0 || idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= constOptions.length)) {
        throw new AppError(400, 'Answer must be a list of valid option indices.');
      }
    }
    return { qtype, options: constOptions, answer: data.answer };
  }

  if (qtype === 'numeric') {
    const n = Number(data.answer);
    if (!Number.isFinite(n)) throw new AppError(400, 'Numeric answer must be a number.');
    const tol = data.tolerance == null || data.tolerance === '' ? 0 : Number(data.tolerance);
    if (!Number.isFinite(tol) || tol < 0) throw new AppError(400, 'Tolerance must be a non-negative number.');
    return { qtype, options: undefined, answer: n, tolerance: tol };
  }

  if (qtype === 'descriptive') {
    // Not auto-graded: the "answer" is an optional model answer / marking guide for the grader.
    const guide = typeof data.answer === 'string' ? data.answer.trim() : '';
    if (guide.length > MAX_QUESTION_TEXT) {
      throw new AppError(400, `The marking guide must be at most ${MAX_QUESTION_TEXT} characters.`);
    }
    return { qtype, options: undefined, answer: guide };
  }

  const text = String(data.answer ?? '').trim();
  if (!text) throw new AppError(400, 'Short-answer expected value is required.');
  if (text.length > MAX_OPTION_TEXT) throw new AppError(400, `Expected answer must be at most ${MAX_OPTION_TEXT} characters.`);
  return { qtype, options: undefined, answer: text };
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

