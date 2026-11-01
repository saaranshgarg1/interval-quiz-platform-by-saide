import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestionData } from '../services/question-validation.js';
import { isAnswerCorrect } from '../services/grading.js';
import type { Question } from '../types.js';
import { TestHarness } from './harness.js';
import { courseRepo } from '../repo.js';

const question = { text: 'Validation question', points: 1 };

test('numeric answers reject blank and nonnumeric JSON shapes, but accept explicit zero', () => {
  for (const answer of ['', '   ', null, false, true, [], [0], {}]) {
    assert.throws(() => validateQuestionData({ ...question, qtype: 'numeric', answer }), /Numeric answer must be a number/);
  }
  for (const answer of [0, '0', ' 0 ', -2.5, '1e3']) {
    const validated = validateQuestionData({ ...question, qtype: 'numeric', answer });
    assert.equal(validated.answer, Number(answer));
  }
});

test('choice validation never removes an option and changes the meaning of an answer index', () => {
  for (const qtype of ['single', 'multiple']) {
    assert.throws(() => validateQuestionData({ ...question, qtype, options: ['A', ' ', 'B'], answer: qtype === 'single' ? 1 : [1] }), /Option cannot be empty/);
  }
  const validated = validateQuestionData({ ...question, qtype: 'single', options: [' A ', ' B '], answer: 1 });
  assert.deepEqual(validated.options, ['A', 'B']);
  assert.equal(validated.answer, 1);
});

test('choice keys reject coercible non-index shapes', () => {
  for (const answer of [null, false, true, '', ' ', [], [0], {}]) {
    assert.throws(() => validateQuestionData({ ...question, qtype: 'single', options: ['A', 'B'], answer }), /valid option index/);
  }
  for (const answer of [0, '0', null, false, [null], [false], [''], [[]]]) {
    assert.throws(() => validateQuestionData({ ...question, qtype: 'multiple', options: ['A', 'B'], answer }), /list of valid option indices/);
  }
});

test('choice keys become canonical numeric indices usable by grading', () => {
  const single = validateQuestionData({ ...question, qtype: 'single', options: ['A', 'B'], answer: '1' });
  assert.equal(single.answer, 1);
  const multiple = validateQuestionData({ ...question, qtype: 'multiple', options: ['A', 'B'], answer: ['1', '0', '1'] });
  assert.deepEqual(multiple.answer, [0, 1]);
  const q: Question = {
    ...question,
    ...multiple,
    id: 1,
    quiz_version_id: 1,
    version: 1,
    options: multiple.options ?? [],
    order_index: 0,
    is_latest: 1,
    time_limit_seconds: null,
    allow_assumptions: 0,
    grading_mode: 'normal',
    accept_also: [],
    tolerance: null,
    bonus: 0,
    created_at: '2026-10-30T00:00:00.000Z',
  };
  assert.equal(isAnswerCorrect(q, [0, 1]), true);
  assert.equal(isAnswerCorrect(q, [0]), false);
});

test('HTTP authoring stores multiple numeric-string keys in grading-compatible shape', async () => {
  const harness = new TestHarness();
  await harness.start();
  try {
    const owner = harness.seedUser('instructor', 'choice-key-owner');
    const course = courseRepo.create(`KEY-${owner.id}`, 'Key validation', owner.id).course;
    const headers = { authorization: `Bearer ${harness.mint(owner)}` };
    const created = await harness.api(`/api/quizzes/course/${course.id}`, { method: 'POST', headers, body: {} });
    assert.equal(created.status, 201);
    const saved = await harness.api(`/api/quizzes/${created.body.quiz_id}/questions`, {
      method: 'POST', headers, body: { ...question, qtype: 'multiple', options: ['A', 'B'], answer: ['0', '1'] },
    });
    assert.equal(saved.status, 201);
    assert.equal(isAnswerCorrect(saved.body.question, [0, 1]), true, 'Accepted key must award correct selections');
    assert.deepEqual(saved.body.question.answer, [0, 1]);
    const invalid = await harness.api(`/api/quizzes/${created.body.quiz_id}/questions`, {
      method: 'POST', headers, body: { ...question, qtype: 'single', options: ['A', 'B'], answer: null },
    });
    assert.equal(invalid.status, 400);
    const second = await harness.api(`/api/quizzes/${created.body.quiz_id}/questions`, {
      method: 'POST', headers, body: { ...question, qtype: 'single', options: ['A', 'B'], answer: 1 },
    });
    assert.equal(second.status, 201);
    const before = await harness.api(`/api/quizzes/${created.body.quiz_id}`, { headers });
    const reordered = await harness.api(`/api/quizzes/${created.body.quiz_id}/questions/reorder`, {
      method: 'POST', headers, body: { question_ids: [second.body.question.id, second.body.question.id] },
    });
    assert.equal(reordered.status, 400, 'Duplicate IDs must not omit or corrupt another question position');
    const after = await harness.api(`/api/quizzes/${created.body.quiz_id}`, { headers });
    assert.deepEqual(after.body.versions[0].questions, before.body.versions[0].questions);
    const validOrder = [second.body.question.id, saved.body.question.id];
    const valid = await harness.api(`/api/quizzes/${created.body.quiz_id}/questions/reorder`, {
      method: 'POST', headers, body: { question_ids: validOrder },
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body.questions.map((q: Question) => q.id), validOrder);
  } finally {
    await harness.stop();
  }
});
