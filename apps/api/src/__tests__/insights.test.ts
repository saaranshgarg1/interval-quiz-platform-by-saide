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
  resultRepo,
  bankRepo,
  slotRepo,
  type QuestionInput,
} from '../repo.js';
import { hashPassword, AppError } from '../auth.js';
import {
  startAttempt,
  saveAnswers,
  submitAttempt,
  getAttemptForStudent,
  heartbeat,
  raiseHand,
  type ClientContext,
} from '../services/attempts.js';
import { announce } from '../services/proctor.js';
import { scoreVisible } from '../services/finalize.js';
import { normalizeSettings, defaultSettings } from '../services/exam-settings.js';
import {
  answerHand,
  appealsForVersion,
  chiSquareP,
  collusionReport,
  createAppeal,
  fairnessReport,
  gradingQueue,
  normalizeSlot,
  poissonBinomialTail,
  questionHealth,
  questionReview,
  regradeQuestion,
  resolveAppeal,
  setManualMarks,
} from '../services/insights.js';
import { adminUpdateProfile, profileFor, updateOwnPrefs } from '../services/accessibility.js';
import { toMs } from '../util.js';

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const ctx = (session: string | null, ip = '10.1.0.5'): ClientContext => ({ ip, userAgent: 'Mozilla/5.0 Chrome/140', session });

function makeUser(role: 'student' | 'instructor' = 'student') {
  const u = uniq();
  return userRepo.create(`User ${u}`, `${role}.${u}@iitrpr.ac.in`, hashPassword('pw-secret-123'), role, null);
}

interface Exam {
  courseId: number;
  quizId: number;
  versionId: number;
  instructor: ReturnType<typeof makeUser>;
  questionIds: number[];
}

function makeExam(
  questions: QuestionInput[],
  opts: { showScores?: 'never' | 'release' | 'immediate'; duration?: number | null; slots?: (versionId: number, courseId: number, by: number) => void } = {},
): Exam {
  const instructor = makeUser('instructor');
  const { course } = courseRepo.create(`IN${uniq()}`, 'Insight course', instructor.id);
  const quizId = quizRepo.create(course.id, instructor.id);
  const versionId = quizVersionRepo.createDraft(quizId, course.id, instructor.id, 1);
  quizVersionRepo.updateMeta(versionId, {
    title: 'Insight exam',
    duration_minutes: opts.duration === undefined ? 30 : opts.duration,
    attempts_allowed: 1,
    show_scores: opts.showScores ?? 'immediate',
    exam_settings: JSON.stringify(normalizeSettings({}, defaultSettings())),
  });
  const questionIds = questions.map((q) => questionRepo.create(versionId, q).id);
  opts.slots?.(versionId, course.id, instructor.id);
  quizVersionRepo.publish(versionId);
  return { courseId: course.id, quizId, versionId, instructor, questionIds };
}

function enrol(exam: Exam) {
  const s = makeUser('student');
  courseRepo.addMember(exam.courseId, s.id, 'student');
  return s;
}

/** Start, answer (question id → answer, optional assumption) and submit. */
function sit(exam: Exam, answers: Record<number, unknown>, assumptions: Record<number, string> = {}, ip?: string) {
  const s = enrol(exam);
  const started = startAttempt(s.id, exam.versionId, ctx(null, ip));
  const token = started.session_token;
  const items = Object.entries(answers).map(([qid, answer]) => ({
    question_id: Number(qid),
    answer,
    revision: 1,
    assumption: assumptions[Number(qid)],
  }));
  if (items.length) saveAnswers(s.id, started.attempt.id, { answers: items }, ctx(token, ip));
  submitAttempt(s.id, started.attempt.id, ctx(token, ip));
  return { student: s, attemptId: started.attempt.id, token };
}

const MC = (text: string, answer: number, points = 1): QuestionInput => ({
  qtype: 'single',
  text,
  options: ['A', 'B', 'C', 'D'],
  answer,
  points,
});

describe('schema', () => {
  test('descriptive is a valid question type and foreign keys still hold after the rebuild', () => {
    const exam = makeExam([{ qtype: 'descriptive', text: 'Explain', answer: 'guide', points: 5 }]);
    assert.equal(questionRepo.get(exam.questionIds[0] as number)?.qtype, 'descriptive');
    assert.equal(Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys), 1);
    assert.throws(() =>
      db.prepare(
        `INSERT INTO answer_revisions (attempt_id, question_id, position, answer, revision, saved_at) VALUES (999999, 999999, 0, '1', 1, 'x')`,
      ).run(),
    );
    assert.throws(() =>
      db.prepare(`UPDATE questions SET qtype = 'essay' WHERE id = ?`).run(exam.questionIds[0] as number),
    );
  });
});

describe('descriptive answers and manual marks', () => {
  test('written answers are never auto-graded; score stays hidden until marked', () => {
    const exam = makeExam([MC('mc', 1, 2), { qtype: 'descriptive', text: 'Explain Fitts', answer: 'model', points: 5 }]);
    const [mcId, essayId] = exam.questionIds as [number, number];
    const { attemptId } = sit(exam, { [mcId]: 1, [essayId]: 'Movement time grows with distance over width.' });
    const attempt = attemptRepo.get(attemptId)!;
    assert.equal(attempt.score, 2);
    assert.equal(attempt.max_score, 7);
    assert.equal(resultRepo.getByAttempt(attemptId)?.pending_manual, 1);
    assert.equal(scoreVisible(attempt, quizVersionRepo.get(exam.versionId)), false, 'immediate scores wait for marking');

    const queue = gradingQueue(exam.versionId);
    assert.equal(queue.pending, 1);
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0]?.reason, 'descriptive');

    assert.throws(() => setManualMarks(exam.instructor.id, attemptId, essayId, 6, ''), /between 0 and 5/);
    const out = setManualMarks(exam.instructor.id, attemptId, essayId, 3.5, 'Good, but no formula.');
    assert.deepEqual(out, { score: 5.5, max_score: 7, pending: 0 });
    assert.equal(resultRepo.getByAttempt(attemptId)?.pending_manual, 0);
    assert.equal(scoreVisible(attemptRepo.get(attemptId)!, quizVersionRepo.get(exam.versionId)), true);

    // Clearing the mark puts it back in the queue.
    setManualMarks(exam.instructor.id, attemptId, essayId, null, '');
    assert.equal(resultRepo.getByAttempt(attemptId)?.pending_manual, 1);
  });

  test('a blank written answer scores 0 and needs no marking', () => {
    const exam = makeExam([{ qtype: 'descriptive', text: 'Explain', answer: '', points: 4 }]);
    const { attemptId } = sit(exam, { [exam.questionIds[0] as number]: '   ' });
    assert.equal(resultRepo.getByAttempt(attemptId)?.pending_manual, 0);
    assert.equal(attemptRepo.get(attemptId)?.score, 0);
  });
});

describe('assumptions', () => {
  test('stored only where the question allows them; too long is rejected', () => {
    const exam = makeExam([
      { ...MC('with', 0), allow_assumptions: true },
      MC('without', 0),
    ]);
    const [withId, withoutId] = exam.questionIds as [number, number];
    const s = enrol(exam);
    const started = startAttempt(s.id, exam.versionId, ctx(null));
    const view = getAttemptForStudent(s.id, started.attempt.id, ctx(started.session_token));
    assert.equal(view.questions.find((q) => q.id === withId)?.allow_assumptions, true);
    assert.equal(view.questions.find((q) => q.id === withoutId)?.allow_assumptions, false);

    const res = saveAnswers(
      s.id,
      started.attempt.id,
      {
        answers: [
          { question_id: withId, answer: 0, revision: 1, assumption: 'Assume the list is sorted.' },
          { question_id: withoutId, answer: 0, revision: 1, assumption: 'ignored' },
        ],
      },
      ctx(started.session_token),
    );
    assert.ok(res.acks.every((a) => a.acknowledged));
    const after = getAttemptForStudent(s.id, started.attempt.id, ctx(started.session_token));
    assert.equal(after.answers[withId]?.assumption, 'Assume the list is sorted.');
    assert.equal(after.answers[withoutId]?.assumption, null);

    const long = saveAnswers(
      s.id,
      started.attempt.id,
      { answers: [{ question_id: withId, answer: 1, revision: 2, assumption: 'x'.repeat(2001) }] },
      ctx(started.session_token),
    );
    assert.equal(long.acks[0]?.acknowledged, false);

    submitAttempt(s.id, started.attempt.id, ctx(started.session_token));
    const queue = gradingQueue(exam.versionId);
    assert.equal(queue.items.length, 1, 'answers with an assumption are offered for review');
    assert.equal(queue.items[0]?.reason, 'assumption');
    assert.equal(queue.pending, 0, 'assumptions never block results');
  });
});

describe('regrading', () => {
  test('rekey, accept-also, full marks and drop all regrade every paper', () => {
    const exam = makeExam([MC('broken key', 0, 2), MC('fine', 1, 1)]);
    const [broken, fine] = exam.questionIds as [number, number];
    const a = sit(exam, { [broken]: 2, [fine]: 1 }).attemptId; // C on broken
    const b = sit(exam, { [broken]: 3, [fine]: 0 }).attemptId; // D on broken
    assert.equal(attemptRepo.get(a)?.score, 1);
    assert.equal(attemptRepo.get(b)?.score, 0);

    const rekey = regradeQuestion(broken, { answer: 2 });
    assert.equal(rekey.regraded, 2);
    assert.equal(rekey.changed, 1);
    assert.equal(attemptRepo.get(a)?.score, 3);

    regradeQuestion(broken, { accept_also: [3] });
    assert.equal(attemptRepo.get(b)?.score, 2);

    regradeQuestion(broken, { accept_also: [], mode: 'full_marks' });
    assert.equal(attemptRepo.get(b)?.score, 2);
    assert.equal(attemptRepo.get(a)?.score, 3);

    regradeQuestion(broken, { mode: 'dropped' });
    assert.equal(attemptRepo.get(a)?.max_score, 1);
    assert.equal(attemptRepo.get(a)?.score, 1);
    assert.equal(resultRepo.getByAttempt(a)?.max_score, 1);

    assert.throws(() => regradeQuestion(broken, { answer: 9 }), /valid option/);
    assert.throws(() => regradeQuestion(broken, { mode: 'bogus' }), AppError);
  });
});

describe('random-question fairness', () => {
  function slotExam() {
    let bankId = 0;
    let easyId = 0;
    let hardId = 0;
    const exam = makeExam([MC('anchor', 0)], {
      slots: (versionId, courseId, by) => {
        const bank = bankRepo.create(courseId, by, 'Pool', '');
        bankId = bank.id;
        easyId = bankRepo.addQuestion(bank.id, { qtype: 'single', text: 'variant easy', options: ['x', 'y'], answer: 0, difficulty: 'medium' }).id;
        hardId = bankRepo.addQuestion(bank.id, { qtype: 'single', text: 'variant hard', options: ['x', 'y'], answer: 0, difficulty: 'medium' }).id;
        slotRepo.create(versionId, { bank_id: bank.id, difficulty: 'medium', tag: null, points: 2, time_limit_seconds: null });
      },
    });
    return { exam, bankId, easyId, hardId };
  }

  test('detects a harder variant, normalizes it, and suggests re-rating the bank', () => {
    const { exam, easyId, hardId } = slotExam();
    const anchor = exam.questionIds[0] as number;
    for (let i = 0; i < 16; i++) {
      const s = enrol(exam);
      const started = startAttempt(s.id, exam.versionId, ctx(null));
      const view = getAttemptForStudent(s.id, started.attempt.id, ctx(started.session_token));
      const drawn = view.questions.find((q) => q.id !== anchor)!;
      const isEasy = questionRepo.get(drawn.id)?.bank_question_id === easyId;
      saveAnswers(
        s.id,
        started.attempt.id,
        { answers: [{ question_id: anchor, answer: 0, revision: 1 }, { question_id: drawn.id, answer: isEasy ? 0 : 1, revision: 1 }] },
        ctx(started.session_token),
      );
      submitAttempt(s.id, started.attempt.id, ctx(started.session_token));
    }
    const report = fairnessReport(exam.versionId);
    assert.equal(report.slots.length, 1);
    const slot = report.slots[0]!;
    assert.equal(slot.variants.length, 2);
    assert.equal(slot.verdict, 'unfair');
    assert.equal(slot.gap, 1);
    assert.ok((slot.p_value ?? 1) < 0.001);
    const hardVariant = slot.variants.find((v) => v.bank_question_id === hardId)!;
    assert.equal(slot.proposed_bonus[hardVariant.question_id], 2);

    // Difficulty: every student got the "hard" one wrong → suggest re-rating it.
    const review = questionReview(exam.versionId);
    const stat = review.questions.find((q) => q.question_id === hardVariant.question_id)!;
    assert.equal(stat.bank_difficulty, 'medium');
    assert.equal(stat.suggested_difficulty, 'hard');
    const easyStat = review.questions.find((q) => q.bank_question_id === easyId)!;
    assert.equal(easyStat.suggested_difficulty, 'easy');

    const out = normalizeSlot(slot.slot.id, 'raise_to_easiest');
    assert.equal(out.bonuses[hardVariant.question_id], 2);
    const hardTakers = attemptRepo
      .listForVersion(exam.versionId)
      .filter((a) => JSON.parse(a.question_order).includes(hardVariant.question_id));
    assert.ok(hardTakers.length >= 5);
    for (const a of hardTakers) assert.equal(a.score, 3, 'harder variant raised to the easier one');
    const after = fairnessReport(exam.versionId).slots[0]!;
    assert.equal(after.normalized, true);

    normalizeSlot(slot.slot.id, 'clear');
    for (const a of hardTakers) assert.equal(attemptRepo.get(a.id)?.score, 1);
  });

  test('refuses to normalize without enough students', () => {
    const { exam } = slotExam();
    sit(exam, { [exam.questionIds[0] as number]: 0 });
    const slot = fairnessReport(exam.versionId).slots[0]!;
    assert.equal(slot.verdict, 'not_enough_data');
    assert.throws(() => normalizeSlot(slot.slot.id, 'raise_to_easiest'), /at least 5/);
  });
});

describe('statistics helpers', () => {
  test('match-count and chi-square tails match known values', () => {
    assert.ok(Math.abs(poissonBinomialTail([0.5, 0.5], 1) - 0.75) < 1e-12);
    assert.ok(Math.abs(poissonBinomialTail([0.5, 0.5], 2) - 0.25) < 1e-12);
    assert.ok(Math.abs(poissonBinomialTail(Array(9).fill(0.1), 9) - 1e-9) < 1e-15);
    assert.equal(poissonBinomialTail([0.3], 0), 1);
    assert.equal(poissonBinomialTail([0.3], 2), 0);
    assert.ok(Math.abs(chiSquareP(3.841, 1) - 0.05) < 1e-3);
    assert.ok(Math.abs(chiSquareP(5.991, 2) - 0.05) < 1e-3);
  });
});

describe('collusion check', () => {
  test('flags a pair sharing many unusual wrong answers, not honest students', () => {
    const questions = Array.from({ length: 12 }, (_, i) => MC(`q${i}`, 0));
    const exam = makeExam(questions);
    const ids = exam.questionIds;
    // Honest students: right on most, wrong answers spread over B/C/D.
    for (let s = 0; s < 30; s++) {
      const answers: Record<number, number> = {};
      ids.forEach((qid, i) => {
        answers[qid] = (s + i) % 3 === 0 ? 1 + ((s * 7 + i * 3) % 3) : 0;
      });
      sit(exam, answers, {}, `10.2.${s}.1`);
    }
    // Two copiers: the same rare wrong answer on 9 questions, same network.
    const copied: Record<number, number> = {};
    ids.forEach((qid, i) => {
      copied[qid] = i < 9 ? 3 : 0;
    });
    const a = sit(exam, copied, {}, '10.9.9.9').attemptId;
    const b = sit(exam, copied, {}, '10.9.9.9').attemptId;

    const report = collusionReport(exam.versionId);
    assert.equal(report.analysed_attempts, 32);
    const top = report.pairs[0]!;
    assert.deepEqual([top.a.attempt_id, top.b.attempt_id].sort(), [a, b].sort());
    assert.equal(top.level, 'high');
    assert.equal(top.shared_wrong, 9);
    assert.equal(top.same_network, true);
    assert.ok(top.adjusted_p < 0.001);
    assert.equal(top.shared_questions.length, 9);
    assert.ok(
      !report.pairs.some((p) => p.level === 'high' && ![a, b].includes(p.a.attempt_id) && ![a, b].includes(p.b.attempt_id)),
      'no honest pair is flagged high',
    );
  });

  test('near-identical written answers are flagged', () => {
    const exam = makeExam([{ qtype: 'descriptive', text: 'Explain', answer: '', points: 5 }]);
    const qid = exam.questionIds[0] as number;
    const essay =
      'Fitts law predicts that the time to acquire a target is a function of the distance to and size of the target so bigger closer buttons are faster';
    const a = sit(exam, { [qid]: essay }).attemptId;
    const b = sit(exam, { [qid]: `${essay}.` }).attemptId;
    sit(exam, { [qid]: 'Hick law says decision time grows with the logarithm of the number of choices which is about menus not pointing at things' });
    const report = collusionReport(exam.versionId);
    assert.equal(report.pairs.length, 1);
    assert.deepEqual([report.pairs[0]!.a.attempt_id, report.pairs[0]!.b.attempt_id].sort(), [a, b].sort());
    assert.ok(report.pairs[0]!.text_matches[0]!.similarity >= 0.8);
  });
});

describe('appeals', () => {
  test('mark appeal after release; accepting with marks regrades; rejecting needs a reason', () => {
    const exam = makeExam([MC('q', 0, 2), MC('r', 0, 1)], { showScores: 'release' });
    const [q1] = exam.questionIds as [number];
    const { student, attemptId } = sit(exam, { [q1]: 1 });
    assert.throws(() => createAppeal(student.id, attemptId, { kind: 'grading', question_id: q1, message: 'Option B is also right.' }), /released/);
    resultRepo.releaseAllForVersion(exam.versionId);
    const appeal = createAppeal(student.id, attemptId, { kind: 'grading', question_id: q1, message: 'Option B is also right.' });
    assert.throws(() => createAppeal(student.id, attemptId, { kind: 'grading', question_id: q1, message: 'Again, please look.' }), /already/);
    assert.throws(() => createAppeal(student.id, attemptId, { kind: 'integrity', message: 'Nothing happened here.' }), /no integrity/);

    assert.equal(appealsForVersion(exam.versionId).open, 1);
    assert.throws(() => resolveAppeal(exam.instructor.id, appeal.id, { status: 'rejected' }), /why/);
    const out = resolveAppeal(exam.instructor.id, appeal.id, { status: 'accepted', response: 'Fair point.', marks: 2 });
    assert.equal(out.appeal?.status, 'accepted');
    assert.equal(attemptRepo.get(attemptId)?.score, 2);
    assert.throws(() => resolveAppeal(exam.instructor.id, appeal.id, { status: 'accepted' }), /already/);
  });
});

describe('raise hand and clarifications', () => {
  test('limits, private reply and broadcast pinned to the question', () => {
    const exam = makeExam([MC('q1', 0), MC('q2', 0)]);
    const [q1] = exam.questionIds as [number];
    const s = enrol(exam);
    const started = startAttempt(s.id, exam.versionId, ctx(null));
    const c = ctx(started.session_token);
    assert.throws(() => raiseHand(s.id, started.attempt.id, { message: '' }, c), /Write/);
    const h1 = raiseHand(s.id, started.attempt.id, { message: 'Is Q1 option C a typo?', question_id: q1 }, c);
    raiseHand(s.id, started.attempt.id, { message: 'Can I use a calculator?' }, c);
    assert.throws(() => raiseHand(s.id, started.attempt.id, { message: 'Third one' }, c), /wait/);

    answerHand(exam.instructor.id, h1.id, { reply: 'Yes, read it as 42.' });
    let hb = heartbeat(s.id, started.attempt.id, {}, c);
    const personal = hb.announcements.find((a) => a.personal);
    assert.ok(personal?.message.includes('Yes, read it as 42.'));
    assert.equal(personal?.question_id, q1);
    assert.equal(hb.hands.find((h) => h.id === h1.id)?.status, 'answered');
    assert.throws(() => answerHand(exam.instructor.id, h1.id, { reply: 'again' }), /already/);

    // A clarification pinned to a question reaches only students given that question.
    const other = makeExam([MC('x', 0)]);
    void other;
    announce(exam.instructor.id, exam.quizId, 'Q1: ignore option D.', null, q1);
    hb = heartbeat(s.id, started.attempt.id, {}, c);
    assert.ok(hb.announcements.some((a) => a.question_id === q1 && !a.personal));
  });
});

describe('live question health', () => {
  test('warns when almost nobody gets a question right', () => {
    const exam = makeExam([MC('wrong key', 0), MC('fine', 1)]);
    const [bad, fine] = exam.questionIds as [number, number];
    for (let i = 0; i < 10; i++) sit(exam, { [bad]: 2, [fine]: 1 });
    const health = questionHealth(exam.quizId);
    const row = health.questions.find((q) => q.question_id === bad)!;
    assert.equal(row.correct, 0);
    assert.ok(row.warnings.some((w) => w.includes('answer key')));
    assert.equal(health.questions.find((q) => q.question_id === fine)?.warnings.length, 0);
  });
});

describe('accessibility profiles', () => {
  test('students change display settings outside exams only; admins grant extra time', () => {
    const exam = makeExam([MC('q', 0)], { duration: 20 });
    const s = enrol(exam);
    let profile = updateOwnPrefs(userRepo.findById(s.id)!, { text_size: 'large', contrast: 'high', bogus: 1 });
    assert.equal(profile.prefs.text_size, 'large');
    assert.equal(profile.prefs.contrast, 'high');
    assert.equal(profile.prefs.reduce_motion, false);
    profile = updateOwnPrefs(userRepo.findById(s.id)!, { text_size: 'gigantic' });
    assert.equal(profile.prefs.text_size, 'large', 'unknown values keep the current setting');

    adminUpdateProfile(userRepo.findById(s.id)!, { time_multiplier: 1.5 });
    assert.throws(() => adminUpdateProfile(userRepo.findById(s.id)!, { time_multiplier: 5 }), /between/);

    const started = startAttempt(s.id, exam.versionId, ctx(null));
    const minutes = (toMs(started.attempt.expires_at!) - toMs(started.attempt.started_at)) / 60_000;
    assert.ok(Math.abs(minutes - 30) < 0.1, `1.5 × 20 min, got ${minutes}`);
    assert.equal(profileFor(userRepo.findById(s.id)!).locked_by_attempt, started.attempt.id);
    assert.throws(() => updateOwnPrefs(userRepo.findById(s.id)!, { text_size: 'normal' }), /not during/);
  });
});
