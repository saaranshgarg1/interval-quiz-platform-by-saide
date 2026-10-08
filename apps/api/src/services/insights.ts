import { transaction } from '../db.js';
import {
  attemptRepo,
  answerRepo,
  questionRepo,
  quizRepo,
  quizVersionRepo,
  slotRepo,
  bankRepo,
  userRepo,
  policyRepo,
  reviewRepo,
} from '../repo.js';
import { announcementRepo } from '../exam-repo.js';
import { appealRepo, handRepo, manualGradeRepo, type Appeal, type AppealKind } from '../insight-repo.js';
import { AppError } from '../auth.js';
import { gradeQuestion, isAnswerCorrect, isBlank, normalizeUserAnswer, type ManualMark } from './grading.js';
import { questionsForAttempt, regradeAttempt, regradeVersion, scoreVisible } from './finalize.js';
import { validateQuestionData } from './question-validation.js';
import { manualFlagsForAttempt, resolveFlag } from './flags.js';
import { jsonParse, toMs } from '../util.js';
import type { AnswerRevision, Attempt, Difficulty, GradingMode, Question, QuizVersion } from '../types.js';

/**
 * Post-exam tools for instructors: hand-marking written answers, regrading a
 * question, checking that students who drew different random questions were
 * treated fairly (and evening it out), re-rating bank difficulty from real
 * results, a statistical collusion check, appeals, and live question health.
 *
 * Everything here reads finished attempts (submitted or expired) only.
 */

const GRADED = ['submitted', 'expired'] as const;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function gradedAttempts(versionId: number): Attempt[] {
  return attemptRepo.listByStatus(versionId, [...GRADED]);
}

function versionOrThrow(versionId: number): QuizVersion {
  const version = quizVersionRepo.get(versionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  return version;
}

// ---------------------------------------------------------------- labels

/**
 * "Q3" for an authored question, "Q5·B" for the second bank question drawn
 * into random slot Q5 — the numbering students and instructors see.
 */
export function paperLabels(versionId: number, all?: Question[]): Map<number, string> {
  const questions = all ?? questionRepo.listForVersion(versionId);
  const items = [
    ...questions.filter((q) => !q.slot_id).map((q) => ({ order: q.order_index, kind: 'q' as const, id: q.id })),
    ...slotRepo.listForVersion(versionId).map((s) => ({ order: s.order_index, kind: 's' as const, id: s.id })),
  ].sort((a, b) => a.order - b.order || a.id - b.id);
  const labels = new Map<number, string>();
  items.forEach((item, i) => {
    if (item.kind === 'q') {
      labels.set(item.id, `Q${i + 1}`);
      return;
    }
    questions
      .filter((q) => q.slot_id === item.id)
      .sort((a, b) => a.id - b.id)
      .forEach((q, k) => labels.set(q.id, `Q${i + 1}·${LETTERS[k] ?? k + 1}`));
  });
  return labels;
}

/** An answer as a person reads it ("B. Nielsen", "42", the typed text). */
export function displayAnswer(q: Question, raw: unknown, max = 240): string {
  if (isBlank(q.qtype, raw)) return '(blank)';
  const opt = (i: number) => `${LETTERS[i] ?? i + 1}. ${q.options[i] ?? '?'}`;
  if (q.qtype === 'single') return opt(Number(raw));
  if (q.qtype === 'multiple') return (normalizeUserAnswer('multiple', raw) as number[]).map(opt).join(' + ');
  const text = String(raw);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------- shared loading

interface VersionData {
  version: QuizVersion;
  questions: Question[];
  byId: Map<number, Question>;
  attempts: Attempt[];
  /** attempt id → question id → final answer row */
  answers: Map<number, Map<number, AnswerRevision>>;
  manual: Map<number, Map<number, ManualMark>>;
  labels: Map<number, string>;
}

function loadVersion(versionId: number): VersionData {
  const version = versionOrThrow(versionId);
  const questions = questionRepo.listForVersion(versionId);
  const attempts = gradedAttempts(versionId);
  const graded = new Set(attempts.map((a) => a.id));
  const answers = new Map<number, Map<number, AnswerRevision>>();
  for (const row of answerRepo.listForVersion(versionId)) {
    if (!graded.has(Number(row.attempt_id))) continue;
    let m = answers.get(Number(row.attempt_id));
    if (!m) answers.set(Number(row.attempt_id), (m = new Map()));
    m.set(Number(row.question_id), row);
  }
  return {
    version,
    questions,
    byId: new Map(questions.map((q) => [q.id, q])),
    attempts,
    answers,
    manual: manualGradeRepo.forVersion(versionId),
    labels: paperLabels(versionId, questions),
  };
}

function rawAnswer(d: VersionData, attemptId: number, questionId: number): unknown {
  const row = d.answers.get(attemptId)?.get(questionId);
  return row ? jsonParse<unknown>(row.answer, null) : null;
}

function dealtIds(a: Attempt): number[] {
  return jsonParse<number[]>(a.question_order, []);
}

// ---------------------------------------------------------------- manual grading

/**
 * Everything that needs (or may want) a human mark: every written
 * (descriptive) answer, and every answer that came with an assumption — the
 * instructor may decide the assumption was reasonable and award marks.
 */
export function gradingQueue(versionId: number) {
  const d = loadVersion(versionId);
  const users = new Map(
    d.attempts.map((a) => {
      const u = userRepo.findById(a.user_id);
      return [a.id, { name: u?.name ?? '', entry_number: u?.entry_number ?? null, email: u?.email ?? '' }];
    }),
  );
  const marksBy = new Map(manualGradeRepo.listForVersion(versionId).map((g) => [`${g.attempt_id}:${g.question_id}`, g]));
  const items: {
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
  }[] = [];
  const perQuestion = new Map<number, { total: number; marked: number }>();

  for (const a of d.attempts) {
    for (const qid of dealtIds(a)) {
      const q = d.byId.get(qid);
      const row = d.answers.get(a.id)?.get(qid);
      if (!q || !row) continue;
      const raw = jsonParse<unknown>(row.answer, null);
      const hasAssumption = Boolean(row.assumption && row.assumption.trim());
      const isWritten = q.qtype === 'descriptive' && !isBlank(q.qtype, raw);
      if (!isWritten && !hasAssumption) continue;
      const given = marksBy.get(`${a.id}:${qid}`);
      const auto = q.qtype === 'descriptive' ? null : gradeQuestion({ ...q, bonus: 0 }, raw).earned;
      items.push({
        attempt_id: a.id,
        question_id: qid,
        student: users.get(a.id) ?? { name: '', entry_number: null, email: '' },
        answer_text: displayAnswer(q, raw, 20_000),
        assumption: hasAssumption ? row.assumption : null,
        reason: isWritten ? 'descriptive' : 'assumption',
        auto_marks: auto,
        marks: given ? Number(given.marks) : null,
        feedback: given?.feedback ?? '',
        graded_by_name: given?.graded_by_name ?? null,
        graded_at: given?.graded_at ?? null,
      });
      const c = perQuestion.get(qid) ?? { total: 0, marked: 0 };
      c.total++;
      if (given) c.marked++;
      perQuestion.set(qid, c);
    }
  }
  const questions = [...perQuestion.entries()]
    .map(([qid, c]) => {
      const q = d.byId.get(qid) as Question;
      return {
        question_id: qid,
        label: d.labels.get(qid) ?? `#${qid}`,
        qtype: q.qtype,
        text: q.text,
        points: q.points,
        options: q.options,
        model_answer: q.qtype === 'descriptive' ? String(q.answer ?? '') : displayAnswer(q, q.answer),
        allow_assumptions: Boolean(q.allow_assumptions),
        total: c.total,
        marked: c.marked,
        needs_marks: q.qtype === 'descriptive' ? c.total - c.marked : 0,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return {
    quiz_version_id: versionId,
    questions,
    items,
    pending: questions.reduce((n, q) => n + q.needs_marks, 0),
  };
}

/** Give (or clear, with marks = null) the instructor's marks for one answer; regrades the attempt. */
export function setManualMarks(
  actorId: number,
  attemptId: number,
  questionId: number,
  marks: number | null,
  feedback: string,
) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (!GRADED.includes(attempt.status as (typeof GRADED)[number])) {
    throw new AppError(409, 'Marks can be given once the attempt has been submitted.');
  }
  if (!dealtIds(attempt).includes(questionId)) throw new AppError(400, 'That question is not on this paper.');
  const q = questionRepo.get(questionId) as Question;
  if (feedback.length > 4000) throw new AppError(400, 'Feedback is limited to 4000 characters.');
  return transaction(() => {
    if (marks === null) {
      manualGradeRepo.clear(attemptId, questionId);
    } else {
      if (!Number.isFinite(marks) || marks < 0 || marks > q.points) {
        throw new AppError(400, `Marks must be between 0 and ${q.points}.`);
      }
      manualGradeRepo.set(attemptId, questionId, round(marks), feedback, actorId);
    }
    const graded = regradeAttempt(attemptId);
    return { score: graded?.score ?? null, max_score: graded?.maxScore ?? null, pending: graded?.pending ?? 0 };
  });
}

// ---------------------------------------------------------------- regrade

/**
 * Fix a question after the exam: correct the key, also accept other answers,
 * give everyone full marks, or drop it from every paper. Every finished
 * attempt on the version is regraded at once.
 */
export function regradeQuestion(
  questionId: number,
  body: { mode?: unknown; answer?: unknown; tolerance?: unknown; accept_also?: unknown },
) {
  const q = questionRepo.get(questionId);
  if (!q) throw new AppError(404, 'Question not found.');
  const version = versionOrThrow(q.quiz_version_id);
  if (version.status === 'draft') throw new AppError(409, 'Regrading is for published quizzes; edit the draft instead.');

  const update: Parameters<typeof questionRepo.update>[1] = {};
  if (body.mode !== undefined) {
    if (!['normal', 'full_marks', 'dropped'].includes(String(body.mode))) {
      throw new AppError(400, "mode must be 'normal', 'full_marks' or 'dropped'.");
    }
    update.grading_mode = body.mode as GradingMode;
  }
  const shape = (answer: unknown, tolerance?: unknown) =>
    validateQuestionData({ qtype: q.qtype, text: q.text, options: q.options, answer, tolerance: tolerance ?? q.tolerance });
  if (q.qtype !== 'descriptive') {
    if (body.answer !== undefined) {
      const v = shape(body.answer, body.tolerance);
      update.answer = v.answer;
      if (q.qtype === 'numeric') update.tolerance = v.tolerance ?? 0;
    } else if (body.tolerance !== undefined && q.qtype === 'numeric') {
      update.tolerance = shape(q.answer, body.tolerance).tolerance ?? 0;
    }
    if (body.accept_also !== undefined) {
      if (!Array.isArray(body.accept_also) || body.accept_also.length > 20) {
        throw new AppError(400, 'accept_also must be a list of at most 20 answers.');
      }
      update.accept_also = body.accept_also.map((a) => shape(a).answer);
    }
  } else if (body.answer !== undefined || body.accept_also !== undefined) {
    throw new AppError(400, 'Written answers are marked by hand; use full marks or drop instead.');
  }
  return transaction(() => {
    const updated = questionRepo.update(q.id, update) as Question;
    const outcome = regradeVersion(version.id);
    return { question: updated, ...outcome };
  });
}

// ---------------------------------------------------------------- statistics

/** Natural log of Γ(z) (Lanczos). */
function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0] as number;
  for (let i = 1; i < g + 2; i++) x += (c[i] as number) / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - lnGamma(a)));
  }
  // Continued fraction for Q(a, x), Lentz's method.
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let dd = 1 / b;
  let h = dd;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    dd = an * dd + b;
    if (Math.abs(dd) < 1e-300) dd = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    dd = 1 / dd;
    const del = dd * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h);
}

/** Upper tail of the chi-square distribution. */
export function chiSquareP(chi2: number, df: number): number {
  if (df <= 0) return 1;
  return 1 - gammaP(df / 2, chi2 / 2);
}

/** Share of students who got it right → difficulty, as a teacher would label it. */
export function observedDifficulty(p: number): Difficulty {
  if (p >= 0.75) return 'easy';
  if (p >= 0.4) return 'medium';
  return 'hard';
}

const MIN_SAMPLE = 5;

export interface QuestionStat {
  question_id: number;
  label: string;
  qtype: Question['qtype'];
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
  /** Students still waiting for marks (descriptive). */
  pending: number;
  /** Average share of the marks earned (bonus excluded), over students who were given it. */
  mean_fraction: number | null;
  /** Upper-lower discrimination (top 27% vs bottom 27% by total score). */
  discrimination: number | null;
  observed_difficulty: Difficulty | null;
  bank_difficulty: Difficulty | null;
  /** Set when the results disagree with the bank's rating. */
  suggested_difficulty: Difficulty | null;
  distribution: { answer: string; count: number; correct: boolean }[];
}

function statsFor(d: VersionData): QuestionStat[] {
  // Rank students by total score for discrimination.
  const ranked = [...d.attempts].sort((a, b) => (b.score ?? 0) / (b.max_score || 1) - (a.score ?? 0) / (a.max_score || 1));
  const cut = Math.max(1, Math.round(ranked.length * 0.27));
  const top = new Set(ranked.slice(0, cut).map((a) => a.id));
  const bottom = new Set(ranked.slice(Math.max(0, ranked.length - cut)).map((a) => a.id));
  const dealtBy = new Map<number, Attempt[]>();
  for (const a of d.attempts) {
    for (const qid of dealtIds(a)) {
      const list = dealtBy.get(qid) ?? [];
      list.push(a);
      dealtBy.set(qid, list);
    }
  }
  const slotBank = new Map(slotRepo.listForVersion(d.version.id).map((s) => [s.id, s.bank_id]));

  return d.questions.map((q) => {
    const takers = dealtBy.get(q.id) ?? [];
    let answered = 0;
    let correct = 0;
    let pending = 0;
    let fractionSum = 0;
    let fractionN = 0;
    const topF: number[] = [];
    const bottomF: number[] = [];
    const dist = new Map<string, { count: number; correct: boolean }>();
    for (const a of takers) {
      const raw = rawAnswer(d, a.id, q.id);
      const g = gradeQuestion({ ...q, bonus: 0, grading_mode: 'normal' }, raw, d.manual.get(a.id)?.get(q.id));
      if (!isBlank(q.qtype, raw)) answered++;
      if (g.pending) {
        pending++;
        continue;
      }
      const f = g.points > 0 ? g.earned / g.points : 0;
      if (f >= 1) correct++;
      fractionSum += f;
      fractionN++;
      if (top.has(a.id)) topF.push(f);
      if (bottom.has(a.id)) bottomF.push(f);
      if (q.qtype !== 'descriptive') {
        const key = displayAnswer(q, raw, 60);
        const entry = dist.get(key) ?? { count: 0, correct: !isBlank(q.qtype, raw) && isAnswerCorrect(q, raw) };
        entry.count++;
        dist.set(key, entry);
      }
    }
    const mean = fractionN > 0 ? fractionSum / fractionN : null;
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const discrimination = topF.length && bottomF.length ? round(avg(topF) - avg(bottomF)) : null;
    const observed = mean !== null && fractionN >= MIN_SAMPLE ? observedDifficulty(mean) : null;
    const bankQ = q.bank_question_id ? bankRepo.getQuestion(q.bank_question_id) : undefined;
    const bankDifficulty = bankQ?.difficulty ?? null;
    if (q.qtype === 'single' || q.qtype === 'multiple') {
      // Show every option, even ones nobody picked (a distractor nobody falls for is worth knowing).
      if (q.qtype === 'single') {
        q.options.forEach((_, i) => {
          const key = displayAnswer(q, i, 60);
          if (!dist.has(key)) dist.set(key, { count: 0, correct: isAnswerCorrect(q, i) });
        });
      }
    }
    return {
      question_id: q.id,
      label: d.labels.get(q.id) ?? `#${q.id}`,
      qtype: q.qtype,
      text: q.text,
      points: q.points,
      slot_id: q.slot_id ?? null,
      bank_id: q.slot_id ? slotBank.get(q.slot_id) ?? null : null,
      bank_question_id: q.bank_question_id ?? null,
      grading_mode: q.grading_mode,
      answer_text: q.qtype === 'descriptive' ? String(q.answer ?? '') : displayAnswer(q, q.answer),
      accept_also_text: q.accept_also.map((a) => displayAnswer(q, a)),
      answer: q.answer,
      accept_also: q.accept_also,
      tolerance: q.tolerance,
      options: q.options,
      bonus: q.bonus,
      dealt: takers.length,
      answered,
      correct,
      pending,
      mean_fraction: mean === null ? null : round(mean, 3),
      discrimination,
      observed_difficulty: observed,
      bank_difficulty: bankDifficulty,
      suggested_difficulty: observed && bankDifficulty && observed !== bankDifficulty ? observed : null,
      distribution: [...dist.entries()]
        .map(([answer, v]) => ({ answer, count: v.count, correct: v.correct }))
        .sort((a, b) => Number(b.correct) - Number(a.correct) || b.count - a.count)
        .slice(0, 12),
    };
  });
}

/** Item analysis for the "Questions" tab: stats, current key and regrade state for each question. */
export function questionReview(versionId: number) {
  const d = loadVersion(versionId);
  const stats = statsFor(d);
  return {
    quiz_version_id: versionId,
    graded_attempts: d.attempts.length,
    min_sample: MIN_SAMPLE,
    questions: stats.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  };
}

// ---------------------------------------------------------------- fairness of random slots

/**
 * For each random slot: how the different bank questions students drew
 * actually performed. A chi-square test says whether the gap between them is
 * bigger than chance; normalizing raises every harder variant to the easiest
 * one's average with a per-question bonus (nobody loses marks).
 */
export function fairnessReport(versionId: number) {
  const d = loadVersion(versionId);
  const stats = statsFor(d);
  const slots = slotRepo.listForVersion(versionId);
  return {
    quiz_version_id: versionId,
    graded_attempts: d.attempts.length,
    min_sample: MIN_SAMPLE,
    slots: slots.map((slot) => {
      const variants = stats
        .filter((s) => s.slot_id === slot.id && s.dealt > 0)
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      return { slot, label: (variants[0]?.label ?? 'Q?').split('·')[0], ...slotVerdict(variants), variants };
    }),
  };
}

function slotVerdict(variants: QuestionStat[]) {
  const scored = variants.filter((v) => v.mean_fraction !== null);
  const enough = scored.length >= 2 && scored.every((v) => v.dealt - v.pending >= MIN_SAMPLE);
  const means = scored.map((v) => v.mean_fraction as number);
  const best = means.length ? Math.max(...means) : 0;
  const gap = means.length >= 2 ? round(best - Math.min(...means), 3) : 0;

  // Chi-square on right/wrong × variant (objective questions only).
  let pValue: number | null = null;
  let smallCells = false;
  if (scored.length >= 2 && scored.every((v) => v.qtype !== 'descriptive')) {
    const rows = scored.map((v) => ({ right: v.correct, wrong: v.dealt - v.pending - v.correct }));
    const total = rows.reduce((s, r) => s + r.right + r.wrong, 0);
    const right = rows.reduce((s, r) => s + r.right, 0);
    if (total > 0 && right > 0 && right < total) {
      let chi2 = 0;
      for (const r of rows) {
        const n = r.right + r.wrong;
        const eRight = (n * right) / total;
        const eWrong = (n * (total - right)) / total;
        if (eRight < 5 || eWrong < 5) smallCells = true;
        chi2 += (r.right - eRight) ** 2 / eRight + (r.wrong - eWrong) ** 2 / eWrong;
      }
      pValue = round(chiSquareP(chi2, rows.length - 1), 4);
    } else {
      pValue = 1;
    }
  }
  let verdict: 'fair' | 'unfair' | 'not_enough_data' = 'fair';
  if (!enough) verdict = 'not_enough_data';
  else if (gap >= 0.15 && (pValue === null || pValue < 0.05)) verdict = 'unfair';
  return {
    verdict,
    gap,
    p_value: pValue,
    small_sample: smallCells,
    normalized: variants.some((v) => v.bonus > 0),
    proposed_bonus: Object.fromEntries(
      scored.map((v) => [v.question_id, round(Math.max(0, best - (v.mean_fraction as number)) * v.points)]),
    ) as Record<number, number>,
  };
}

/** Apply (or remove) the fairness bonus for one random slot and regrade the version. */
export function normalizeSlot(slotId: number, mode: 'raise_to_easiest' | 'clear') {
  const slot = slotRepo.get(slotId);
  if (!slot) throw new AppError(404, 'Random slot not found.');
  const report = fairnessReport(slot.quiz_version_id);
  const entry = report.slots.find((s) => s.slot.id === slot.id);
  if (!entry) throw new AppError(404, 'Random slot not found.');
  if (mode === 'raise_to_easiest' && entry.verdict === 'not_enough_data') {
    throw new AppError(409, `Each variant needs at least ${MIN_SAMPLE} graded students before it can be normalized.`);
  }
  return transaction(() => {
    const bonuses: Record<number, number> = {};
    for (const v of entry.variants) {
      const bonus = mode === 'clear' ? 0 : entry.proposed_bonus[v.question_id] ?? 0;
      questionRepo.update(v.question_id, { bonus });
      bonuses[v.question_id] = bonus;
    }
    return { bonuses, ...regradeVersion(slot.quiz_version_id) };
  });
}

// ---------------------------------------------------------------- collusion

const MAX_COLLUSION_ATTEMPTS = 2000;
const TEXT_MIN_WORDS = 12;

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (words.length < TEXT_MIN_WORDS) return out;
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * P(X ≥ k) where X is a sum of independent Bernoulli(p_i) — the exact chance
 * of at least k matches when each question matches with its own probability.
 */
export function poissonBinomialTail(ps: number[], k: number): number {
  if (k <= 0) return 1;
  if (k > ps.length) return 0;
  let dist = new Float64Array(ps.length + 1);
  dist[0] = 1;
  ps.forEach((p, n) => {
    const next = new Float64Array(ps.length + 1);
    for (let x = 0; x <= n; x++) {
      const v = dist[x] as number;
      if (!v) continue;
      next[x] = (next[x] as number) + v * (1 - p);
      next[x + 1] = (next[x + 1] as number) + v * p;
    }
    dist = next;
  });
  let tail = 0;
  for (let x = k; x <= ps.length; x++) tail += dist[x] as number;
  return Math.min(1, Math.max(0, tail));
}

/**
 * Answer-copying check. Two students who both get a question wrong usually
 * pick different wrong answers; matching wrong answers — especially rare ones
 * — are the classic sign of copying. For each pair, on every question both got
 * wrong, the chance that the second student happens to pick the first one's
 * wrong answer is how popular that wrong answer was among everyone else who
 * got it wrong. The exact probability of at least the observed number of
 * matches is then corrected for the number of pairs tested (Bonferroni), so a
 * large class does not produce false alarms by sheer number of pairs.
 * Written answers are compared for near-identical text. Supporting evidence
 * (same network, saving the same answers at the same moments) is reported but
 * never decides on its own. The result is a list to look into, not a verdict.
 */
export function collusionReport(versionId: number) {
  const d = loadVersion(versionId);
  const attempts = d.attempts;
  const n = attempts.length;
  if (n > MAX_COLLUSION_ATTEMPTS) {
    throw new AppError(413, `The collusion check handles up to ${MAX_COLLUSION_ATTEMPTS} attempts per version.`);
  }
  const pairCount = (n * (n - 1)) / 2;
  const idx = (i: number, j: number) => (i * (2 * n - i - 1)) / 2 + (j - i - 1);
  const shared = new Uint16Array(Math.max(1, pairCount));
  const textMatches = new Map<number, { question_id: number; similarity: number }[]>();
  const dealtSets = attempts.map((a) => new Set(dealtIds(a)));
  /** attempt index → question id → wrong-answer key */
  const wrongKeys = attempts.map(() => new Map<number, string>());
  /** question id → { wrong-answer key → how many chose it, total wrong } */
  const popularity = new Map<number, { freq: Map<string, number>; wrong: number }>();
  let questionsUsed = 0;

  for (const q of d.questions) {
    if (q.grading_mode === 'dropped') continue;
    const takers: number[] = [];
    attempts.forEach((_, i) => {
      if (dealtSets[i]?.has(q.id)) takers.push(i);
    });
    if (takers.length < 2) continue;

    if (q.qtype === 'descriptive') {
      const texts = takers
        .map((i) => ({ i, s: shingles(String(rawAnswer(d, (attempts[i] as Attempt).id, q.id) ?? '')) }))
        .filter((t) => t.s.size > 0);
      for (let x = 0; x < texts.length; x++) {
        for (let y = x + 1; y < texts.length; y++) {
          const tx = texts[x] as { i: number; s: Set<string> };
          const ty = texts[y] as { i: number; s: Set<string> };
          const sim = jaccard(tx.s, ty.s);
          if (sim < 0.6) continue;
          const k = tx.i < ty.i ? idx(tx.i, ty.i) : idx(ty.i, tx.i);
          const list = textMatches.get(k) ?? [];
          list.push({ question_id: q.id, similarity: round(sim, 2) });
          textMatches.set(k, list);
        }
      }
      if (texts.length >= 2) questionsUsed++;
      continue;
    }

    // Wrong answers, grouped by what was chosen/typed.
    const groups = new Map<string, number[]>();
    let wrong = 0;
    for (const i of takers) {
      const raw = rawAnswer(d, (attempts[i] as Attempt).id, q.id);
      if (isBlank(q.qtype, raw) || isAnswerCorrect(q, raw)) continue;
      const key = JSON.stringify(normalizeUserAnswer(q.qtype, raw));
      (wrongKeys[i] as Map<number, string>).set(q.id, key);
      const g = groups.get(key) ?? [];
      g.push(i);
      groups.set(key, g);
      wrong++;
    }
    if (wrong < 2) continue;
    questionsUsed++;
    popularity.set(q.id, { freq: new Map([...groups].map(([k, g]) => [k, g.length])), wrong });
    for (const g of groups.values()) {
      for (let x = 0; x < g.length; x++) {
        for (let y = x + 1; y < g.length; y++) {
          const k = idx(g[x] as number, g[y] as number); // takers are in ascending order
          shared[k] = (shared[k] as number) + 1;
        }
      }
    }
  }

  /** Per-question chance that j matches i's wrong answer (and vice versa), averaged. */
  const matchChances = (i: number, j: number): number[] => {
    const ps: number[] = [];
    for (const [qid, ki] of wrongKeys[i] as Map<number, string>) {
      const kj = (wrongKeys[j] as Map<number, string>).get(qid);
      if (kj === undefined) continue;
      const pop = popularity.get(qid);
      if (!pop || pop.wrong < 2) continue;
      // Popularity among the *other* wrong answerers, so a pair is not its own evidence.
      const others = pop.wrong - 1;
      const pi = ((pop.freq.get(ki) ?? 1) - 1) / others;
      const pj = ((pop.freq.get(kj) ?? 1) - 1) / others;
      ps.push(Math.min(1, Math.max(1 / (pop.wrong * 4), (pi + pj) / 2)));
    }
    return ps;
  };

  type Pair = { i: number; j: number; level: 'high' | 'medium' | 'low'; p: number; adjusted: number; ps: number[] };
  const found: Pair[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const k = idx(i, j);
      const s = shared[k] as number;
      const texts = textMatches.get(k);
      if (s < 3 && !texts) continue;
      const ps = s >= 3 ? matchChances(i, j) : [];
      const p = s >= 3 ? poissonBinomialTail(ps, s) : 1;
      const adjusted = Math.min(1, p * pairCount);
      const bestText = texts ? Math.max(...texts.map((t) => t.similarity)) : 0;
      let level: Pair['level'] | null = null;
      if (adjusted < 0.001 || bestText >= 0.8) level = 'high';
      else if (adjusted < 0.05 || bestText >= 0.6) level = 'medium';
      else if (p < 0.001) level = 'low';
      if (level) found.push({ i, j, level, p, adjusted, ps });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  found.sort((a, b) => order[a.level] - order[b.level] || a.p - b.p);

  const userCache = new Map<number, { name: string; entry_number: string | null }>();
  const who = (a: Attempt) => {
    if (!userCache.has(a.user_id)) {
      const u = userRepo.findById(a.user_id);
      userCache.set(a.user_id, { name: u?.name ?? '', entry_number: u?.entry_number ?? null });
    }
    return {
      attempt_id: a.id,
      ...(userCache.get(a.user_id) as { name: string; entry_number: string | null }),
      score: a.score,
      max_score: a.max_score,
    };
  };

  const pairs = found.slice(0, 100).map(({ i, j, level, p, adjusted, ps }) => {
    const a = attempts[i] as Attempt;
    const b = attempts[j] as Attempt;
    const k = idx(i, j);
    const sharedQuestions: { question_id: number; label: string; answer: string }[] = [];
    let closeSaves = 0;
    for (const [qid, key] of wrongKeys[i] as Map<number, string>) {
      if ((wrongKeys[j] as Map<number, string>).get(qid) !== key) continue;
      const q = d.byId.get(qid) as Question;
      sharedQuestions.push({ question_id: qid, label: d.labels.get(qid) ?? `#${qid}`, answer: displayAnswer(q, rawAnswer(d, a.id, qid), 80) });
      const sa = d.answers.get(a.id)?.get(qid)?.saved_at;
      const sb = d.answers.get(b.id)?.get(qid)?.saved_at;
      if (sa && sb && Math.abs(toMs(sa) - toMs(sb)) <= 30_000) closeSaves++;
    }
    sharedQuestions.sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
    const ips = (x: Attempt) => new Set([x.start_ip, x.last_ip].filter((v): v is string => Boolean(v)));
    const ipsA = ips(a);
    const sameNetwork = [...ips(b)].some((ip) => ipsA.has(ip));
    const submittedGap =
      a.submitted_at && b.submitted_at ? Math.round(Math.abs(toMs(a.submitted_at) - toMs(b.submitted_at)) / 1000) : null;
    const bothWrong = [...(wrongKeys[i] as Map<number, string>).keys()].filter((qid) => (wrongKeys[j] as Map<number, string>).has(qid)).length;
    return {
      a: who(a),
      b: who(b),
      level,
      shared_wrong: shared[k] as number,
      both_wrong: bothWrong,
      expected_by_chance: round(ps.reduce((s, x) => s + x, 0), 2),
      p_value: p,
      adjusted_p: adjusted,
      shared_questions: sharedQuestions,
      text_matches: (textMatches.get(k) ?? []).map((t) => ({ ...t, label: d.labels.get(t.question_id) ?? `#${t.question_id}` })),
      same_network: sameNetwork,
      close_saves: closeSaves,
      submitted_gap_seconds: submittedGap,
    };
  });

  return {
    quiz_version_id: versionId,
    analysed_attempts: n,
    pairs_checked: pairCount,
    questions_used: questionsUsed,
    flagged: found.length,
    pairs,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- appeals

const MAX_APPEALS = 10;

/** Student raises an appeal about a mark or an integrity decision on their attempt. */
export function createAppeal(userId: number, attemptId: number, body: { kind?: unknown; question_id?: unknown; message?: unknown }) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  if (attempt.user_id !== userId) throw new AppError(403, 'Not your attempt.');
  const kind = String(body.kind ?? '') as AppealKind;
  if (kind !== 'grading' && kind !== 'integrity') throw new AppError(400, "kind must be 'grading' or 'integrity'.");
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length < 10) throw new AppError(400, 'Explain your appeal in at least 10 characters.');
  if (message.length > 2000) throw new AppError(400, 'Appeals are limited to 2000 characters.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);

  let questionId: number | null = null;
  if (kind === 'grading') {
    if (!scoreVisible(attempt, version)) {
      throw new AppError(409, 'You can appeal a mark once your result has been released.');
    }
    if (body.question_id !== undefined && body.question_id !== null && body.question_id !== '') {
      questionId = Number(body.question_id);
      if (!dealtIds(attempt).includes(questionId)) throw new AppError(400, 'That question is not on your paper.');
    }
  } else {
    const hasCase =
      attempt.status === 'locked' ||
      attempt.status === 'under_review' ||
      attempt.violation_count > 0 ||
      manualFlagsForAttempt(attempt.id).length > 0 ||
      attempt.finalize_reason === 'violation_limit' ||
      attempt.finalize_reason === 'reentry';
    if (!hasCase) throw new AppError(409, 'There is no integrity decision on this attempt to appeal.');
    if (attempt.status === 'in_progress') throw new AppError(409, 'Finish the attempt first.');
  }
  if (appealRepo.openDuplicate(attempt.id, kind, questionId)) {
    throw new AppError(409, 'You already have an open appeal about this.');
  }
  if (appealRepo.count(attempt.id) >= MAX_APPEALS) throw new AppError(429, 'Appeal limit reached for this attempt.');
  const id = appealRepo.add(attempt.id, userId, kind, questionId, message);
  policyRepo.log(attempt.id, 'appeal_filed', `${kind === 'grading' ? 'Mark' : 'Integrity'} appeal: ${message.slice(0, 160)}`, 'server');
  return appealRepo.get(id) as Appeal;
}

/** Appeals for a version with the context needed to decide them. */
export function appealsForVersion(versionId: number) {
  const d = loadVersion(versionId);
  const all = appealRepo.listForVersion(versionId);
  return {
    appeals: all.map((ap) => {
      const attempt = attemptRepo.get(ap.attempt_id) as Attempt;
      const q = ap.question_id ? d.byId.get(ap.question_id) : undefined;
      const row = ap.question_id ? answerRepo.getForQuestion(ap.attempt_id, ap.question_id) : undefined;
      const raw = row ? jsonParse<unknown>(row.answer, null) : null;
      const manual = ap.question_id ? manualGradeRepo.forAttempt(ap.attempt_id).get(ap.question_id) : undefined;
      return {
        ...ap,
        attempt: {
          id: attempt.id,
          status: attempt.status,
          score: attempt.score,
          max_score: attempt.max_score,
          violation_count: attempt.violation_count,
          lock_reason: attempt.lock_reason,
          finalize_reason: attempt.finalize_reason,
        },
        question: q
          ? {
              id: q.id,
              label: d.labels.get(q.id) ?? `#${q.id}`,
              text: q.text,
              qtype: q.qtype,
              points: q.points,
              answer_text: q.qtype === 'descriptive' ? String(q.answer ?? '') : displayAnswer(q, q.answer),
              student_answer: displayAnswer(q, raw, 4000),
              assumption: row?.assumption ?? null,
              earned: gradeQuestion(q, raw, manual).earned,
            }
          : null,
        open_flags: manualFlagsForAttempt(ap.attempt_id).filter((f) => !f.resolved_at).length,
      };
    }),
    open: all.filter((a) => a.status === 'open').length,
  };
}

/**
 * Decide an appeal. Accepting a mark appeal may set new marks for the
 * question; accepting an integrity appeal resolves the open staff flags on the
 * attempt (reinstating a locked attempt stays a separate, explicit ruling).
 */
export function resolveAppeal(
  actorId: number,
  appealId: number,
  body: { status?: unknown; response?: unknown; marks?: unknown },
) {
  const appeal = appealRepo.get(appealId);
  if (!appeal) throw new AppError(404, 'Appeal not found.');
  if (appeal.status !== 'open') throw new AppError(409, 'This appeal has already been decided.');
  const status = String(body.status ?? '');
  if (status !== 'accepted' && status !== 'rejected') throw new AppError(400, "status must be 'accepted' or 'rejected'.");
  const response = typeof body.response === 'string' ? body.response.trim() : '';
  if (status === 'rejected' && !response) throw new AppError(400, 'Tell the student why the appeal was rejected.');
  if (response.length > 2000) throw new AppError(400, 'Responses are limited to 2000 characters.');
  return transaction(() => {
    let regraded: ReturnType<typeof setManualMarks> | null = null;
    if (status === 'accepted' && appeal.kind === 'grading' && body.marks !== undefined && body.marks !== null && body.marks !== '') {
      if (!appeal.question_id) throw new AppError(400, 'This appeal is not about a single question.');
      regraded = setManualMarks(actorId, appeal.attempt_id, appeal.question_id, Number(body.marks), response);
    }
    if (status === 'accepted' && appeal.kind === 'integrity') {
      for (const f of manualFlagsForAttempt(appeal.attempt_id)) {
        if (!f.resolved_at) resolveFlag(actorId, f.id, `Appeal accepted: ${response || 'no reason given'}`);
      }
      reviewRepo.add(appeal.attempt_id, actorId, 'appeal_accepted', response || null);
    }
    appealRepo.resolve(appeal.id, status, response || null, actorId);
    policyRepo.log(appeal.attempt_id, `appeal_${status}`, response.slice(0, 160) || null, 'instructor');
    return { appeal: appealRepo.get(appeal.id), regraded };
  });
}

// ---------------------------------------------------------------- live question health + hands

/**
 * During the exam: which questions look broken. A question nearly nobody gets
 * right usually has a wrong key or confusing wording; many answer changes or
 * many students asking about it point the same way. Computed on demand for
 * the monitor's Questions tab (not on every 5-second refresh).
 */
export function questionHealth(quizId: number) {
  const quiz = quizRepo.get(quizId);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const version = quizVersionRepo.latestPublished(quiz.id);
  if (!version) return { quiz_id: quizId, questions: [] };
  const questions = questionRepo.listForVersion(version.id);
  const labels = paperLabels(version.id, questions);
  const attempts = attemptRepo.listForVersion(version.id).filter((a) => a.status !== 'reinstated');
  const finished = new Set(attempts.filter((a) => GRADED.includes(a.status as (typeof GRADED)[number])).map((a) => a.id));
  const dealt = new Map<number, number[]>();
  for (const a of attempts) {
    for (const qid of dealtIds(a)) {
      const list = dealt.get(qid) ?? [];
      list.push(a.id);
      dealt.set(qid, list);
    }
  }
  const answers = new Map<string, AnswerRevision>();
  for (const row of answerRepo.listForVersion(version.id)) answers.set(`${row.attempt_id}:${row.question_id}`, row);
  const asked = handRepo.openCountsByQuestion(quiz.id);

  const rows = questions
    .filter((q) => (dealt.get(q.id)?.length ?? 0) > 0 || !q.slot_id)
    .map((q) => {
      const takers = dealt.get(q.id) ?? [];
      let answered = 0;
      let correct = 0;
      let changes = 0;
      let finishedTakers = 0;
      let finishedBlank = 0;
      for (const attemptId of takers) {
        const row = answers.get(`${attemptId}:${q.id}`);
        const raw = row ? jsonParse<unknown>(row.answer, null) : null;
        const blank = isBlank(q.qtype, raw);
        if (finished.has(attemptId)) {
          finishedTakers++;
          if (blank) finishedBlank++;
        }
        if (blank) continue;
        answered++;
        // Each click on a choice bumps the revision; typed answers bump it per keystroke, so only choices count.
        if (q.qtype === 'single' || q.qtype === 'multiple') changes += Math.max(0, (row?.revision ?? 1) - 1);
        if (q.qtype !== 'descriptive' && isAnswerCorrect(q, raw)) correct++;
      }
      const warnings: string[] = [];
      const objective = q.qtype !== 'descriptive';
      if (objective && answered >= 8 && correct / answered <= 0.15) {
        warnings.push(`Only ${correct} of ${answered} correct — check the answer key and the wording.`);
      }
      if (finishedTakers >= 8 && finishedBlank / finishedTakers >= 0.4) {
        warnings.push(`${finishedBlank} of ${finishedTakers} finished students left it blank.`);
      }
      if ((q.qtype === 'single' || q.qtype === 'multiple') && answered >= 8 && changes / answered >= 2) {
        warnings.push('Students keep changing their answer — it may be ambiguous.');
      }
      const questionsAsked = asked.get(q.id) ?? 0;
      if (questionsAsked >= 2) warnings.push(`${questionsAsked} students raised a hand about it.`);
      return {
        question_id: q.id,
        label: labels.get(q.id) ?? `#${q.id}`,
        qtype: q.qtype,
        text: q.text,
        dealt: takers.length,
        answered,
        correct: objective ? correct : null,
        correct_rate: objective && answered ? round(correct / answered, 3) : null,
        changes_per_answer: answered ? round(changes / answered, 2) : 0,
        hands: questionsAsked,
        warnings,
      };
    })
    .sort((a, b) => b.warnings.length - a.warnings.length || a.label.localeCompare(b.label, undefined, { numeric: true }));
  return { quiz_id: quizId, quiz_version_id: version.id, questions: rows };
}

export function handsForQuiz(quizId: number) {
  const quiz = quizRepo.get(quizId);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const hands = handRepo.listForQuiz(quizId);
  const labelCache = new Map<number, Map<number, string>>();
  return {
    hands: hands.map((h) => {
      let label: string | null = null;
      if (h.question_id) {
        const q = questionRepo.get(h.question_id);
        if (q) {
          if (!labelCache.has(q.quiz_version_id)) labelCache.set(q.quiz_version_id, paperLabels(q.quiz_version_id));
          label = labelCache.get(q.quiz_version_id)?.get(q.id) ?? null;
        }
      }
      return { ...h, broadcast: Boolean(h.broadcast), question_label: label };
    }),
    open: hands.filter((h) => h.status === 'open').length,
  };
}

/**
 * Answer a raised hand: privately (a personal message pinned to the question)
 * or to everyone given that question (a clarification), or dismiss it.
 */
export function answerHand(actorId: number, handId: number, body: { reply?: unknown; broadcast?: unknown; dismiss?: unknown }) {
  const hand = handRepo.get(handId);
  if (!hand) throw new AppError(404, 'Question not found.');
  if (hand.status !== 'open') throw new AppError(409, 'This question has already been handled.');
  if (body.dismiss) {
    handRepo.resolve(hand.id, 'dismissed', null, false, actorId);
    return { hand: handRepo.get(hand.id) };
  }
  const reply = typeof body.reply === 'string' ? body.reply.trim() : '';
  if (!reply) throw new AppError(400, 'Write a reply.');
  if (reply.length > 1000) throw new AppError(400, 'Replies are limited to 1000 characters.');
  const broadcast = Boolean(body.broadcast);
  return transaction(() => {
    const quoted = hand.message.length > 80 ? `${hand.message.slice(0, 80)}…` : hand.message;
    announcementRepo.add(
      hand.quiz_id,
      broadcast ? null : hand.user_id,
      broadcast ? reply : `You asked: “${quoted}” — ${reply}`,
      actorId,
      hand.question_id,
    );
    handRepo.resolve(hand.id, 'answered', reply, broadcast, actorId);
    return { hand: handRepo.get(hand.id) };
  });
}
