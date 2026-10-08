import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { assertInstructor, assertStaff, writeAudit } from '../authz.js';
import {
  resultRepo,
  attemptRepo,
  quizVersionRepo,
  questionRepo,
  courseRepo,
  answerRepo,
  slotRepo,
} from '../repo.js';
import { db } from '../db.js';
import { gradeOf } from '../services/finalize.js';
import { manualGradeRepo } from '../insight-repo.js';
import { flagsForQuiz } from '../services/flags.js';
import { jsonParse, toMs } from '../util.js';
import type { ResultView } from '../api-types.js';
import type { Attempt } from '../types.js';

export const resultsRouter = Router();

resultsRouter.use(requireAuth);

function resultView(attemptId: number): ResultView | null {
  const result = resultRepo.getByAttempt(attemptId);
  if (!result) return null;
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(result.quiz_version_id);
  const course = version ? courseRepo.get(version.course_id) : undefined;

  return {
    id: result.id,
    attempt_id: attemptId,
    quiz_version_id: result.quiz_version_id,
    quiz_title: version?.title ?? '',
    course_code: course?.code ?? '',
    course_name: course?.name ?? '',
    version: version?.version ?? 0,
    score: result.score,
    max_score: result.max_score,
    released: result.released,
    answer_key_released: result.answer_key_released,
    released_at: result.released_at,
    submitted_at: attempt.submitted_at,
    pending_manual: result.pending_manual,
    per_question: [],
  };
}

/** Per-question marks for the questions this attempt was actually dealt (incl. marks given by hand). */
function breakdownFor(attempt: Attempt, all?: ReturnType<typeof questionRepo.listForVersion>) {
  return gradeOf(attempt, all).perQuestion;
}

/** Build the per-question breakdown for a seen result. */
function perQuestionDetail(attemptId: number, answerKeyReleased: boolean) {
  const attempt = attemptRepo.get(attemptId);
  if (!attempt) return [];
  const questions = questionRepo.listForVersion(attempt.quiz_version_id);
  const order = jsonParse<number[]>(attempt.question_order, []);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = order.map((id) => byId.get(id)).filter((q): q is NonNullable<typeof q> => Boolean(q));
  const answers = new Map(answerRepo.listForAttempt(attemptId).map((a) => [a.question_id, a]));
  const graded = new Map(breakdownFor(attempt, questions).map((g) => [g.question_id, g]));
  const manual = manualGradeRepo.forAttempt(attemptId);
  return ordered.map((q) => {
    const row = answers.get(q.id);
    const yourAnswer = row ? jsonParse<unknown>(row.answer ?? 'null', null) : null;
    const g = graded.get(q.id);
    return {
      question_id: q.id,
      text: q.text,
      qtype: q.qtype,
      options: q.options,
      your_answer: yourAnswer,
      answered: yourAnswer != null,
      assumption: row?.assumption ?? null,
      // Descriptive: the model answer / marking guide is part of the key.
      correct_answer: answerKeyReleased ? q.answer : null,
      accept_also: answerKeyReleased ? q.accept_also : [],
      earned: g?.earned ?? 0,
      points: g?.points ?? q.points,
      source: g?.source ?? 'unanswered',
      pending: Boolean(g?.pending),
      bonus: g?.bonus ?? 0,
      grading_mode: q.grading_mode,
      feedback: manual.get(q.id)?.feedback || null,
    };
  });
}

resultsRouter.get('/mine', (req: AuthedRequest, res) => {
  const rows = resultRepo.listForUser(req.userId as number);
  res.json({ results: rows });
});

/** Instructor releases all results for a published quiz version. */
resultsRouter.post('/quiz/:quizVersionId/release', (req: AuthedRequest, res) => {
  const version = quizVersionRepo.get(Number(req.params.quizVersionId));
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const answerKey = Boolean((req.body ?? {}).answer_key ?? false);
  const n = resultRepo.releaseAllForVersion(version.id, answerKey);
  writeAudit(req, {
    action: 'results.release',
    course_id: version.course_id,
    target: 'version:' + version.id,
    after: { answer_key: answerKey, released: n },
  });
  res.json({ ok: true, released: n });
});

/** Release (or toggle answer key for) a single attempt result. */
resultsRouter.put('/attempt/:attemptId', (req: AuthedRequest, res) => {
  const attempt = attemptRepo.get(Number(req.params.attemptId));
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  const result = resultRepo.getByAttempt(attempt.id);
  if (!result) throw new AppError(409, 'Attempt has not been graded yet.');
  const { release, answer_key } = req.body ?? {};
  if (typeof release === 'boolean') {
    if (version.show_scores === 'never') {
      throw new AppError(400, 'This quiz never shows scores.');
    }
    if (release) resultRepo.releaseByAttempt(attempt.id);
  }
  if (typeof answer_key === 'boolean') {
    resultRepo.setKeyReleased(attempt.id, answer_key ? 1 : 0);
  }
  writeAudit(req, {
    action: 'results.attempt.update',
    course_id: version.course_id,
    target: 'attempt:' + attempt.id,
    after: req.body,
  });
  res.json({ ok: true });
});

resultsRouter.get('/attempt/:attemptId', (req: AuthedRequest, res) => {
  const attempt = attemptRepo.get(Number(req.params.attemptId));
  if (!attempt) throw new AppError(404, 'Attempt not found.');
  const isOwner = attempt.user_id === (req.userId as number);
  const version = quizVersionRepo.get(attempt.quiz_version_id);
  if (!isOwner) {
    if (!version) throw new AppError(403, 'Not your attempt.');
    assertStaff(req, version.course_id);
  }
  const result = resultRepo.getByAttempt(attempt.id);
  if (!result || !result.released) {
    if (!isOwner || version?.show_scores !== 'immediate') {
      throw new AppError(404, 'Result has not been released yet.');
    }
  }
  if (isOwner && result && result.pending_manual > 0) {
    throw new AppError(
      409,
      'Your written answers are still being marked by your instructor. Your result will appear here once marking is done.',
      'marking_pending',
      { pending: result.pending_manual },
    );
  }
  const view = resultView(attempt.id);
  if (!view) throw new AppError(404, 'No result to show.');
  const perQuestion = perQuestionDetail(attempt.id, Boolean(result?.answer_key_released));
  res.json({
    result: {
      ...view,
      per_question: perQuestion,
    },
  });
});

/** Neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell). */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Gradebook export for a published version: one row per attempt (with entry
 * number, per-question marks, violations and how the attempt ended) plus a row
 * for every enrolled student who never attempted the quiz.
 */
resultsRouter.get('/quiz/:quizVersionId/export.csv', (req: AuthedRequest, res) => {
  const version = quizVersionRepo.get(Number(req.params.quizVersionId));
  if (!version) throw new AppError(404, 'Quiz version not found.');
  assertInstructor(req, version.course_id);
  // Every question row (incl. ones drawn from banks), plus one column per paper item:
  // authored questions and random slots, in paper order.
  const questions = questionRepo.listForVersion(version.id);
  const slotOf = new Map(questions.filter((q) => q.slot_id).map((q) => [q.id, q.slot_id as number]));
  const columns = [
    ...questionRepo.listAuthored(version.id).map((q) => ({ kind: 'question' as const, id: q.id, order: q.order_index, points: q.points, label: '' })),
    ...slotRepo.listForVersion(version.id).map((sl) => ({
      kind: 'slot' as const,
      id: sl.id,
      order: sl.order_index,
      points: sl.points,
      label: ` random ${sl.difficulty ?? 'any'}`,
    })),
  ].sort((a, b) => a.order - b.order);
  const attempts = attemptRepo.listForVersion(version.id).sort((a, b) => a.id - b.id);
  const users = new Map(
    (db
      .prepare(
        `SELECT u.id, u.name, u.email, u.entry_number FROM users u
         WHERE u.id IN (SELECT user_id FROM attempts WHERE quiz_version_id = ?)
            OR u.id IN (SELECT user_id FROM memberships WHERE course_id = ? AND role = 'student')`,
      )
      .all(version.id, version.course_id) as { id: number; name: string; email: string; entry_number: string | null }[]).map(
      (u) => [Number(u.id), u],
    ),
  );
  const attemptedQuiz = new Set(
    (db
      .prepare(
        `SELECT DISTINCT a.user_id FROM attempts a JOIN quiz_versions qv ON qv.id = a.quiz_version_id
         WHERE qv.quiz_id = ?`,
      )
      .all(version.quiz_id) as { user_id: number }[]).map((r) => Number(r.user_id)),
  );
  const absent = (db
    .prepare(`SELECT user_id FROM memberships WHERE course_id = ? AND role = 'student'`)
    .all(version.course_id) as { user_id: number }[])
    .map((r) => Number(r.user_id))
    .filter((id) => !attemptedQuiz.has(id));

  const header = [
    'entry_number', 'name', 'email', 'attempt_id', 'attempt_no', 'version', 'status', 'how_it_ended',
    'started_at', 'submitted_at', 'minutes_used', 'score', 'max_score', 'percent', 'violations',
    'resumes', 'extra_minutes', 'start_ip', 'last_ip', 'receipt',
    'flag_level', 'flag_score', 'tab_switches', 'window_switches', 'fullscreen_exits',
    'blocked_clipboard', 'ip_changes', 'device_takeovers', 'open_staff_flags',
    ...columns.map((c, i) => `Q${i + 1}${c.label} (${c.points} pt)`),
  ];
  const flags = flagsForQuiz(version.quiz_id);
  const attemptNo = new Map<number, number>();
  const rows: unknown[][] = attempts.map((a) => {
    const u = users.get(a.user_id);
    const n = (attemptNo.get(a.user_id) ?? 0) + 1;
    attemptNo.set(a.user_id, n);
    const graded = a.status === 'submitted' || a.status === 'expired';
    const earned = new Map<string, number>();
    if (graded) {
      for (const g of breakdownFor(a, questions)) {
        const slot = slotOf.get(g.question_id);
        earned.set(slot ? `slot:${slot}` : `question:${g.question_id}`, g.earned);
      }
    }
    const end = a.submitted_at ?? a.graded_at;
    return [
      u?.entry_number ?? '', u?.name ?? '', u?.email ?? '', a.id, n, version.version, a.status,
      a.finalize_reason ?? a.lock_reason ?? '', a.started_at, a.submitted_at ?? '',
      end ? Math.round((toMs(end) - toMs(a.started_at)) / 6000) / 10 : '',
      graded ? a.score ?? '' : '', graded ? a.max_score ?? '' : '',
      graded && a.max_score ? Math.round(((a.score ?? 0) / a.max_score) * 1000) / 10 : '',
      a.violation_count, a.resume_count, Math.round(a.extra_seconds / 6) / 10,
      a.start_ip ?? '', a.last_ip ?? '', a.receipt ?? '',
      ...flagColumns(flags.get(a.id)),
      ...columns.map((c) => earned.get(`${c.kind}:${c.id}`) ?? ''),
    ];
  });
  for (const id of absent) {
    const u = users.get(id);
    rows.push([u?.entry_number ?? '', u?.name ?? '', u?.email ?? '', '', '', version.version, 'absent']);
  }
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="result-${version.id}.csv"`);
  // BOM so spreadsheet apps read names with non-ASCII characters correctly.
  res.send(`\uFEFF${csv}`);
});

function flagColumns(f: ReturnType<typeof flagsForQuiz> extends Map<number, infer V> ? V | undefined : never): unknown[] {
  const n = (k: string) => f?.signals[k] ?? 0;
  return [
    f?.level ?? 'none',
    f?.score ?? 0,
    n('tab_hidden'),
    n('window_blur'),
    n('fullscreen_exit'),
    n('copy_attempt') + n('cut_attempt') + n('paste_attempt') + n('drop_attempt'),
    n('ip_changed'),
    n('session_takeover'),
    f?.open_manual ?? 0,
  ];
}
