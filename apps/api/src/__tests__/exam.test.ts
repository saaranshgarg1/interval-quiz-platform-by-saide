import './_env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.js';
import {
  userRepo,
  courseRepo,
  quizRepo,
  quizVersionRepo,
  questionRepo,
  attemptRepo,
  answerRepo,
  resultRepo,
  bankRepo,
  slotRepo,
} from '../repo.js';
import { hashPassword } from '../auth.js';
import {
  startAttempt,
  claimSession,
  getAttemptForStudent,
  saveAnswers,
  advanceQuestion,
  submitAttempt,
  reportClientEvent,
  heartbeat,
  sweepDueAttempts,
  type ClientContext,
} from '../services/attempts.js';
import {
  extendTime,
  pauseQuiz,
  resumeQuiz,
  closeQuiz,
  announce,
  attemptAction,
  monitorSnapshot,
  resolveStudents,
  liveExams,
} from '../services/proctor.js';
import { flagReport, raiseFlag, resolveFlag } from '../services/flags.js';
import {
  normalizeSettings,
  defaultSettings,
  settingsFromLegacy,
  legacyPolicyOf,
  presetOf,
  applyPreset,
  studentRules,
  type ExamSettings,
} from '../services/exam-settings.js';
import { AppError } from '../auth.js';
import { fromMs, toMs } from '../util.js';
import type { QuestionInput } from '../repo.js';

// ------------------------------------------------------------------ fixtures

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

function makeUser(role: 'student' | 'instructor' = 'student', entry: string | null = null) {
  const u = uniq();
  return userRepo.create(`User ${u}`, `${role}.${u}@iitrpr.ac.in`, hashPassword('pw-secret-123'), role, entry);
}

const Q_SINGLE: QuestionInput = { qtype: 'single', text: '2+2?', options: ['3', '4', '5', '6'], answer: 1, points: 1 };
const Q_MULTI: QuestionInput = { qtype: 'multiple', text: 'Evens?', options: ['1', '2', '3', '4'], answer: [1, 3], points: 2 };
const Q_SHORT: QuestionInput = { qtype: 'short', text: 'Capital of France?', answer: 'Paris', points: 1 };

interface Exam {
  courseId: number;
  quizId: number;
  versionId: number;
  instructor: ReturnType<typeof makeUser>;
  student: ReturnType<typeof makeUser>;
  questionIds: number[];
}

/** A published quiz with the given settings and questions, one enrolled student. */
function makeExam(
  settings: Partial<ExamSettings> = {},
  opts: {
    questions?: QuestionInput[];
    duration?: number | null;
    attempts?: number;
    shuffleOptions?: boolean;
    showScores?: 'never' | 'release' | 'immediate';
    scheduled?: { opensAt: string; minutes: number };
  } = {},
): Exam {
  const instructor = makeUser('instructor');
  const student = makeUser('student', `2022CSB${String(seq).padStart(4, '0')}${uniq().slice(-2).toUpperCase()}`.slice(0, 16));
  const { course } = courseRepo.create(`EX${uniq()}`, 'Exam course', instructor.id);
  courseRepo.addMember(course.id, student.id, 'student');
  const quizId = quizRepo.create(course.id, instructor.id);
  const versionId = quizVersionRepo.createDraft(quizId, course.id, instructor.id, 1);
  quizVersionRepo.updateMeta(versionId, {
    title: 'Exam',
    duration_minutes: opts.duration === undefined ? 30 : opts.duration,
    attempts_allowed: opts.attempts ?? 1,
    shuffle_options: opts.shuffleOptions ? 1 : 0,
    show_scores: opts.showScores ?? 'release',
    exam_settings: JSON.stringify(normalizeSettings(settings, defaultSettings())),
    ...(opts.scheduled
      ? { quiz_type: 'scheduled', window_opens_at: opts.scheduled.opensAt, window_duration_minutes: opts.scheduled.minutes }
      : {}),
  });
  const questionIds = (opts.questions ?? [Q_SINGLE, Q_MULTI, Q_SHORT]).map((q) => questionRepo.create(versionId, q).id);
  quizVersionRepo.publish(versionId);
  return { courseId: course.id, quizId, versionId, instructor, student, questionIds };
}

function addStudent(exam: Exam, entry: string | null = null) {
  const s = makeUser('student', entry);
  courseRepo.addMember(exam.courseId, s.id, 'student');
  return s;
}

const ctx = (session: string | null, ip = '10.0.0.5'): ClientContext => ({ ip, userAgent: 'Mozilla/5.0 Chrome/140', session });

function expectAppError(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
    assert.equal(e.status, status, e.message);
    if (code) assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected AppError ${status}${code ? ` (${code})` : ''}`);
}

/** Pretend the attempt's window went quiet `seconds` ago. */
function ageSession(attemptId: number, seconds: number) {
  db.prepare('UPDATE attempts SET last_seen_at = ? WHERE id = ?').run(fromMs(Date.now() - seconds * 1000), attemptId);
}

// ------------------------------------------------------------------ settings

describe('exam settings', () => {
  test('validates types and ranges, and a question timer forces sequential navigation', () => {
    const s = normalizeSettings({ question_timer: 'uniform', question_time_seconds: 45, max_violations: '4' });
    assert.equal(s.navigation, 'sequential');
    assert.equal(s.question_time_seconds, 45);
    assert.equal(s.max_violations, 4);
    expectAppError(() => normalizeSettings({ max_violations: 0 }), 400);
    expectAppError(() => normalizeSettings({ violation_action: 'explode' }), 400);
    expectAppError(() => normalizeSettings({ allowed_networks: ['10.0.0.0/33'] }), 400);
    expectAppError(() => normalizeSettings({ allow_tab_switch: 'nope' }), 400);
    const nets = normalizeSettings({ allowed_networks: '10.1.0.0/16, 192.168.1.7' });
    assert.deepEqual(nets.allowed_networks, ['10.1.0.0/16', '192.168.1.7']);
  });

  test('legacy off/warn/strict map onto explicit rules and back', () => {
    const strict = settingsFromLegacy('strict', 'focus_exit');
    assert.equal(strict.violation_action, 'lock');
    assert.equal(strict.max_violations, 1);
    assert.equal(strict.allow_window_switch, false);
    assert.deepEqual(legacyPolicyOf(strict), { integrity_policy: 'strict', policy_trigger: 'focus_exit' });
    assert.equal(settingsFromLegacy('strict', 'page_hidden').allow_window_switch, true);
    assert.equal(legacyPolicyOf(settingsFromLegacy('warn', 'focus_exit')).integrity_policy, 'warn');
    assert.equal(legacyPolicyOf(defaultSettings()).integrity_policy, 'off');
    assert.equal(presetOf(applyPreset(defaultSettings(), 'strict')), 'strict');
  });

  test('student-facing rules disclose every restriction in plain words', () => {
    const s = normalizeSettings({
      ...applyPreset(defaultSettings(), 'strict'),
      access_code: 'HALL7',
      question_timer: 'uniform',
      question_time_seconds: 90,
    });
    const rules = studentRules(s, { duration_minutes: 30, question_count: 10 }).join(' ');
    assert.match(rules, /30 minutes/);
    assert.match(rules, /1 min 30 s timer/);
    assert.match(rules, /cannot go back/);
    assert.match(rules, /full screen/);
    assert.match(rules, /locked/);
    assert.match(rules, /access code/);
    assert.match(rules, /Exit & resume is not allowed/);
  });
});

// ------------------------------------------------------------------ violations

describe('violation policy', () => {
  test('record-only mode warns with a running count and never locks', () => {
    const exam = makeExam({ allow_tab_switch: false, allow_window_switch: false, violation_action: 'none' });
    const view = startAttempt(exam.student.id, exam.versionId);
    for (let i = 1; i <= 3; i++) {
      db.prepare('UPDATE attempts SET last_violation_at = NULL WHERE id = ?').run(view.attempt.id);
      const out = reportClientEvent(exam.student.id, view.attempt.id, 'tab_hidden', null);
      assert.equal(out.violation, true);
      assert.equal(out.violation_count, i);
      assert.equal(out.action, 'recorded');
    }
    assert.equal(attemptRepo.get(view.attempt.id)?.status, 'in_progress');
  });

  test('locks after the configured number of violations; one switch counts once', () => {
    const exam = makeExam({ allow_tab_switch: false, allow_window_switch: false, violation_action: 'lock', max_violations: 2 });
    const id = startAttempt(exam.student.id, exam.versionId).attempt.id;
    const first = reportClientEvent(exam.student.id, id, 'window_blur', null);
    assert.equal(first.violation_count, 1);
    assert.match(first.message ?? '', /Warning 1 of 2/);
    // The same real-world switch also fires visibilitychange — not a second violation.
    const dup = reportClientEvent(exam.student.id, id, 'tab_hidden', null);
    assert.equal(dup.violation, false);
    assert.equal(attemptRepo.get(id)?.violation_count, 1);
    db.prepare('UPDATE attempts SET last_violation_at = NULL WHERE id = ?').run(id);
    const second = reportClientEvent(exam.student.id, id, 'tab_hidden', null);
    assert.equal(second.action, 'locked');
    assert.equal(second.lock, true);
    const locked = attemptRepo.get(id);
    assert.equal(locked?.status, 'locked');
    assert.equal(locked?.lock_reason, 'violation_limit');
  });

  test('auto-submits after the limit when configured to', () => {
    const exam = makeExam({ allow_tab_switch: false, violation_action: 'submit', max_violations: 1 });
    const view = startAttempt(exam.student.id, exam.versionId);
    saveAnswers(exam.student.id, view.attempt.id, { answers: [{ question_id: exam.questionIds[0]!, answer: 1, revision: 1 }] });
    const out = reportClientEvent(exam.student.id, view.attempt.id, 'tab_hidden', null);
    assert.equal(out.action, 'submitted');
    const done = attemptRepo.get(view.attempt.id);
    assert.equal(done?.status, 'submitted');
    assert.equal(done?.finalize_reason, 'violation_limit');
    assert.equal(done?.score, 1);
  });

  test('blocked copy/paste is logged but never counted; practice quizzes collect nothing', () => {
    const exam = makeExam({ allow_copy_paste: false, violation_action: 'lock', max_violations: 1 });
    const id = startAttempt(exam.student.id, exam.versionId).attempt.id;
    const out = reportClientEvent(exam.student.id, id, 'paste_attempt', 'Ctrl+V');
    assert.equal(out.action, 'recorded');
    assert.equal(out.violation, false);
    assert.equal(attemptRepo.get(id)?.status, 'in_progress');

    const practice = makeExam({});
    const pid = startAttempt(practice.student.id, practice.versionId).attempt.id;
    assert.equal(reportClientEvent(practice.student.id, pid, 'tab_hidden', null).action, 'ignored');
    const kinds = db.prepare("SELECT kind FROM policy_events WHERE attempt_id = ? AND source = 'client'").all(pid);
    assert.equal(kinds.length, 0);
  });
});

// ------------------------------------------------------------------ sessions

describe('session binding, exit & resume', () => {
  test('only the window holding the session token can save', () => {
    const exam = makeExam({});
    const start = startAttempt(exam.student.id, exam.versionId, ctx(null));
    const token = start.session_token as string;
    assert.ok(token && token.length >= 32);
    const answers = { answers: [{ question_id: exam.questionIds[0]!, answer: 1, revision: 1 }] };
    expectAppError(() => saveAnswers(exam.student.id, start.attempt.id, answers, ctx(null)), 409, 'session_required');
    expectAppError(() => saveAnswers(exam.student.id, start.attempt.id, answers, ctx('forged')), 409, 'session_replaced');
    assert.equal(saveAnswers(exam.student.id, start.attempt.id, answers, ctx(token)).acks[0]?.acknowledged, true);
  });

  test('resume allowed: a second live window must take over explicitly; the old one is cut off', () => {
    const exam = makeExam({ allow_resume: true });
    const first = startAttempt(exam.student.id, exam.versionId, ctx(null));
    expectAppError(() => claimSession(exam.student.id, first.attempt.id, ctx(null, '10.0.0.9')), 409, 'session_active');
    const second = claimSession(exam.student.id, first.attempt.id, ctx(null, '10.0.0.9'), { takeover: true });
    assert.ok(second.session_token && second.session_token !== first.session_token);
    expectAppError(
      () => getAttemptForStudent(exam.student.id, first.attempt.id, ctx(first.session_token)),
      409,
      'session_replaced',
    );
    const a = attemptRepo.get(first.attempt.id);
    assert.equal(a?.resume_count, 1);
    assert.equal(a?.last_ip, '10.0.0.9');
  });

  test('resume not allowed: reload keeps working, re-entry after leaving locks', () => {
    const exam = makeExam({ allow_resume: false, reentry_action: 'lock' });
    const first = startAttempt(exam.student.id, exam.versionId, ctx(null));
    // A reload in the same tab keeps its token — never a re-entry.
    assert.equal(getAttemptForStudent(exam.student.id, first.attempt.id, ctx(first.session_token)).attempt.status, 'in_progress');
    // While the original window is alive, a second window is turned away without penalty.
    expectAppError(() => claimSession(exam.student.id, first.attempt.id, ctx(null)), 409, 'session_active');
    // Closing the tab reports page_exit; coming back is a re-entry → locked.
    reportClientEvent(exam.student.id, first.attempt.id, 'page_exit', null, ctx(first.session_token));
    expectAppError(() => claimSession(exam.student.id, first.attempt.id, ctx(null)), 423, 'attempt_locked');
    assert.equal(attemptRepo.get(first.attempt.id)?.lock_reason, 'reentry');
  });

  test('resume not allowed with submit-on-re-entry; a silent crash counts after the stale window', () => {
    const exam = makeExam({ allow_resume: false, reentry_action: 'submit' });
    const first = startAttempt(exam.student.id, exam.versionId, ctx(null));
    ageSession(first.attempt.id, 120); // browser crashed, no heartbeat for two minutes
    const again = claimSession(exam.student.id, first.attempt.id, ctx(null));
    assert.equal(again.session_token, null);
    assert.equal(again.attempt.status, 'submitted');
    assert.equal(attemptRepo.get(first.attempt.id)?.finalize_reason, 'reentry');
  });

  test('instructor can approve one re-entry for a no-resume exam', () => {
    const exam = makeExam({ allow_resume: false });
    const first = startAttempt(exam.student.id, exam.versionId, ctx(null));
    ageSession(first.attempt.id, 120);
    attemptAction(exam.instructor.id, first.attempt.id, 'allow_reentry', { reason: 'laptop died' });
    const again = claimSession(exam.student.id, first.attempt.id, ctx(null));
    assert.ok(again.session_token);
    assert.equal(attemptRepo.get(first.attempt.id)?.reentry_allowed, 0, 'approval is single-use');
  });
});

// ------------------------------------------------------------------ timing

describe('per-question timers and sequential navigation', () => {
  test('only the current question is revealed and writable', () => {
    const exam = makeExam({ question_timer: 'uniform', question_time_seconds: 60 });
    const view = startAttempt(exam.student.id, exam.versionId);
    assert.equal(view.questions.length, 1);
    assert.equal(view.attempt.total_questions, 3);
    assert.equal(view.questions[0]?.time_limit_seconds, 60);
    assert.ok(view.attempt.question_expires_at);
    const otherId = exam.questionIds.find((id) => id !== view.questions[0]?.id)!;
    const res = saveAnswers(exam.student.id, view.attempt.id, {
      answers: [{ question_id: otherId, answer: 'x', revision: 1 }],
    });
    assert.equal(res.acks[0]?.acknowledged, false);
    assert.equal(res.acks[0]?.reason, 'not_current');
    const next = advanceQuestion(exam.student.id, view.attempt.id, 0);
    assert.equal(next.attempt.current_index, 1);
    // Advancing twice from the same index is a no-op (double click / retry).
    assert.equal(advanceQuestion(exam.student.id, view.attempt.id, 0).attempt.current_index, 1);
  });

  test('elapsed question timers move on by themselves and finish the attempt after the last one', () => {
    const exam = makeExam({ question_timer: 'per_question', question_time_seconds: 60 });
    const view = startAttempt(exam.student.id, exam.versionId);
    // Simulate the first question's timer having run out a while ago.
    db.prepare('UPDATE attempts SET question_expires_at = ? WHERE id = ?').run(fromMs(Date.now() - 30_000), view.attempt.id);
    const after = getAttemptForStudent(exam.student.id, view.attempt.id);
    assert.equal(after.attempt.current_index, 1);
    // Every remaining timer elapsed (offline for a long time) → finalized.
    db.prepare('UPDATE attempts SET question_expires_at = ? WHERE id = ?').run(fromMs(Date.now() - 600_000), view.attempt.id);
    const done = getAttemptForStudent(exam.student.id, view.attempt.id);
    assert.equal(done.attempt.status, 'expired');
    assert.equal(attemptRepo.get(view.attempt.id)?.finalize_reason, 'question_time_elapsed');
  });

  test('per-question limits come from each question, falling back to the default', () => {
    const exam = makeExam(
      { question_timer: 'per_question', question_time_seconds: 40 },
      { questions: [{ ...Q_SINGLE, time_limit_seconds: 15 }, Q_SHORT] },
    );
    const view = startAttempt(exam.student.id, exam.versionId);
    const limits = [view.questions[0]?.time_limit_seconds];
    limits.push(advanceQuestion(exam.student.id, view.attempt.id, 0).questions[0]?.time_limit_seconds);
    assert.deepEqual(limits.sort(), [15, 40]);
  });
});

describe('time extensions, pause and end-now', () => {
  test('extend everyone: live deadlines move, new starters get the time, window closes later', () => {
    const exam = makeExam({}, { duration: 30 });
    const late = addStudent(exam);
    const live = startAttempt(exam.student.id, exam.versionId);
    const before = toMs(live.attempt.expires_at!);
    const res = extendTime(exam.instructor.id, exam.quizId, {
      userIds: null,
      minutes: 10,
      includeNew: true,
      reopenExpired: false,
      reason: 'power cut',
    });
    assert.equal(res.extended, 1);
    assert.equal(toMs(attemptRepo.get(live.attempt.id)!.expires_at!) - before, 600_000);
    const newcomer = startAttempt(late.id, exam.versionId);
    const length = toMs(newcomer.attempt.expires_at!) - toMs(newcomer.attempt.started_at);
    assert.ok(Math.abs(length - 40 * 60_000) < 2_000, `expected ~40 min, got ${length / 60_000}`);
    const hb = heartbeat(exam.student.id, live.attempt.id);
    assert.equal(hb.expires_at, attemptRepo.get(live.attempt.id)?.expires_at, 'heartbeat carries the new deadline');
  });

  test('extend individual students by entry number, and reopen a timed-out attempt', () => {
    const exam = makeExam({}, { duration: 30 });
    const other = addStudent(exam, `EN${uniq()}`.toUpperCase());
    const view = startAttempt(other.id, exam.versionId);
    db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(fromMs(Date.now() - 60_000), view.attempt.id);
    sweepDueAttempts();
    assert.equal(attemptRepo.get(view.attempt.id)?.status, 'expired');

    const resolved = resolveStudents(exam.courseId, [other.entry_number!.toLowerCase(), 'NOPE-123']);
    assert.deepEqual(resolved.users.map((u) => u.id), [other.id]);
    assert.deepEqual(resolved.not_found, ['NOPE-123']);

    const res = extendTime(exam.instructor.id, exam.quizId, {
      userIds: [other.id],
      minutes: 15,
      includeNew: true,
      reopenExpired: true,
      reason: 'medical',
    });
    assert.equal(res.reopened, 1);
    const reopened = attemptRepo.get(view.attempt.id)!;
    assert.equal(reopened.status, 'in_progress');
    assert.ok(toMs(reopened.expires_at!) > Date.now() + 14 * 60_000);
    assert.equal(resultRepo.getByAttempt(view.attempt.id), undefined, 'stale grade removed until resubmission');
    // The original student was untouched.
    assert.equal(monitorSnapshot(exam.quizId).students.find((s) => s.user_id === exam.student.id)?.attempt, null);
  });

  test('pause freezes the clock: saves are refused, nothing expires, and resume gives the time back', () => {
    const exam = makeExam({}, { duration: 30 });
    const view = startAttempt(exam.student.id, exam.versionId);
    const before = toMs(view.attempt.expires_at!);
    pauseQuiz(exam.quizId);
    expectAppError(
      () => saveAnswers(exam.student.id, view.attempt.id, { answers: [{ question_id: exam.questionIds[0]!, answer: 1, revision: 1 }] }),
      423,
      'quiz_paused',
    );
    assert.equal(heartbeat(exam.student.id, view.attempt.id).paused, true);
    // Even with the deadline in the past, a paused quiz never expires attempts.
    db.prepare("UPDATE quizzes SET paused_at = ? WHERE id = ?").run(fromMs(Date.now() - 120_000), exam.quizId);
    db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(fromMs(Date.now() - 60_000), view.attempt.id);
    sweepDueAttempts();
    assert.equal(attemptRepo.get(view.attempt.id)?.status, 'in_progress');
    const { paused_seconds } = resumeQuiz(exam.instructor.id, exam.quizId);
    assert.ok(paused_seconds >= 120);
    assert.ok(toMs(attemptRepo.get(view.attempt.id)!.expires_at!) > Date.now() + 55_000);
    void before;
  });

  test('ending the quiz submits every live attempt and blocks new starts', () => {
    const exam = makeExam({});
    const late = addStudent(exam);
    const view = startAttempt(exam.student.id, exam.versionId);
    const res = closeQuiz(exam.quizId);
    assert.equal(res.submitted, 1);
    const a = attemptRepo.get(view.attempt.id);
    assert.equal(a?.status, 'submitted');
    assert.equal(a?.finalize_reason, 'closed_by_instructor');
    expectAppError(() => startAttempt(late.id, exam.versionId), 403, 'quiz_closed');
  });

  test('announcements reach students through the heartbeat, personal ones only their target', () => {
    const exam = makeExam({});
    const other = addStudent(exam);
    const a1 = startAttempt(exam.student.id, exam.versionId).attempt.id;
    const a2 = startAttempt(other.id, exam.versionId).attempt.id;
    announce(exam.instructor.id, exam.quizId, 'Q2: read "x" as "y".', null);
    announce(exam.instructor.id, exam.quizId, 'Please see the invigilator.', [other.id]);
    const h1 = heartbeat(exam.student.id, a1);
    const h2 = heartbeat(other.id, a2);
    assert.equal(h1.announcements.length, 1);
    assert.equal(h2.announcements.length, 2);
    assert.equal(h2.announcements[1]?.personal, true);
    const lastId = h2.announcements[1]!.id;
    assert.equal(heartbeat(other.id, a2, { last_announcement_id: lastId }).announcements.length, 0);
  });

  test('reinstating a locked attempt after its deadline restores the time it had left', () => {
    const exam = makeExam({ allow_tab_switch: false, violation_action: 'lock', max_violations: 1 }, { duration: 30 });
    const id = startAttempt(exam.student.id, exam.versionId).attempt.id;
    reportClientEvent(exam.student.id, id, 'tab_hidden', null);
    assert.equal(attemptRepo.get(id)?.status, 'locked');
    db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(fromMs(Date.now() - 60_000), id);
    attemptAction(exam.instructor.id, id, 'reinstate', { reason: 'false positive' });
    const a = attemptRepo.get(id)!;
    assert.equal(a.status, 'in_progress');
    assert.ok(toMs(a.expires_at!) > Date.now() + 60_000);
    expectAppError(() => attemptAction(exam.instructor.id, id, 'reinstate', {}), 409);
  });
});

// ------------------------------------------------------------------ fairness + integrity

describe('question delivery and grading', () => {
  test('shuffled options map back to the author key: the right option is graded right', () => {
    const exam = makeExam({}, { shuffleOptions: true, questions: [Q_SINGLE, Q_MULTI] });
    const view = startAttempt(exam.student.id, exam.versionId);
    const single = view.questions.find((q) => q.qtype === 'single')!;
    const multi = view.questions.find((q) => q.qtype === 'multiple')!;
    assert.deepEqual([...single.options].sort(), ['3', '4', '5', '6']);
    saveAnswers(exam.student.id, view.attempt.id, {
      answers: [
        { question_id: single.id, answer: single.options.indexOf('4'), revision: 1 },
        { question_id: multi.id, answer: [multi.options.indexOf('2'), multi.options.indexOf('4')], revision: 1 },
      ],
    });
    // Stored in the author's index space.
    assert.equal(answerRepo.getForQuestion(view.attempt.id, single.id)?.answer, '1');
    // Re-reading shows the student's own display order.
    const again = getAttemptForStudent(exam.student.id, view.attempt.id);
    assert.equal(again.answers[single.id]?.answer, single.options.indexOf('4'));
    const result = submitAttempt(exam.student.id, view.attempt.id);
    assert.equal(attemptRepo.get(result.attempt_id)?.score, 3);
  });

  test('random draw: each student gets N questions and is graded out of those only', () => {
    const pool: QuestionInput[] = Array.from({ length: 6 }, (_, i) => ({ ...Q_SINGLE, text: `Q${i}`, points: i + 1 }));
    const exam = makeExam({ questions_per_attempt: 2 }, { questions: pool });
    const view = startAttempt(exam.student.id, exam.versionId);
    assert.equal(view.questions.length, 2);
    assert.equal(view.attempt.total_questions, 2);
    const drawnPoints = view.questions.reduce((s, q) => s + q.points, 0);
    submitAttempt(exam.student.id, view.attempt.id);
    assert.equal(attemptRepo.get(view.attempt.id)?.max_score, drawnPoints);
  });

  test('answers are shape-checked per item and every revision is kept in the history', () => {
    const exam = makeExam({}, { questions: [Q_SINGLE, { qtype: 'numeric', text: 'pi', answer: 3.14, tolerance: 0.01, points: 1 }] });
    const view = startAttempt(exam.student.id, exam.versionId);
    const [single, numeric] = exam.questionIds as [number, number];
    const res = saveAnswers(exam.student.id, view.attempt.id, {
      answers: [
        { question_id: single, answer: 99, revision: 1 },
        { question_id: numeric, answer: '3.1', revision: 1 },
      ],
    });
    assert.equal(res.acks.find((a) => a.question_id === single)?.reason, 'invalid');
    assert.equal(res.acks.find((a) => a.question_id === numeric)?.acknowledged, true);
    saveAnswers(exam.student.id, view.attempt.id, { answers: [{ question_id: numeric, answer: 3.14, revision: 2 }] });
    assert.deepEqual(answerRepo.history(view.attempt.id).map((h) => h.revision), [1, 2]);
  });

  test('scores stay hidden from the student until released', () => {
    const exam = makeExam({}, { showScores: 'release' });
    const view = startAttempt(exam.student.id, exam.versionId);
    const submitted = submitAttempt(exam.student.id, view.attempt.id);
    assert.equal(submitted.score, null);
    assert.equal(getAttemptForStudent(exam.student.id, view.attempt.id).attempt.score, null);
    resultRepo.releaseByAttempt(view.attempt.id);
    assert.equal(getAttemptForStudent(exam.student.id, view.attempt.id).attempt.score, 0);
  });

  test('abandoned attempts are graded by the sweeper', () => {
    const exam = makeExam({}, { duration: 30 });
    const view = startAttempt(exam.student.id, exam.versionId);
    saveAnswers(exam.student.id, view.attempt.id, { answers: [{ question_id: exam.questionIds[0]!, answer: 1, revision: 1 }] });
    db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(fromMs(Date.now() - 60_000), view.attempt.id);
    sweepDueAttempts();
    const a = attemptRepo.get(view.attempt.id)!;
    assert.equal(a.status, 'expired');
    assert.equal(a.finalize_reason, 'time_expired');
    assert.equal(a.score, 1);
    assert.ok(resultRepo.getByAttempt(a.id));
  });
});

describe('access control for starting an exam', () => {
  test('access code: required, wrong, right — and five wrong guesses lock it out', () => {
    const exam = makeExam({ access_code: 'Hall-7' });
    expectAppError(() => startAttempt(exam.student.id, exam.versionId, ctx(null)), 403, 'access_code_required');
    expectAppError(() => startAttempt(exam.student.id, exam.versionId, ctx(null), { accessCode: 'hall-8' }), 403, 'access_code_invalid');
    assert.equal(startAttempt(exam.student.id, exam.versionId, ctx(null), { accessCode: ' hall-7 ' }).attempt.status, 'in_progress');

    const other = addStudent(exam);
    for (let i = 0; i < 5; i++) {
      expectAppError(() => startAttempt(other.id, exam.versionId, ctx(null), { accessCode: `guess${i}` }), 403);
    }
    expectAppError(() => startAttempt(other.id, exam.versionId, ctx(null), { accessCode: 'Hall-7' }), 429, 'access_code_locked');
  });

  test('exam-hall network allow-list (IPv4-mapped addresses included)', () => {
    const exam = makeExam({ allowed_networks: ['10.20.0.0/16'] });
    expectAppError(() => startAttempt(exam.student.id, exam.versionId, ctx(null, '192.168.1.4')), 403, 'network_blocked');
    assert.ok(startAttempt(exam.student.id, exam.versionId, ctx(null, '::ffff:10.20.3.4')).session_token);
  });

  test('late entry closes N minutes after a scheduled quiz opens', () => {
    const exam = makeExam(
      { late_entry_minutes: 10 },
      { scheduled: { opensAt: fromMs(Date.now() - 15 * 60_000), minutes: 120 } },
    );
    expectAppError(() => startAttempt(exam.student.id, exam.versionId), 403, 'late_entry');
  });

  test('attempts count across versions, and a locked attempt blocks a fresh start', () => {
    const exam = makeExam({ allow_tab_switch: false, violation_action: 'lock', max_violations: 1 }, { attempts: 2 });
    const first = startAttempt(exam.student.id, exam.versionId).attempt.id;
    reportClientEvent(exam.student.id, first, 'tab_hidden', null);
    expectAppError(() => startAttempt(exam.student.id, exam.versionId), 409, 'attempt_locked');
    attemptAction(exam.instructor.id, first, 'force_submit', { reason: 'grade as is' });
    // Publishing a corrected v2 must not hand out fresh attempts.
    const v2 = quizVersionRepo.clonePublished(exam.quizId, exam.instructor.id);
    quizVersionRepo.publish(v2.id);
    const second = startAttempt(exam.student.id, v2.id);
    submitAttempt(exam.student.id, second.attempt.id);
    expectAppError(() => startAttempt(exam.student.id, v2.id), 403, 'attempt_limit');
  });

  test('monitor snapshot summarises the class', () => {
    const exam = makeExam({});
    addStudent(exam);
    startAttempt(exam.student.id, exam.versionId, ctx(null));
    const snap = monitorSnapshot(exam.quizId);
    assert.equal(snap.summary.enrolled, 2);
    assert.equal(snap.summary.in_progress, 1);
    assert.equal(snap.summary.online, 1);
    assert.equal(snap.summary.not_started, 1);
    const row = snap.students.find((s) => s.user_id === exam.student.id)!;
    assert.equal(row.attempt?.total_questions, 3);
    assert.ok((row.attempt?.time_left_seconds ?? 0) > 29 * 60);
  });
});

// ------------------------------------------------------------------ flags

describe('candidate flags', () => {
  test('signals roll up into a severity; duplicates and paused moments do not count', () => {
    const exam = makeExam({ allow_tab_switch: false, allow_window_switch: false, allow_copy_paste: false, max_violations: 10, violation_action: 'lock' });
    const id = startAttempt(exam.student.id, exam.versionId).attempt.id;
    reportClientEvent(exam.student.id, id, 'window_blur', null);
    reportClientEvent(exam.student.id, id, 'tab_hidden', null); // same incident
    db.prepare('UPDATE attempts SET last_violation_at = NULL WHERE id = ?').run(id);
    reportClientEvent(exam.student.id, id, 'tab_hidden', null);
    reportClientEvent(exam.student.id, id, 'paste_attempt', 'Ctrl+V');
    pauseQuiz(exam.quizId);
    db.prepare('UPDATE attempts SET last_violation_at = NULL WHERE id = ?').run(id);
    reportClientEvent(exam.student.id, id, 'tab_hidden', 'during the fire drill');
    resumeQuiz(exam.instructor.id, exam.quizId);

    const report = flagReport(exam.quizId);
    const row = report.candidates.find((c) => c.attempt_id === id)!;
    assert.deepEqual(row.signals, { window_blur: 1, tab_hidden: 1, paste_attempt: 1 });
    assert.equal(row.flag_score, 7);
    assert.equal(row.level, 'medium');
    assert.equal(report.signal_labels.tab_hidden, 'Tab switches');
  });

  test('staff flags raise the level until resolved; clean attempts are not listed', () => {
    const exam = makeExam({});
    const clean = addStudent(exam);
    const id = startAttempt(exam.student.id, exam.versionId).attempt.id;
    startAttempt(clean.id, exam.versionId);
    const flag = raiseFlag(exam.instructor.id, id, 'high', 'Phone visible under the desk');
    let report = flagReport(exam.quizId);
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0]?.level, 'high');
    assert.equal(monitorSnapshot(exam.quizId).summary.flagged, 1);
    expectAppError(() => raiseFlag(exam.instructor.id, id, 'extreme', 'x'), 400);
    resolveFlag(exam.instructor.id, flag.id, 'Checked: calculator, permitted');
    report = flagReport(exam.quizId);
    assert.equal(report.candidates[0]?.level, 'none');
    assert.equal(report.candidates[0]?.manual_flags[0]?.resolution, 'Checked: calculator, permitted');
    expectAppError(() => resolveFlag(exam.instructor.id, flag.id, 'again'), 409);
  });
});

// ------------------------------------------------------------------ concurrency

describe('several quizzes live at the same time', () => {
  test('two courses, one student in both: clocks, pause, extensions and endings stay independent', () => {
    const a = makeExam({}, { duration: 30 });
    const b = makeExam({}, { duration: 45 });
    courseRepo.addMember(b.courseId, a.student.id, 'student');
    courseRepo.addMember(b.courseId, a.instructor.id, 'instructor');
    const inA = startAttempt(a.student.id, a.versionId, ctx(null));
    const inB = startAttempt(a.student.id, b.versionId, ctx(null));
    assert.notEqual(inA.session_token, inB.session_token);
    const bDeadline = attemptRepo.get(inB.attempt.id)!.expires_at;

    pauseQuiz(a.quizId);
    extendTime(a.instructor.id, a.quizId, { userIds: null, minutes: 5, includeNew: true, reopenExpired: false, reason: null });
    const save = (quiz: Exam, attemptId: number, token: string | null) =>
      saveAnswers(a.student.id, attemptId, { answers: [{ question_id: quiz.questionIds[0]!, answer: 1, revision: 1 }] }, ctx(token));
    expectAppError(() => save(a, inA.attempt.id, inA.session_token), 423, 'quiz_paused');
    assert.equal(save(b, inB.attempt.id, inB.session_token).acks[0]?.acknowledged, true);
    assert.equal(attemptRepo.get(inB.attempt.id)!.expires_at, bDeadline, 'quiz B untouched by quiz A extension');
    assert.equal(heartbeat(a.student.id, inB.attempt.id, {}, ctx(inB.session_token)).paused, false);

    announce(a.instructor.id, a.quizId, 'Only for quiz A', null);
    assert.equal(heartbeat(a.student.id, inB.attempt.id, {}, ctx(inB.session_token)).announcements.length, 0);

    const live = liveExams(a.instructor.id, false);
    assert.deepEqual(
      live.map((x) => [x.quiz_id, x.state]).sort(),
      [[a.quizId, 'paused'], [b.quizId, 'live']].sort(),
    );

    closeQuiz(a.quizId);
    assert.equal(attemptRepo.get(inA.attempt.id)?.status, 'submitted');
    assert.equal(attemptRepo.get(inB.attempt.id)?.status, 'in_progress');
    assert.deepEqual(liveExams(a.instructor.id, false).map((x) => x.quiz_id), [b.quizId]);
  });

  test('two quizzes in the same course run side by side', () => {
    const a = makeExam({});
    const quizId = quizRepo.create(a.courseId, a.instructor.id);
    const vId = quizVersionRepo.createDraft(quizId, a.courseId, a.instructor.id, 1);
    const qid = questionRepo.create(vId, Q_SINGLE).id;
    quizVersionRepo.publish(vId);
    const first = startAttempt(a.student.id, a.versionId);
    const second = startAttempt(a.student.id, vId);
    submitAttempt(a.student.id, second.attempt.id);
    assert.equal(attemptRepo.get(first.attempt.id)?.status, 'in_progress');
    assert.equal(attemptRepo.get(second.attempt.id)?.status, 'submitted');
    void qid;
  });
});

// ------------------------------------------------------------------ random bank questions

describe('random questions from a bank', () => {
  function bankWith(exam: Exam) {
    const bank = bankRepo.create(exam.courseId, exam.instructor.id, 'Pool', '');
    const ids = { easy: [] as number[], hard: [] as number[] };
    for (let i = 0; i < 3; i++) {
      ids.easy.push(bankRepo.addQuestion(bank.id, { qtype: 'single', text: `Easy ${i}`, options: ['a', 'b'], answer: 0, difficulty: 'easy', tags: ['unit1'] }).id);
      ids.hard.push(bankRepo.addQuestion(bank.id, { qtype: 'single', text: `Hard ${i}`, options: ['a', 'b'], answer: 1, difficulty: 'hard' }).id);
    }
    return { bank, ids };
  }

  /** A quiz with one authored question plus random slots, published. */
  function quizWithSlots(slotSpecs: { difficulty: 'easy' | 'hard' | null; points: number; tag?: string }[]) {
    const exam = makeExam({}, { questions: [Q_SHORT] });
    const { bank, ids } = bankWith(exam);
    const quizId = quizRepo.create(exam.courseId, exam.instructor.id);
    const vId = quizVersionRepo.createDraft(quizId, exam.courseId, exam.instructor.id, 1);
    questionRepo.create(vId, Q_SHORT);
    for (const sp of slotSpecs) {
      slotRepo.create(vId, { bank_id: bank.id, difficulty: sp.difficulty, tag: sp.tag ?? null, points: sp.points, time_limit_seconds: null });
    }
    quizVersionRepo.publish(vId);
    return { exam, bank, ids, quizId, vId };
  }

  test('each student gets distinct questions of the slot difficulty, spread evenly, worth the slot marks', () => {
    const { exam, ids, vId } = quizWithSlots([
      { difficulty: 'hard', points: 2 },
      { difficulty: 'hard', points: 2 },
      { difficulty: 'easy', points: 3 },
    ]);
    const students = [exam.student, addStudent(exam), addStudent(exam)];
    const hardTexts = new Map<string, number>();
    for (const st of students) {
      const view = startAttempt(st.id, vId);
      assert.equal(view.questions.length, 4);
      assert.equal(view.attempt.total_questions, 4);
      const drawn = view.questions.filter((q) => q.text !== Q_SHORT.text);
      const hard = drawn.filter((q) => q.text.startsWith('Hard'));
      const easy = drawn.filter((q) => q.text.startsWith('Easy'));
      assert.equal(hard.length, 2);
      assert.equal(easy.length, 1);
      assert.notEqual(hard[0]?.text, hard[1]?.text, 'no repeats within one paper');
      assert.ok(hard.every((q) => q.points === 2));
      assert.equal(easy[0]?.points, 3);
      for (const q of hard) hardTexts.set(q.text, (hardTexts.get(q.text) ?? 0) + 1);

      // Answer every drawn question correctly: hard answer = 1, easy answer = 0.
      saveAnswers(st.id, view.attempt.id, {
        answers: [
          ...hard.map((q) => ({ question_id: q.id, answer: 1, revision: 1 })),
          ...easy.map((q) => ({ question_id: q.id, answer: 0, revision: 1 })),
        ],
      });
      submitAttempt(st.id, view.attempt.id);
      const done = attemptRepo.get(view.attempt.id)!;
      assert.equal(done.max_score, 1 + 2 + 2 + 3);
      assert.equal(done.score, 7, 'drawn questions graded against the bank key with slot marks');
    }
    // 3 students x 2 hard slots = 6 draws over 3 hard questions: each exactly twice.
    assert.deepEqual([...hardTexts.values()].sort(), [2, 2, 2]);
    assert.equal(ids.hard.length, 3);
    // The editor still sees only the authored question.
    assert.equal(questionRepo.listAuthored(vId).length, 1);
    assert.equal(questionRepo.countForVersion(vId), 4);
  });

  test('tag filters narrow the pool; specific slots draw before "any" slots', () => {
    const { exam, vId } = quizWithSlots([
      { difficulty: null, points: 1 },
      { difficulty: 'easy', points: 1, tag: 'UNIT1' },
    ]);
    const view = startAttempt(exam.student.id, vId);
    const drawn = view.questions.filter((q) => q.text !== Q_SHORT.text).map((q) => q.text);
    assert.equal(drawn.length, 2);
    assert.ok(drawn.some((t) => t.startsWith('Easy')), 'the easy+tag slot got an easy unit1 question');
    assert.equal(new Set(drawn).size, 2);
  });

  test('a new version copies the slots but not the questions drawn for students', () => {
    const { exam, quizId, vId } = quizWithSlots([{ difficulty: 'hard', points: 2 }]);
    startAttempt(exam.student.id, vId);
    const v2 = quizVersionRepo.clonePublished(quizId, exam.instructor.id);
    assert.equal(slotRepo.listForVersion(v2.id).length, 1);
    assert.equal(questionRepo.listForVersion(v2.id).length, 1, 'only the authored question');
  });
});

describe('keyboard lock (Windows key, Alt+Tab, Esc)', () => {
  test('locking the keyboard forces full screen; strict preset turns it on; students are told', () => {
    const s = normalizeSettings({ lock_keyboard: true });
    assert.equal(s.require_fullscreen, true);
    assert.equal(applyPreset(defaultSettings(), 'strict').lock_keyboard, true);
    assert.equal(applyPreset(defaultSettings(), 'standard').lock_keyboard, false);
    const rules = studentRules(s, { duration_minutes: 30, question_count: 5 }).join(' ');
    assert.match(rules, /Windows key, Alt\+Tab and Esc are disabled/);
    assert.match(rules, /opens in full screen when you start/);
  });

  test('blocked system keys are logged and flagged but never counted as violations', () => {
    const exam = makeExam({ lock_keyboard: true, violation_action: 'lock', max_violations: 1 });
    const id = startAttempt(exam.student.id, exam.versionId).attempt.id;
    const out = reportClientEvent(exam.student.id, id, 'system_key_attempt', 'Windows key');
    assert.equal(out.violation, false);
    assert.equal(attemptRepo.get(id)?.status, 'in_progress');
    const row = flagReport(exam.quizId).candidates.find((c) => c.attempt_id === id);
    assert.equal(row?.signals.system_key_attempt, 1);
  });
});
