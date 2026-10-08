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
import { finalize } from './services/attempts.js';
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

console.log('[seed] done. Demo accounts:');
console.log('  admin:       admin@saide.local / admin123');
console.log('  instructor:  shlok@iitrpr.ac.in / instructor123');
console.log('  students:    student1..student8@iitrpr.ac.in / student123  (entry numbers 2023CSB0001…0008)');
console.log('  access code for "HCI Basics — Checkpoint Quiz 1": HCI-2026');
console.log(`  db file:     ${db ? 'apps/api/data/interval.db' : ''}`);
void admin;