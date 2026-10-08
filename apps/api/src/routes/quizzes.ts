import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import {
  quizRepo,
  quizVersionRepo,
  questionRepo,
  attemptRepo,
  bankRepo,
  slotRepo,
} from '../repo.js';
import { extensionRepo } from '../exam-repo.js';
import type { CourseRole, Difficulty, QuizVersion } from '../types.js';
import { assertStaff, assertMember, assertInstructor, writeAudit } from '../authz.js';
import { addSecondsTo, dateToUtc } from '../util.js';
import { scoreVisible } from '../services/finalize.js';
import { parseTimeLimit, validateQuestionData } from '../services/question-validation.js';
import {
  applyPreset,
  isPreset,
  legacyPolicyOf,
  normalizeSettings,
  presetOf,
  publicSettings,
  resolveSettings,
  studentRules,
  withLegacyPolicy,
} from '../services/exam-settings.js';

export const quizzesRouter = Router();

quizzesRouter.use(requireAuth);

function versionDetail(versionId: number, viewerId: number, role: CourseRole | 'admin') {
  const version = quizVersionRepo.get(versionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  const isStaff = role !== 'student';
  const quiz = quizRepo.get(version.quiz_id);
  const questions = questionRepo.listAuthored(versionId);
  const slots = slotRepo.listForVersion(versionId);
  const questionCount = questions.length + slots.length;
  const settings = resolveSettings(version);
  const legacy = legacyPolicyOf(settings);
  // Students only ever see the class-wide window close plus their own extensions.
  const windowExtra = extensionRepo.totals(version.quiz_id, viewerId).window;
  const windowCloses =
    version.quiz_type === 'scheduled' && version.window_opens_at && version.window_duration_minutes
      ? addSecondsTo(version.window_opens_at, version.window_duration_minutes * 60 + windowExtra)
      : null;
  return {
    id: version.id,
    quiz_id: version.quiz_id,
    version: version.version,
    status: version.status,
    title: version.title,
    instructions: version.instructions,
    duration_minutes: version.duration_minutes,
    shuffle_questions: version.shuffle_questions,
    shuffle_options: version.shuffle_options,
    attempts_allowed: version.attempts_allowed,
    integrity_policy: legacy.integrity_policy,
    policy_trigger: legacy.policy_trigger,
    show_scores: version.show_scores,
    quiz_type: version.quiz_type,
    window_opens_at: version.window_opens_at,
    window_duration_minutes: version.window_duration_minutes,
    window_closes_at: windowCloses,
    published_at: version.published_at,
    created_at: version.created_at,
    question_count: questionCount,
    total_points: questions.reduce((sum, q) => sum + q.points, 0) + slots.reduce((sum, sl) => sum + sl.points, 0),
    exam_settings: isStaff ? settings : publicSettings(settings),
    preset: presetOf(settings),
    rules: studentRules(settings, {
      duration_minutes: version.duration_minutes,
      question_count: questionCount,
      quiz_type: version.quiz_type,
    }),
    paused: Boolean(quiz?.paused_at),
    closed: Boolean(quiz?.closed_at),
    // Question content never reaches students outside an attempt (no previews before the exam opens).
    questions: isStaff
      ? questions.map((q) => ({
          id: q.id,
          qtype: q.qtype,
          text: q.text,
          options: q.options,
          points: q.points,
          order_index: q.order_index,
          answer: q.answer,
          tolerance: q.tolerance,
          time_limit_seconds: q.time_limit_seconds,
          allow_assumptions: Boolean(q.allow_assumptions),
          grading_mode: q.grading_mode,
          accept_also: q.accept_also,
        }))
      : [],
    // Random slots: a different bank question for each student (staff only).
    slots: isStaff ? slots.map(slotView) : [],
    attempts: isStaff ? summarizeAttemptsForVersion(versionId) : undefined,
    my_attempts: summarizeAttempts(viewerId, version),
  };
}

function slotView(slot: ReturnType<typeof slotRepo.listForVersion>[number]) {
  const bank = bankRepo.get(slot.bank_id);
  return {
    ...slot,
    bank_name: bank?.name ?? '(deleted bank)',
    pool_size: bank ? bankRepo.pool(slot.bank_id, slot.difficulty, slot.tag).length : 0,
  };
}

/**
 * Can every student get a distinct question for every slot? Slots sharing a
 * bank and filter need that many matching questions; slots sharing a bank need
 * that many questions in total. Returns human-readable problems.
 */
function poolProblems(versionId: number): string[] {
  const problems: string[] = [];
  const slots = slotRepo.listForVersion(versionId);
  const groups = new Map<string, { need: number; have: number; label: string }>();
  const perBank = new Map<number, number>();
  for (const sl of slots) {
    const key = `${sl.bank_id}|${sl.difficulty ?? ''}|${(sl.tag ?? '').toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.need++;
    else {
      const bank = bankRepo.get(sl.bank_id);
      groups.set(key, {
        need: 1,
        have: bank ? bankRepo.pool(sl.bank_id, sl.difficulty, sl.tag).length : 0,
        label: `${sl.difficulty ?? 'any'}${sl.tag ? ` “${sl.tag}”` : ''} questions in “${bank?.name ?? 'a deleted bank'}”`,
      });
    }
    perBank.set(sl.bank_id, (perBank.get(sl.bank_id) ?? 0) + 1);
  }
  for (const g of groups.values()) {
    if (g.need > g.have) problems.push(`${g.need} random slots need ${g.label}, but only ${g.have} exist.`);
  }
  for (const [bankId, need] of perBank) {
    const have = bankRepo.listQuestions(bankId).length;
    if (need > have) problems.push(`${need} random slots draw from “${bankRepo.get(bankId)?.name ?? bankId}”, which has only ${have} questions.`);
  }
  return problems;
}

/** The viewer's own attempts on this quiz, across every version. Scores only once visible. */
function summarizeAttempts(userId: number, version: QuizVersion) {
  const rows = attemptRepo.listForUserAcrossQuiz(userId, version.quiz_id);
  const versions = new Map<number, QuizVersion | undefined>();
  const versionOf = (id: number) => {
    if (!versions.has(id)) versions.set(id, quizVersionRepo.get(id));
    return versions.get(id);
  };
  const open = rows.find((a) => a.status === 'in_progress');
  const locked = rows.find((a) => a.status === 'locked' || a.status === 'under_review');
  const visibleScores = rows
    .filter((a) => a.score != null && scoreVisible(a, versionOf(a.quiz_version_id)))
    .map((a) => a.score as number);
  return {
    count: rows.length,
    in_progress: open ? open.id : null,
    locked: locked ? locked.id : null,
    best_score: visibleScores.length ? Math.max(...visibleScores) : null,
    last_status: rows[0]?.status ?? null,
    last_attempt_id: rows[0]?.id ?? null,
    last_receipt: rows.find((a) => a.receipt)?.receipt ?? null,
  };
}

function summarizeAttemptsForVersion(versionId: number) {
  const rows = attemptRepo.listForVersion(versionId);
  const statuses = rows.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  const submittedScores = rows
    .filter((a) => typeof a.score === 'number')
    .map((a) => a.score as number);
  return {
    total: rows.length,
    statuses,
    avg_score: submittedScores.length
      ? submittedScores.reduce((s, x) => s + x, 0) / submittedScores.length
      : null,
    best: submittedScores.length ? Math.max(...submittedScores) : null,
  };
}

// --------------------------------------------------------------------- list

quizzesRouter.get('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const role = assertMember(req, courseId); // Allow students to view quizzes
  const isStaff = role !== 'student';

  const quizzes = quizRepo.listForCourse(courseId).map((quiz) => {
    const versions = quizVersionRepo.listForQuiz(quiz.id);
    const published = quizVersionRepo.latestPublished(quiz.id);
    const draft = versions.find((v) => v.status === 'draft');
    return {
      quiz_id: quiz.id,
      published: published ? versionDetail(published.id, req.userId as number, role) : null,
      draft: isStaff && draft ? versionDetail(draft.id, req.userId as number, role) : null,
    };
  });

  res.json({ quizzes: isStaff ? quizzes : quizzes.filter((q) => q.published) });
});

// ------------------------------------------------------------------- create

quizzesRouter.post('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const role = assertStaff(req, courseId);
  const quizId = quizRepo.create(courseId, req.userId as number);
  const versionId = quizVersionRepo.createDraft(quizId, courseId, req.userId as number, 1);
  res.status(201).json(versionDetail(versionId, req.userId as number, role));
});

// ------------------------------------------------------------------- detail

/**
 * Staff get every version with full content. Students get the live version's
 * preflight information (rules, timing, their attempts) — never the questions.
 */
quizzesRouter.get('/:quizId', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertMember(req, quiz.course_id);
  if (role === 'student') {
    const published = quizVersionRepo.latestPublished(quiz.id);
    if (!published) throw new AppError(404, 'This quiz is not published yet.');
    res.json({
      quiz_id: quiz.id,
      course_id: quiz.course_id,
      versions: [versionDetail(published.id, req.userId as number, role)],
    });
    return;
  }
  const versions = quizVersionRepo.listForQuiz(quiz.id).map((v) => versionDetail(v.id, req.userId as number, role));
  res.json({ quiz_id: quiz.id, course_id: quiz.course_id, paused_at: quiz.paused_at, closed_at: quiz.closed_at, versions });
});

// ------------------------------------------------------------------- update meta

quizzesRouter.put('/:quizId', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft || draft.status !== 'draft') {
    throw new AppError(409, 'Only the latest draft version can be edited. Create a new draft version.');
  }
  const body = req.body ?? {};
  if (body.title !== undefined) {
    if (!String(body.title).trim()) throw new AppError(400, 'Title cannot be empty.');
    if (String(body.title).length > 200) throw new AppError(400, 'Title must be at most 200 characters.');
  }
  if (body.instructions !== undefined && String(body.instructions).length > 20_000) {
    throw new AppError(400, 'Instructions must be at most 20,000 characters.');
  }
  if (body.duration_minutes !== undefined && body.duration_minutes !== null) {
    const m = Number(body.duration_minutes);
    if (!Number.isFinite(m) || m < 1 || m > 1440) throw new AppError(400, 'Duration must be 1–1440 minutes or off.');
  }
  if (body.attempts_allowed !== undefined) {
    const n = Number(body.attempts_allowed);
    if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'Attempts must be a positive integer.');
  }
  if (body.integrity_policy !== undefined && !['off', 'warn', 'strict'].includes(body.integrity_policy)) {
    throw new AppError(400, 'Invalid integrity policy.');
  }
  if (body.policy_trigger !== undefined && !['focus_exit', 'page_hidden'].includes(body.policy_trigger)) {
    throw new AppError(400, 'Invalid policy trigger.');
  }
  if (body.show_scores !== undefined && !['never', 'release', 'immediate'].includes(body.show_scores)) {
    throw new AppError(400, 'Invalid show-scores policy.');
  }
  if (body.quiz_type !== undefined && !['anytime', 'scheduled'].includes(body.quiz_type)) {
    throw new AppError(400, 'Invalid quiz type.');
  }
  // Determine the effective quiz_type after this update to validate the window.
  const effectiveType = body.quiz_type !== undefined ? body.quiz_type : draft.quiz_type;
  let windowOpensAt: string | null | undefined;
  let windowDuration: number | null | undefined;
  if (body.window_opens_at !== undefined) {
    if (body.window_opens_at === null || body.window_opens_at === '') {
      windowOpensAt = null;
    } else {
      const t = new Date(String(body.window_opens_at));
      if (Number.isNaN(t.getTime())) throw new AppError(400, 'Window start time is not a valid date.');
      windowOpensAt = dateToUtc(String(body.window_opens_at));
    }
  }
  if (body.window_duration_minutes !== undefined) {
    if (body.window_duration_minutes === null || body.window_duration_minutes === '') {
      windowDuration = null;
    } else {
      const w = Number(body.window_duration_minutes);
      if (!Number.isInteger(w) || w < 1) throw new AppError(400, 'Window duration must be a positive integer.');
      windowDuration = w;
    }
  }
  if (effectiveType === 'scheduled') {
    const finalOpens = windowOpensAt !== undefined ? windowOpensAt : draft.window_opens_at;
    const finalDur = windowDuration !== undefined ? windowDuration : draft.window_duration_minutes;
    if (!finalOpens) throw new AppError(400, 'Scheduled quizzes need a window start time.');
    if (!finalDur) throw new AppError(400, 'Scheduled quizzes need a window duration.');
  }

  // Exam settings: explicit settings (optionally starting from a preset) win; an
  // old client that only sends integrity_policy gets that policy's rules overlaid.
  let settingsJson: string | undefined;
  let legacy: ReturnType<typeof legacyPolicyOf> | undefined;
  const current = resolveSettings(draft);
  if (body.preset !== undefined && !isPreset(body.preset)) throw new AppError(400, 'Unknown preset.');
  if (body.exam_settings !== undefined || isPreset(body.preset)) {
    const base = isPreset(body.preset) ? applyPreset(current, body.preset) : current;
    const next = normalizeSettings(body.exam_settings ?? {}, base);
    settingsJson = JSON.stringify(next);
    legacy = legacyPolicyOf(next);
  } else if (body.integrity_policy !== undefined) {
    const next = withLegacyPolicy(current, body.integrity_policy, body.policy_trigger ?? draft.policy_trigger);
    settingsJson = JSON.stringify(next);
    legacy = { integrity_policy: body.integrity_policy, policy_trigger: body.policy_trigger ?? draft.policy_trigger };
  }

  quizVersionRepo.updateMeta(draft.id, {
    title: body.title !== undefined ? String(body.title) : undefined,
    instructions: body.instructions !== undefined ? String(body.instructions) : undefined,
    duration_minutes: body.duration_minutes !== undefined
      ? body.duration_minutes === null
        ? null
        : Number(body.duration_minutes)
      : undefined,
    shuffle_questions: body.shuffle_questions !== undefined ? Number(Boolean(body.shuffle_questions)) : undefined,
    shuffle_options: body.shuffle_options !== undefined ? Number(Boolean(body.shuffle_options)) : undefined,
    attempts_allowed: body.attempts_allowed !== undefined ? Number(body.attempts_allowed) : undefined,
    integrity_policy: legacy?.integrity_policy,
    policy_trigger: legacy?.policy_trigger,
    show_scores: body.show_scores,
    quiz_type: body.quiz_type,
    window_opens_at: windowOpensAt,
    window_duration_minutes: windowDuration,
    exam_settings: settingsJson,
  });
  res.json(versionDetail(draft.id, req.userId as number, role));
});

// ------------------------------------------------------------------- versioning

quizzesRouter.post('/:quizId/versions', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const newDraft = quizVersionRepo.clonePublished(quiz.id, req.userId as number);
  res.status(201).json(versionDetail(newDraft.id, req.userId as number, role));
});

// --------------------------------------------------------- restore a version (item 6)

quizzesRouter.post('/:quizId/versions/:version/restore', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const sourceVersion = Number(req.params.version);
  const src = quizVersionRepo.getByVersion(quiz.id, sourceVersion);
  if (!src) throw new AppError(404, 'That version does not exist.');
  const newDraft = quizVersionRepo.restoreVersion(quiz.id, sourceVersion, req.userId as number);
  writeAudit(req, {
    action: 'quiz.version.restore',
    course_id: quiz.course_id,
    target: 'quiz:' + quiz.id,
    after: { restored_from: sourceVersion, new_version: newDraft.version },
  });
  res.status(201).json(versionDetail(newDraft.id, req.userId as number, role));
});

// --------------------------------------------------------- copy a quiz (item 9)

quizzesRouter.post('/:quizId/copy', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const newQuizId = quizRepo.copy(quiz.id, req.userId as number);
  const newDraft = quizVersionRepo.latest(newQuizId);
  writeAudit(req, {
    action: 'quiz.copy',
    course_id: quiz.course_id,
    target: 'quiz:' + quiz.id,
    after: { new_quiz: newQuizId },
  });
  res.status(201).json(versionDetail((newDraft as NonNullable<typeof newDraft>).id, req.userId as number, role));
});

// --------------------------------------------------------- delete a quiz (item 10)

quizzesRouter.delete('/:quizId', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  assertInstructor(req, quiz.course_id);
  quizRepo.delete(quiz.id);
  writeAudit(req, { action: 'quiz.delete', course_id: quiz.course_id, target: 'quiz:' + quiz.id });
  res.json({ ok: true });
});

// ------------------------------------------------------------------- publish

quizzesRouter.patch('/:quizId/publish', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertInstructor(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft || draft.status !== 'draft') throw new AppError(409, 'No draft version to publish.');
  const itemCount = questionRepo.countForVersion(draft.id);
  if (itemCount === 0) throw new AppError(400, 'Add at least one question before publishing.');
  const problems = poolProblems(draft.id);
  if (problems.length) throw new AppError(400, `Not enough bank questions: ${problems.join(' ')}`);
  const settings = resolveSettings(draft);
  if (settings.questions_per_attempt !== null && settings.questions_per_attempt > itemCount) {
    throw new AppError(
      400,
      `The random draw (${settings.questions_per_attempt} per student) is larger than the ${itemCount} questions in this quiz.`,
    );
  }
  quizVersionRepo.publish(draft.id);
  writeAudit(req, { action: 'quiz.publish', course_id: quiz.course_id, target: 'quiz:' + quiz.id });
  res.json(versionDetail(draft.id, req.userId as number, role));
});

// ------------------------------------------------------------------- questions

function editableDraft(req: AuthedRequest, quizId: number) {
  const quiz = quizRepo.get(quizId);
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft || draft.status !== 'draft') {
    throw new AppError(409, 'Only the latest draft version is editable.');
  }
  return { quiz, draft, role };
}

quizzesRouter.post('/:quizId/questions', (req: AuthedRequest, res) => {
  const { draft } = editableDraft(req, Number(req.params.quizId));
  if (questionRepo.countForVersion(draft.id) >= 1000) throw new AppError(400, 'A quiz can have at most 1000 questions.');
  const v = validateQuestionData(req.body ?? {});
  const question = questionRepo.create(draft.id, {
    qtype: v.qtype,
    text: String(req.body.text),
    options: v.options,
    answer: v.answer,
    tolerance: v.tolerance,
    points: Number(req.body.points) || 1,
    time_limit_seconds: parseTimeLimit(req.body.time_limit_seconds) ?? null,
    allow_assumptions: Boolean(req.body.allow_assumptions),
  });
  res.status(201).json({ question });
});

quizzesRouter.put('/questions/:questionId', (req: AuthedRequest, res) => {
  const question = questionRepo.get(Number(req.params.questionId));
  if (!question) throw new AppError(404, 'Question not found.');
  const draft = quizVersionRepo.get(question.quiz_version_id);
  if (!draft || draft.status !== 'draft') throw new AppError(409, 'Published questions are frozen.');
  void editableDraft(req, draft.quiz_id);

  const body = req.body ?? {};
  const next: Record<string, unknown> = { ...question };
  if (body.qtype !== undefined) next.qtype = body.qtype;
  if (body.text !== undefined) next.text = body.text;
  if (body.options !== undefined) next.options = body.options;
  if (body.answer !== undefined) next.answer = body.answer;
  if (body.tolerance !== undefined) next.tolerance = body.tolerance;
  if (body.points !== undefined) next.points = body.points;

  const v = validateQuestionData(next as never);
  const updated = questionRepo.update(question.id, {
    qtype: v.qtype,
    text: String(next.text),
    options: v.options,
    answer: v.answer,
    tolerance: v.tolerance as number | null,
    points: Number(next.points) || 1,
    time_limit_seconds: parseTimeLimit(body.time_limit_seconds),
    allow_assumptions: body.allow_assumptions === undefined ? undefined : Boolean(body.allow_assumptions),
  });
  res.json({ question: updated });
});

quizzesRouter.delete('/questions/:questionId', (req: AuthedRequest, res) => {
  const question = questionRepo.get(Number(req.params.questionId));
  if (!question) throw new AppError(404, 'Question not found.');
  const draft = quizVersionRepo.get(question.quiz_version_id);
  if (!draft || draft.status !== 'draft') throw new AppError(409, 'Published questions are frozen.');
  void editableDraft(req, draft.quiz_id);
  questionRepo.remove(question.id);
  res.json({ ok: true });
});

/**
 * Item 7: once a quiz is published its question structure is frozen, but an
 * instructor may still correct the answer key (and numeric tolerance) in place.
 * Only `answer` + `tolerance` are mutable here; type/text/options/points are not.
 */
quizzesRouter.patch('/questions/:questionId/answer', (req: AuthedRequest, res) => {
  const question = questionRepo.get(Number(req.params.questionId));
  if (!question) throw new AppError(404, 'Question not found.');
  const version = quizVersionRepo.get(question.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertStaff(req, version.course_id);

  const body = req.body ?? {};
  if (body.answer === undefined) throw new AppError(400, 'An answer value is required.');
  // Validate the new answer against the question's existing (frozen) shape.
  const v = validateQuestionData({
    qtype: question.qtype,
    text: question.text,
    options: question.options,
    answer: body.answer,
    tolerance: body.tolerance !== undefined ? body.tolerance : question.tolerance,
  });
  const updated = questionRepo.update(question.id, {
    answer: v.answer,
    tolerance: v.tolerance as number | null,
  });
  writeAudit(req, {
    action: 'quiz.question.rekey',
    course_id: version.course_id,
    target: 'question:' + question.id,
    before: { answer: question.answer, tolerance: question.tolerance },
    after: { answer: v.answer, tolerance: v.tolerance ?? null },
  });
  res.json({ question: updated });
});

quizzesRouter.post('/:quizId/questions/reorder', (req: AuthedRequest, res) => {
  const { draft, role } = editableDraft(req, Number(req.params.quizId));
  const ids: number[] = Array.isArray(req.body?.question_ids) ? (req.body.question_ids as unknown[]).map(Number) : [];
  if (ids.length === 0) throw new AppError(400, 'question_ids is required.');
  const existing = questionRepo.listAuthored(draft.id).map((q) => q.id);
  if (ids.length !== existing.length || ids.some((id) => !existing.includes(id))) {
    throw new AppError(400, 'question_ids must contain every question exactly once.');
  }
  questionRepo.reorder(draft.id, ids);
  res.json(versionDetail(draft.id, req.userId as number, role));
});

// ------------------------------------------------------------------- random bank questions

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/**
 * Add `count` random slots: each student gets a different question from the
 * bank (optionally only one difficulty / tag), worth `points` marks each.
 */
quizzesRouter.post('/:quizId/slots', (req: AuthedRequest, res) => {
  const { quiz, draft, role } = editableDraft(req, Number(req.params.quizId));
  const body = req.body ?? {};
  const bank = bankRepo.get(Number(body.bank_id));
  if (!bank || bank.course_id !== quiz.course_id) throw new AppError(400, 'Choose a question bank from this course.');
  const difficulty =
    body.difficulty === undefined || body.difficulty === null || body.difficulty === '' || body.difficulty === 'any'
      ? null
      : (body.difficulty as Difficulty);
  if (difficulty !== null && !DIFFICULTIES.includes(difficulty)) {
    throw new AppError(400, "difficulty must be 'easy', 'medium', 'hard' or empty for any.");
  }
  const tag = typeof body.tag === 'string' && body.tag.trim() ? body.tag.trim().slice(0, 60) : null;
  const points = Number(body.points ?? 1);
  if (!Number.isFinite(points) || points <= 0 || points > 1000) throw new AppError(400, 'Marks must be between 0 and 1000.');
  const count = Number(body.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new AppError(400, 'Add between 1 and 100 random questions at a time.');
  const timeLimit = parseTimeLimit(body.time_limit_seconds) ?? null;

  const pool = bankRepo.pool(bank.id, difficulty, tag).length;
  const sameFilter = slotRepo
    .listForVersion(draft.id)
    .filter((sl) => sl.bank_id === bank.id && sl.difficulty === difficulty && (sl.tag ?? '').toLowerCase() === (tag ?? '').toLowerCase()).length;
  if (sameFilter + count > pool) {
    throw new AppError(
      400,
      `“${bank.name}” has ${pool} ${difficulty ?? 'matching'} question${pool === 1 ? '' : 's'}${tag ? ` tagged “${tag}”` : ''}; ` +
        `${sameFilter + count} random slots would need a different one each. Add questions to the bank or lower the count.`,
      'pool_too_small',
      { pool_size: pool },
    );
  }
  for (let i = 0; i < count; i++) {
    slotRepo.create(draft.id, { bank_id: bank.id, difficulty, tag, points, time_limit_seconds: timeLimit });
  }
  res.status(201).json(versionDetail(draft.id, req.userId as number, role));
});

quizzesRouter.delete('/slots/:slotId', (req: AuthedRequest, res) => {
  const slot = slotRepo.get(Number(req.params.slotId));
  if (!slot) throw new AppError(404, 'Random question not found.');
  const version = quizVersionRepo.get(slot.quiz_version_id);
  if (!version || version.status !== 'draft') throw new AppError(409, 'Published quizzes are frozen.');
  const { role } = editableDraft(req, version.quiz_id);
  slotRepo.remove(slot.id);
  res.json(versionDetail(version.id, req.userId as number, role));
});

// ------------------------------------------------------------------- preview (staff)

quizzesRouter.get('/:quizId/preview', (req: AuthedRequest, res) => {
  const quiz = quizRepo.get(Number(req.params.quizId));
  if (!quiz) throw new AppError(404, 'Quiz not found.');
  const role = assertStaff(req, quiz.course_id);
  const draft = quizVersionRepo.latest(quiz.id);
  if (!draft) throw new AppError(404, 'No version to preview.');
  const questions = questionRepo.listForVersion(draft.id);
  res.json({
    ...versionDetail(draft.id, req.userId as number, role),
    student_view: questions.map((q) => ({
      id: q.id,
      qtype: q.qtype,
      text: q.text,
      options: q.options,
      points: q.points,
    })),
  });
});
