import { db } from './db.js';
import {
  userRepo,
  courseRepo,
  quizRepo,
  quizVersionRepo,
  questionRepo,
  attemptRepo,
  answerRepo,
  bankRepo,
  slotRepo,
} from './repo.js';
import { hashPassword } from './auth.js';
import { shuffle, nowUtc, addMinutes } from './util.js';
import { finalize, startAttempt, getAttemptForStudent, saveAnswers, submitAttempt } from './services/attempts.js';
import { applyPreset, defaultSettings, normalizeSettings } from './services/exam-settings.js';

console.log('[seed] seeding Interval demo data…');

function orCreateUser(name: string, email: string, role: 'student' | 'instructor' | 'admin', password: string) {
  const existing = userRepo.findByEmail(email);
  if (existing) return existing;
  return userRepo.create(name, email, hashPassword(password), role);
}

const admin = orCreateUser('Portal Admin', 'admin@saide.local', 'admin', 'admin123');
const shlok = orCreateUser('Dr. Shlok', 'shlok@iitrpr.ac.in', 'instructor', 'instructor123');
const saaransh = orCreateUser('Prof. Saaransh Garg', 'saaransh@iitrpr.ac.in', 'instructor', 'instructor123');

const students = [
  orCreateUser('Aisha Khan', 'student1@iitrpr.ac.in', 'student', 'student123'),
  orCreateUser('Rohan Verma', 'student2@iitrpr.ac.in', 'student', 'student123'),
  orCreateUser('Meera Nair', 'student3@iitrpr.ac.in', 'student', 'student123'),
  orCreateUser('Kabir Singh', 'student4@iitrpr.ac.in', 'student', 'student123'),
  orCreateUser('Sana Iqbal', 'student5@iitrpr.ac.in', 'student', 'student123'),
  orCreateUser('Dev Joshi', 'student6@iitrpr.ac.in', 'student', 'student123'),
  orCreateUser('Tara Sethi', 'student7@iitrpr.ac.in', 'student', 'student123'),
  orCreateUser('Arjun Mehta', 'student8@iitrpr.ac.in', 'student', 'student123'),
];

// Entry numbers (IIT Ropar roll numbers) so instructors can extend time / message by entry number.
students.forEach((s, i) => {
  if (!s.entry_number) userRepo.setEntryNumber(s.id, `2023CSB${String(i + 1).padStart(4, '0')}`);
});

/** Monitored exam: switches counted (lock at 3), copy/paste blocked, watermark, access code. */
const MONITORED_EXAM = JSON.stringify(
  normalizeSettings({ violation_action: 'lock', max_violations: 3, access_code: 'HCI-2026' }, applyPreset(defaultSettings(), 'standard')),
);

function ensureCourse(code: string, name: string, ownerId: number): number {
  const existing = db.prepare('SELECT id FROM courses WHERE code = ?').get(code) as { id: number } | undefined;
  if (existing) return existing.id;
  return courseRepo.create(code, name, ownerId).course.id;
}

// ------------------------------------------------------------------ AI511
const ai511Id = ensureCourse('AI511', 'Human-Computer Interaction', shlok.id);
for (const s of students) courseRepo.addMember(ai511Id, s.id, 'student');
courseRepo.addMember(ai511Id, saaransh.id, 'instructor');

const ai511Quizzes = db
  .prepare('SELECT id FROM quizzes WHERE course_id = ? ORDER BY id')
  .all(ai511Id) as { id: number }[];

function createCheckpointQuiz() {
  const quizId = quizRepo.create(ai511Id, shlok.id);
  const vId = quizVersionRepo.createDraft(quizId, ai511Id, shlok.id, 1);
  quizVersionRepo.updateMeta(vId, {
    title: 'HCI Basics — Checkpoint Quiz 1',
    instructions: 'Answer all questions. Answers are saved automatically; your receipt confirms submission.',
    duration_minutes: 10,
    shuffle_questions: 1,
    shuffle_options: 1,
    attempts_allowed: 1,
    integrity_policy: 'strict',
    policy_trigger: 'focus_exit',
    show_scores: 'release',
    exam_settings: MONITORED_EXAM,
  });
  questionRepo.create(vId, {
    qtype: 'single',
    text: 'Which design principle best explains why a quiz should show whether an answer is saved?',
    options: ['Recognition over recall', 'Visibility of system status', 'Consistency and standards', 'Error recovery'],
    answer: 1,
    points: 1,
  });
  questionRepo.create(vId, {
    qtype: 'multiple',
    text: 'Select the states a student should be able to distinguish (G2).',
    options: ['Pending', 'Saving', 'Saved', 'Submitted'],
    answer: [0, 1, 2, 3],
    points: 2,
  });
  questionRepo.create(vId, {
    qtype: 'numeric',
    text: 'If 350 students save once every 5 seconds, what is the approximate save rate in requests per second?',
    answer: 70,
    tolerance: 1,
    points: 1,
  });
  questionRepo.create(vId, {
    qtype: 'short',
    text: 'Name the design heuristic that motivates keeping question and answer on the same surface.',
    answer: 'consistency',
    points: 1,
  });
  quizVersionRepo.publish(vId);
  return { quizId, versionId: vId };
}

const hasPublishedCheckpoint = db
  .prepare("SELECT COUNT(*) AS n FROM quiz_versions WHERE course_id = ? AND status = 'published'")
  .get(ai511Id) as { n: number };
if (Number(hasPublishedCheckpoint.n) === 0 || ai511Quizzes.length === 0) {
  createCheckpointQuiz();
}

// Unpublished draft quiz for the authoring-task demo.
const draftExists = db
  .prepare("SELECT COUNT(*) AS n FROM quiz_versions WHERE course_id = ? AND status = 'draft'")
  .get(ai511Id) as { n: number };
if (!Number(draftExists.n)) {
  const quizId = quizRepo.create(ai511Id, shlok.id);
  const vId = quizVersionRepo.createDraft(quizId, ai511Id, shlok.id, 1);
  quizVersionRepo.updateMeta(vId, {
    title: 'HCI Evaluation Methods — Quiz 2 (draft)',
    instructions: 'Practice quiz. You may retake it any number of times.',
    duration_minutes: 15,
    shuffle_questions: 1,
    shuffle_options: 1,
    attempts_allowed: 3,
    integrity_policy: 'warn',
    policy_trigger: 'focus_exit',
    show_scores: 'release',
  });
  questionRepo.create(vId, {
    qtype: 'single',
    text: 'Which method observes users completing predefined tasks in a controlled setting?',
    options: ['Field study', 'Usability testing', 'Survey', 'Heuristic evaluation'],
    answer: 1,
    points: 1,
  });
}

// A question pool with difficulty levels; the draft quiz draws one easy and one
// hard question per student from it (each worth 2 marks).
const poolExists = db
  .prepare("SELECT id FROM question_banks WHERE course_id = ? AND name = 'HCI question pool'")
  .get(ai511Id) as { id: number } | undefined;
if (!poolExists) {
  const bank = bankRepo.create(ai511Id, shlok.id, 'HCI question pool', 'Mixed-difficulty pool for randomized quizzes');
  const pool: { text: string; options: string[]; answer: number; difficulty: 'easy' | 'medium' | 'hard'; tags: string[] }[] = [
    { text: 'Which heuristic says the system should keep users informed about what is going on?', options: ['Visibility of system status', 'Error prevention', 'Flexibility and efficiency', 'Aesthetic design'], answer: 0, difficulty: 'easy', tags: ['heuristics'] },
    { text: 'A user cannot undo an accidental delete. Which heuristic is violated?', options: ['User control and freedom', 'Recognition over recall', 'Consistency and standards', 'Help and documentation'], answer: 0, difficulty: 'easy', tags: ['heuristics'] },
    { text: 'Greying out a Submit button until the form is valid is an example of…', options: ['Error prevention', 'Aesthetic design', 'Match with the real world', 'Help users recover'], answer: 0, difficulty: 'easy', tags: ['heuristics'] },
    { text: 'Fitts’s law predicts that pointing time grows with…', options: ['distance and decreases with target size', 'target size only', 'number of menu items', 'screen brightness'], answer: 0, difficulty: 'medium', tags: ['models'] },
    { text: 'Hick’s law relates decision time to…', options: ['the number of choices', 'pointer speed', 'font size', 'colour contrast'], answer: 0, difficulty: 'medium', tags: ['models'] },
    { text: 'Which evaluation method needs no users at all?', options: ['Heuristic evaluation', 'Think-aloud study', 'A/B test', 'Field observation'], answer: 0, difficulty: 'medium', tags: ['evaluation'] },
    { text: 'In GOMS/KLM, which operator models mental preparation before an action?', options: ['M', 'K', 'P', 'H'], answer: 0, difficulty: 'hard', tags: ['models'] },
    { text: 'A within-subjects study with two interfaces should counterbalance order mainly to control…', options: ['learning and fatigue effects', 'sample size', 'screen size', 'task difficulty'], answer: 0, difficulty: 'hard', tags: ['evaluation'] },
    { text: 'The SUS questionnaire produces a score on what scale?', options: ['0–100', '1–5', '1–7', '0–10'], answer: 0, difficulty: 'hard', tags: ['evaluation'] },
  ];
  for (const q of pool) bankRepo.addQuestion(bank.id, { qtype: 'single', points: 1, ...q });
  const draft = db
    .prepare("SELECT id FROM quiz_versions WHERE course_id = ? AND status = 'draft' ORDER BY id LIMIT 1")
    .get(ai511Id) as { id: number } | undefined;
  if (draft) {
    slotRepo.create(draft.id, { bank_id: bank.id, difficulty: 'easy', tag: null, points: 2, time_limit_seconds: null });
    slotRepo.create(draft.id, { bank_id: bank.id, difficulty: 'hard', tag: null, points: 2, time_limit_seconds: null });
  }
}

// ------------------------------------------------------------------ CS305
const cs305Id = ensureCourse('CS305', 'Database Systems', saaransh.id);
for (const s of students.slice(0, 6)) courseRepo.addMember(cs305Id, s.id, 'student');

const cs305Published = db
  .prepare("SELECT qv.id AS vid FROM quiz_versions qv WHERE qv.status = 'published' AND qv.course_id = ? ORDER BY qv.id DESC LIMIT 1")
  .get(cs305Id) as { vid: number } | undefined;

if (!cs305Published) {
  const quizId = quizRepo.create(cs305Id, saaransh.id);
  const vId = quizVersionRepo.createDraft(quizId, cs305Id, saaransh.id, 1);
  quizVersionRepo.updateMeta(vId, {
    title: 'SQL Basics — Practice Set',
    instructions: 'Practice only. Immediate scoring is shown.',
    duration_minutes: 5,
    shuffle_questions: 0,
    shuffle_options: 0,
    attempts_allowed: 999,
    integrity_policy: 'off',
    policy_trigger: 'focus_exit',
    show_scores: 'immediate',
  });
  questionRepo.create(vId, {
    qtype: 'single',
    text: 'Which clause filters rows before aggregation?',
    options: ['WHERE', 'HAVING', 'ORDER BY', 'GROUP BY'],
    answer: 0,
    points: 1,
  });
  quizVersionRepo.publish(vId);

  const version = quizVersionRepo.latestPublished(quizId)!;
  const qs = questionRepo.listForVersion(version.id);
  const seed = 123;

  const mk = (student: ReturnType<typeof orCreateUser>, answer: unknown) => {
    const attId = attemptRepo.create(
      version.id,
      student.id,
      JSON.stringify(qs.map((q) => q.id)),
      seed,
      null,
    );
    for (const q of qs) answerRepo.save(attId, q.id, qs.indexOf(q), JSON.stringify(answer), 1);
    const attempt = attemptRepo.get(attId)!;
    finalize(attempt, 'submitted', 'submitted_by_student', nowUtc());
  };
  mk(students[0]!, 0);
  mk(students[1]!, 1);
}

// A second exam live at the same time, in another course: one-way navigation with
// a 90-second timer per question, full screen, no exit & resume.
const cs305Timed = db
  .prepare("SELECT COUNT(*) AS n FROM quiz_versions WHERE course_id = ? AND title LIKE 'Timed%'")
  .get(cs305Id) as { n: number };
if (!Number(cs305Timed.n)) {
  const quizId = quizRepo.create(cs305Id, saaransh.id);
  const vId = quizVersionRepo.createDraft(quizId, cs305Id, saaransh.id, 1);
  quizVersionRepo.updateMeta(vId, {
    title: 'Timed Check — SQL Joins',
    instructions: 'One question at a time with its own timer. Full screen is required and you cannot leave and come back.',
    duration_minutes: 20,
    shuffle_questions: 1,
    shuffle_options: 1,
    attempts_allowed: 1,
    show_scores: 'release',
    integrity_policy: 'strict',
    exam_settings: JSON.stringify(
      normalizeSettings({ question_timer: 'uniform', question_time_seconds: 90 }, applyPreset(defaultSettings(), 'strict')),
    ),
  });
  questionRepo.create(vId, {
    qtype: 'single',
    text: 'Which join returns only rows with matches in both tables?',
    options: ['INNER JOIN', 'LEFT JOIN', 'FULL OUTER JOIN', 'CROSS JOIN'],
    answer: 0,
    points: 1,
  });
  questionRepo.create(vId, {
    qtype: 'multiple',
    text: 'Which of these can produce NULLs in columns from the right table?',
    options: ['LEFT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'NATURAL JOIN'],
    answer: [0, 2],
    points: 2,
  });
  questionRepo.create(vId, {
    qtype: 'numeric',
    text: 'A CROSS JOIN of a 4-row table with a 6-row table returns how many rows?',
    answer: 24,
    tolerance: 0,
    points: 1,
  });
  quizVersionRepo.publish(vId);
}

// One in-progress, partially saved attempt for student2 on the AI511 checkpoint,
// so the "continue attempt" path has a live example.
const ai511Checkpoint = db
  .prepare("SELECT qv.id AS vid FROM quiz_versions qv WHERE qv.status = 'published' AND qv.course_id = ? ORDER BY qv.id LIMIT 1")
  .get(ai511Id) as { vid: number } | undefined;
const rohan = students[1]!;
if (ai511Checkpoint && attemptRepo.usedAttempts(rohan.id, ai511Checkpoint.vid) === 0) {
  const qs = questionRepo.listForVersion(ai511Checkpoint.vid);
  const seed = 7;
  const order = shuffle(qs.map((q) => q.id), seed);
  const attId = attemptRepo.create(ai511Checkpoint.vid, rohan.id, JSON.stringify(order), seed, addMinutes(10));
  const first = qs[0];
  if (first) answerRepo.save(attId, first.id, order.indexOf(first.id), '1', 1);
}

// A finished, graded exam to try the post-exam tools on (Results → Marking,
// Questions & regrade, Random fairness, Cheating check): a written question
// and assumption boxes, one random bank question per student, a question whose
// key was entered wrongly (B is right), and two students who copied.
const gradedDemo = db
  .prepare("SELECT COUNT(*) AS n FROM quiz_versions WHERE course_id = ? AND title LIKE 'Mid-sem%'")
  .get(ai511Id) as { n: number };
const pool = db
  .prepare("SELECT id FROM question_banks WHERE course_id = ? AND name = 'HCI question pool'")
  .get(ai511Id) as { id: number } | undefined;
if (!Number(gradedDemo.n) && pool) {
  const quizId = quizRepo.create(ai511Id, shlok.id);
  const vId = quizVersionRepo.createDraft(quizId, ai511Id, shlok.id, 1);
  quizVersionRepo.updateMeta(vId, {
    title: 'Mid-sem — HCI Principles (graded demo)',
    instructions: 'Finished exam with submissions, for trying marking, regrading, fairness and the cheating check.',
    duration_minutes: 45,
    shuffle_questions: 0,
    shuffle_options: 0,
    attempts_allowed: 1,
    show_scores: 'release',
    exam_settings: JSON.stringify(applyPreset(defaultSettings(), 'standard')),
  });
  const q = (input: Parameters<typeof questionRepo.create>[1]) => questionRepo.create(vId, input).id;
  const q1 = q({ qtype: 'single', text: 'How many usability heuristics did Nielsen publish in 1994?', options: ['8', '10', '12', '15'], answer: 1, points: 1 });
  const q2 = q({
    qtype: 'single',
    text: 'Which law predicts the time to point at a target?',
    options: ['Hick’s law', 'Fitts’s law', 'Moore’s law', 'Miller’s law'],
    answer: 0, // deliberately wrong key: regrade it to B
    points: 1,
  });
  const q3 = q({
    qtype: 'multiple',
    text: 'Which evaluation methods need no real users?',
    options: ['Heuristic evaluation', 'Cognitive walkthrough', 'Think-aloud study', 'A/B test'],
    answer: [0, 1],
    points: 2,
  });
  const q4 = q({ qtype: 'single', text: 'Miller’s “magical number” for short-term memory is…', options: ['3 ± 1', '5 ± 2', '7 ± 2', '9 ± 2'], answer: 2, points: 1 });
  const q5 = q({
    qtype: 'numeric',
    text: 'Fitts’s index of difficulty log₂(D/W + 1) for a target 8 cm away and 2 cm wide (2 decimals)?',
    answer: 2.32,
    tolerance: 0.05,
    points: 2,
    allow_assumptions: true,
  });
  const q6 = q({ qtype: 'single', text: 'Which of these is a Gestalt principle?', options: ['Proximity', 'Affordance', 'Latency', 'Recall'], answer: 0, points: 1 });
  slotRepo.create(vId, { bank_id: pool.id, difficulty: 'medium', tag: null, points: 2, time_limit_seconds: null });
  const q8 = q({
    qtype: 'descriptive',
    text: 'Explain why recognition is easier than recall, and give one interface example of each.',
    answer: '2 marks: recognition gives cues / recall needs retrieval without cues. 1 mark each: a recognition example (menu) and a recall example (command line). 1 mark: clarity.',
    points: 5,
    allow_assumptions: true,
  });
  quizVersionRepo.publish(vId);

  const copied = 'Recognition is easier because the interface shows you the options so you only have to spot the right one while recall means you must remember it with no cues at all. A menu bar is recognition and typing a terminal command is recall.';
  const sheets: { student: number; answers: Record<number, unknown>; assumptions?: Record<number, string> }[] = [
    { student: 0, answers: { [q1]: 1, [q2]: 1, [q3]: [0, 1], [q4]: 2, [q5]: 2.32, [q6]: 0, [q8]: 'Recall requires retrieving information from memory without help, whereas recognition only needs us to match what we see against memory. Menus and toolbars support recognition; a command line like bash relies on recall.' } },
    { student: 1, answers: { [q1]: 1, [q2]: 1, [q3]: [0], [q4]: 2, [q5]: 2.3, [q6]: 0, [q8]: 'Because seeing something triggers memory. Example: icons (recognition) vs passwords (recall).' }, assumptions: { [q5]: 'Rounded to one decimal place first.' } },
    { student: 2, answers: { [q1]: 2, [q2]: 1, [q3]: [0, 1], [q4]: 1, [q5]: 2, [q6]: 0, [q8]: 'Recognition uses cues from the screen.' }, assumptions: { [q5]: 'I assumed D is measured to the near edge of the target, so D = 7 and W = 2.' } },
    { student: 3, answers: { [q1]: 3, [q2]: 1, [q3]: [2, 3], [q4]: 0, [q5]: 9.99, [q6]: 3, [q8]: copied } },
    { student: 4, answers: { [q1]: 1, [q2]: 0, [q3]: [0, 1], [q4]: 2, [q5]: 2.32, [q6]: 0, [q8]: '' } },
    { student: 5, answers: { [q1]: 3, [q2]: 1, [q3]: [2, 3], [q4]: 0, [q5]: 9.99, [q6]: 3, [q8]: `${copied}` } },
    { student: 6, answers: { [q1]: 0, [q2]: 1, [q3]: [0, 2], [q4]: 2, [q5]: 1.58, [q6]: 1, [q8]: 'Recall is harder since nothing on screen helps you. Autocomplete turns recall into recognition.' } },
    { student: 7, answers: { [q1]: 1, [q2]: 1, [q3]: [1], [q4]: 3, [q5]: 2.32, [q6]: 0 } },
  ];
  for (const sheet of sheets) {
    const s = students[sheet.student]!;
    const started = startAttempt(s.id, vId);
    const view = getAttemptForStudent(s.id, started.attempt.id);
    const drawn = view.questions.find((x) => questionRepo.get(x.id)?.slot_id);
    const items = Object.entries(sheet.answers).map(([qid, answer]) => ({
      question_id: Number(qid),
      answer,
      revision: 1,
      assumption: sheet.assumptions?.[Number(qid)],
    }));
    // Random question: most get it right, two do not.
    if (drawn) items.push({ question_id: drawn.id, answer: sheet.student % 4 === 2 ? 1 : 0, revision: 1, assumption: undefined });
    saveAnswers(s.id, started.attempt.id, { answers: items });
    submitAttempt(s.id, started.attempt.id);
  }
}

console.log('[seed] done. Demo accounts:');
console.log('  admin:       admin@saide.local / admin123');
console.log('  instructor:  shlok@iitrpr.ac.in / instructor123');
console.log('  students:    student1..student8@iitrpr.ac.in / student123  (entry numbers 2023CSB0001…0008)');
console.log('  access code for "HCI Basics — Checkpoint Quiz 1": HCI-2026');
console.log(`  db file:     ${db ? 'apps/api/data/interval.db' : ''}`);
void admin;