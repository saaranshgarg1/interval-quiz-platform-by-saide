import { db } from './db.js';
import {
  userRepo,
  courseRepo,
  quizRepo,
  quizVersionRepo,
  questionRepo,
  attemptRepo,
  answerRepo,
} from './repo.js';
import { hashPassword } from './auth.js';
import { shuffle, nowUtc, addMinutes } from './util.js';
import { finalize } from './services/attempts.js';

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
    finalize(attempt, 'submitted', nowUtc());
  };
  mk(students[0]!, 0);
  mk(students[1]!, 1);
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
console.log('  students:    student1..student8@iitrpr.ac.in / student123');
console.log(`  db file:     ${db ? 'apps/api/data/interval.db' : ''}`);
void admin;