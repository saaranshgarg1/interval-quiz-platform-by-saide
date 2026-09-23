import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { userRepo, courseRepo, quizRepo, quizVersionRepo, questionRepo, attemptRepo, bankRepo, accommodationRepo, analyticsRepo, resultRepo } from '../repo.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { startAttempt, saveAnswers, finalize } from '../services/attempts.js';
import { gradeAttempt, isAnswerCorrect } from '../services/grading.js';
import { applyIntegrityEvent } from '../services/policy.js';
import type { Question } from '../types.js';

describe('Interval E2E Verification & Test Suite', () => {
  test('Auth & Security: password hashing and verification', () => {
    const password = 'SecretPassword123!';
    const hash = hashPassword(password);
    assert.notEqual(hash, password, 'Password must be hashed with salt');
    assert.ok(verifyPassword(password, hash), 'Correct password must verify');
    assert.ok(!verifyPassword('WrongPass', hash), 'Incorrect password must reject');
  });

  test('Course & Membership Management', () => {
    const email = `instructor_${Date.now()}@iitrpr.ac.in`;
    const inst = userRepo.create('Prof. Sharma', email, hashPassword('pwd'), 'instructor');
    const { course } = courseRepo.create('CS501', 'Advanced HCI', inst.id);
    
    assert.equal(course.code, 'CS501');
    const role = courseRepo.courseRole(course.id, inst.id);
    assert.equal(role, 'instructor');

    const studentEmail = `student_${Date.now()}@iitrpr.ac.in`;
    const student = userRepo.create('Aarav', studentEmail, hashPassword('pwd'), 'student');
    courseRepo.addMember(course.id, student.id, 'student');

    const studentRole = courseRepo.courseRole(course.id, student.id);
    assert.equal(studentRole, 'student');
  });

  test('Quiz Versioning & Immutability: Draft to Published clone cycle', () => {
    const inst = userRepo.create('Dr. Gupta', `gupta_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'instructor');
    const { course } = courseRepo.create('CS301', 'Database Systems', inst.id);
    const quizId = quizRepo.create(course.id, inst.id);
    const versionId = quizVersionRepo.createDraft(quizId, course.id, inst.id, 1);
    const version = quizVersionRepo.get(versionId)!;

    assert.equal(version.status, 'draft');
    assert.equal(version.version, 1);

    // Add question
    const q = questionRepo.create(versionId, {
      qtype: 'single',
      text: 'What is ACID?',
      options: ['Atomicity...', 'Algorithm...', 'Action...', 'None'],
      answer: 0,
      points: 2,
    });
    assert.equal(q.points, 2);

    // Publish
    quizVersionRepo.publish(versionId);
    const pub = quizVersionRepo.get(versionId)!;
    assert.equal(pub.status, 'published');

    // Clone into new draft
    const newDraft = quizVersionRepo.clonePublished(quizId, inst.id);
    assert.equal(newDraft.status, 'draft');
    assert.equal(newDraft.version, 2);
  });

  test('Question Banks & Tagging System', () => {
    const inst = userRepo.create('Prof. Verma', `verma_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'instructor');
    const { course } = courseRepo.create('AI201', 'Artificial Intelligence', inst.id);
    
    const bank = bankRepo.create(course.id, inst.id, 'Search Algorithms', 'Heuristics & trees');
    assert.equal(bank.name, 'Search Algorithms');

    const bq = bankRepo.addQuestion(bank.id, {
      qtype: 'single',
      text: 'What is the admissibility condition in A* search?',
      options: ['h(n) <= h*(n)', 'h(n) >= h*(n)', 'h(n) = 0', 'None'],
      answer: 0,
      points: 1.5,
      tags: ['astar', 'heuristics', 'easy'],
    });

    assert.equal(bq.tags.length, 3);
    assert.ok(bq.tags.includes('astar'));

    const list = bankRepo.listQuestions(bank.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, bq.id);
  });

  test('Student Accommodations: Extra time multiplier calculation', () => {
    const inst = userRepo.create('Prof. Rao', `rao_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'instructor');
    const student = userRepo.create('Priya', `priya_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'student');
    const { course } = courseRepo.create('PH101', 'Physics', inst.id);
    courseRepo.addMember(course.id, student.id, 'student');

    // Grant 1.5x time accommodation
    const acc = accommodationRepo.upsert(course.id, student.id, 1.5, 5, 'Visual accommodation');
    assert.equal(acc.time_multiplier, 1.5);
    assert.equal(acc.extra_minutes, 5);

    const fetched = accommodationRepo.get(course.id, student.id);
    assert.equal(fetched?.time_multiplier, 1.5);
    assert.equal(fetched?.extra_minutes, 5);
  });

  test('Auto-Grading Engine: single, multiple, numeric with tolerance, short answer', () => {
    const qSingle: Question = {
      id: 1, quiz_version_id: 1, version: 1, qtype: 'single',
      text: 'Sample', options: ['A', 'B'], answer: 0, tolerance: null, points: 2, order_index: 0, is_latest: 1, created_at: ''
    };
    assert.ok(isAnswerCorrect(qSingle, 0));
    assert.ok(!isAnswerCorrect(qSingle, 1));

    const qMulti: Question = {
      id: 2, quiz_version_id: 1, version: 1, qtype: 'multiple',
      text: 'Select even primes', options: ['2', '3', '4', '5'], answer: [0], tolerance: null, points: 2, order_index: 1, is_latest: 1, created_at: ''
    };
    assert.ok(isAnswerCorrect(qMulti, [0]));
    assert.ok(!isAnswerCorrect(qMulti, [0, 1]));

    const qNum: Question = {
      id: 3, quiz_version_id: 1, version: 1, qtype: 'numeric',
      text: 'Value of pi', options: [], answer: 3.14, tolerance: 0.01, points: 3, order_index: 2, is_latest: 1, created_at: ''
    };
    assert.ok(isAnswerCorrect(qNum, 3.1415));
    assert.ok(isAnswerCorrect(qNum, 3.135));
    assert.ok(!isAnswerCorrect(qNum, 3.10));

    const qShort: Question = {
      id: 4, quiz_version_id: 1, version: 1, qtype: 'short',
      text: 'Capital of India', options: [], answer: 'New Delhi', tolerance: null, points: 1, order_index: 3, is_latest: 1, created_at: ''
    };
    assert.ok(isAnswerCorrect(qShort, 'new delhi'));
    assert.ok(isAnswerCorrect(qShort, '  NEW DELHI  '));
    assert.ok(!isAnswerCorrect(qShort, 'Mumbai'));
  });

  test('Integrity Policy Enforcement: warn vs strict locking', () => {
    const inst = userRepo.create('Dr. Test', `drtest_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'instructor');
    const student = userRepo.create('Student T', `studt_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'student');
    const { course } = courseRepo.create('CS100', 'Intro', inst.id);
    courseRepo.addMember(course.id, student.id, 'student');

    const quizId = quizRepo.create(course.id, inst.id);
    const versionId = quizVersionRepo.createDraft(quizId, course.id, inst.id, 1);
    quizVersionRepo.updateMeta(versionId, { integrity_policy: 'strict', duration_minutes: 30 });
    questionRepo.create(versionId, {
      qtype: 'short',
      text: 'Q1',
      options: [],
      answer: 'ans',
      points: 1,
    });
    quizVersionRepo.publish(versionId);

    const attemptView = startAttempt(student.id, versionId);
    assert.equal(attemptView.attempt.status, 'in_progress');

    const attempt = attemptRepo.get(attemptView.attempt.id)!;
    const policyResult = applyIntegrityEvent(attempt, 'strict', 'focus_exit', 'focus_exit', 'Tab switched away');
    assert.equal(policyResult.action, 'locked');

    const updated = attemptRepo.get(attemptView.attempt.id);
    assert.equal(updated?.status, 'locked');
  });

  test('Idempotent Answer Saves and Revision Reconciliation', () => {
    const inst = userRepo.create('Dr. S', `drs_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'instructor');
    const student = userRepo.create('Student S', `studs_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'student');
    const { course } = courseRepo.create('CS101', 'Intro CS', inst.id);
    courseRepo.addMember(course.id, student.id, 'student');

    const quizId = quizRepo.create(course.id, inst.id);
    const versionId = quizVersionRepo.createDraft(quizId, course.id, inst.id, 1);
    const q1 = questionRepo.create(versionId, {
      qtype: 'single',
      text: '2+2?',
      options: ['3', '4'],
      answer: 1,
      points: 1,
    });
    quizVersionRepo.publish(versionId);

    const attempt = startAttempt(student.id, versionId);

    // First save: Revision 1
    const res1 = saveAnswers(student.id, attempt.attempt.id, {
      answers: [{ question_id: q1.id, answer: 1, revision: 1 }],
    });
    assert.equal(res1.acks[0]?.revision, 1);
    assert.equal(res1.acks[0]?.acknowledged, true);

    // Second save: Revision 2
    const res2 = saveAnswers(student.id, attempt.attempt.id, {
      answers: [{ question_id: q1.id, answer: 0, revision: 2 }],
    });
    assert.equal(res2.acks[0]?.revision, 2);
    assert.equal(res2.acks[0]?.acknowledged, true);
  });

  test('Analytics & Item Psychometrics Calculation', () => {
    const inst = userRepo.create('Dr. Analytics', `drana_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'instructor');
    const { course } = courseRepo.create('STAT101', 'Statistics', inst.id);
    const quizId = quizRepo.create(course.id, inst.id);
    const versionId = quizVersionRepo.createDraft(quizId, course.id, inst.id, 1);

    const q1 = questionRepo.create(versionId, {
      qtype: 'single',
      text: 'Mean of 2 and 4?',
      options: ['2', '3', '4'],
      answer: 1,
      points: 5,
    });
    quizVersionRepo.publish(versionId);

    // Create 2 students and submit
    const s1 = userRepo.create('S1', `s1_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'student');
    const s2 = userRepo.create('S2', `s2_${Date.now()}@iitrpr.ac.in`, hashPassword('pwd'), 'student');
    courseRepo.addMember(course.id, s1.id, 'student');
    courseRepo.addMember(course.id, s2.id, 'student');

    const att1 = startAttempt(s1.id, versionId);
    saveAnswers(s1.id, att1.attempt.id, {
      answers: [{ question_id: q1.id, answer: 1, revision: 1 }],
    }); // Correct
    finalize(attemptRepo.get(att1.attempt.id)!, 'submitted');

    const att2 = startAttempt(s2.id, versionId);
    saveAnswers(s2.id, att2.attempt.id, {
      answers: [{ question_id: q1.id, answer: 0, revision: 1 }],
    }); // Incorrect
    finalize(attemptRepo.get(att2.attempt.id)!, 'submitted');

    const analytics = analyticsRepo.getQuizAnalytics(versionId);
    assert.equal(analytics.total_attempts, 2);
    assert.equal(analytics.submitted_count, 2);
    assert.equal(analytics.mean_score, 2.5);
    assert.equal(analytics.highest_score, 5);
    assert.equal(analytics.lowest_score, 0);
    assert.equal(analytics.question_analytics.length, 1);
    assert.equal(analytics.question_analytics[0]?.accuracy_rate, 0.5);
  });
});
