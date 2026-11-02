import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(here, '../data/demo');
if (process.env.NODE_ENV === 'production') throw new Error('Demo fixtures are not for production.');
if (!process.env.INTERVAL_DATA_DIR || path.resolve(process.env.INTERVAL_DATA_DIR) !== demoDir) {
  throw new Error(`Set INTERVAL_DATA_DIR=${demoDir}. The ordinary assessment database is never a demo target.`);
}
if (fs.existsSync(path.join(demoDir, 'interval.db'))) {
  throw new Error('Demo database already exists. Preserve it before preparing a fresh demo; this script never deletes data.');
}

const { db, migrate, transaction } = await import('./db.js');
const { userRepo, courseRepo, quizRepo, quizVersionRepo, questionRepo } = await import('./repo.js');
const { hashPassword } = await import('./auth.js');
const { defaultSettings } = await import('./services/exam-settings.js');
const { startAttempt, saveAnswers, submitAttempt } = await import('./services/attempts.js');
migrate();

try {
  transaction(() => {
    const instructor = userRepo.create('Demo Instructor', 'instructor@example.com', hashPassword('DemoInstructor123!'), 'instructor');
    const student = userRepo.create('Demo Student', 'student@example.com', hashPassword('DemoStudent123!'), 'student', 'DEMO001');
    const completed = userRepo.create('Demo Learner A', 'learner-a@example.com', hashPassword('DemoStudent123!'), 'student', 'DEMO002');
    const second = userRepo.create('Demo Learner B', 'learner-b@example.com', hashPassword('DemoStudent123!'), 'student', 'DEMO003');
    const course = courseRepo.create('AI511', 'Human–Computer Interaction — Demo', instructor.id).course;
    for (const person of [student, completed, second]) courseRepo.addMember(course.id, person.id, 'student');

    function quiz(title: string, published: boolean) {
      const quizId = quizRepo.create(course.id, instructor.id);
      const versionId = quizVersionRepo.createDraft(quizId, course.id, instructor.id, 1);
      quizVersionRepo.updateMeta(versionId, {
        title,
        instructions: 'Fictional demo data. Answer the three questions, wait for the saved acknowledgement, then confirm submission.',
        duration_minutes: 15,
        attempts_allowed: 10,
        integrity_policy: 'off',
        show_scores: 'immediate',
        exam_settings: JSON.stringify(defaultSettings()),
      });
      const questions = [
        questionRepo.create(versionId, {
          qtype: 'single', text: 'Which HCI principle explains showing whether an answer was saved?',
          options: ['Visibility of system status', 'Minimal feedback', 'Hidden state', 'Recall from memory'], answer: 0, points: 1,
        }),
        questionRepo.create(versionId, {
          qtype: 'multiple', text: 'Which interface choices support error recovery?',
          options: ['Retain editable input', 'Explain the error and offer retry', 'Discard input silently', 'Hide the failure'], answer: [0, 1], points: 2,
        }),
        questionRepo.create(versionId, {
          qtype: 'numeric', text: 'Five users attempt a task and four complete it. What is the completion percentage?',
          answer: 80, tolerance: 0, points: 1,
        }),
      ];
      if (published) quizVersionRepo.publish(versionId);
      return { quizId, versionId, questions };
    }

    quiz('HCI Practice — Start Here', true);
    quiz('Authoring Demo — Draft', false);
    const results = quiz('Results Demo — Fictional Submissions', true);
    for (const [person, values] of [[completed, [0, [0, 1], 80]], [second, [1, [0], 80]]] as const) {
      const view = startAttempt(person.id, results.versionId);
      saveAnswers(person.id, view.attempt.id, {
        answers: results.questions.map((question, i) => ({ question_id: question.id, answer: values[i], revision: 1 })),
      });
      submitAttempt(person.id, view.attempt.id);
    }
    console.log('Prepared demo: 4 fictional users, 1 course, 3 quizzes (practice, draft, results), 2 submitted attempts.');
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
} finally {
  db.close();
}
