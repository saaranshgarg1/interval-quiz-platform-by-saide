import './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestionData } from '../services/question-validation.js';
import { TestHarness } from './harness.js';
import { courseRepo } from '../repo.js';

const POINTS_ERROR = 'Points must be greater than 0 and at most 1000.';
const base = { qtype: 'short', text: 'Points validation', answer: 'expected' };

test('points accept positive finite numbers, numeric strings and fractions', () => {
  for (const [raw, expected] of [
    [1, 1],
    [2.5, 2.5],
    ['2.5', 2.5],
    [' 4 ', 4],
    [0.25, 0.25],
    [1000, 1000],
  ] as const) {
    assert.equal(validateQuestionData({ ...base, points: raw }).points, expected);
  }
});

test('explicit invalid points reject instead of coercing', () => {
  const invalid = [
    '', '   ', null, false, true, [], [2], {}, 'abc', '0', '-2',
    0, -1, 1000.01, 1001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  ];
  for (const points of invalid) {
    assert.throws(
      () => validateQuestionData({ ...base, points }),
      (err: unknown) => err instanceof Error && err.message === POINTS_ERROR,
      `points=${String(points)} must be rejected`,
    );
  }
});

test('omitted points stay undefined so the route can apply create/update defaults', () => {
  assert.equal(validateQuestionData({ ...base }).points, undefined);
});

const harness = new TestHarness();
before(async () => { await harness.start(); });
after(async () => { await harness.stop(); });

test('HTTP create defaults omitted points to 1, keeps 2.5, and rejects explicit bad values', async () => {
  const owner = harness.seedUser('instructor', 'points-create-owner');
  const course = courseRepo.create(`PTS-${owner.id}`, 'Points validation', owner.id).course;
  const headers = { authorization: `Bearer ${harness.mint(owner)}` };
  const created = await harness.api(`/api/quizzes/course/${course.id}`, { method: 'POST', headers, body: {} });
  assert.equal(created.status, 201);
  const quizId = created.body.quiz_id as number;

  const omitted = await harness.api(`/api/quizzes/${quizId}/questions`, {
    method: 'POST', headers, body: { ...base, text: 'Omitted points' },
  });
  assert.equal(omitted.status, 201);
  assert.equal(omitted.body.question.points, 1);

  const fractional = await harness.api(`/api/quizzes/${quizId}/questions`, {
    method: 'POST', headers, body: { ...base, text: 'Fractional points', points: 2.5 },
  });
  assert.equal(fractional.status, 201);
  assert.equal(fractional.body.question.points, 2.5);

  for (const points of ['', null, 0, false, true, [2], {}, 1001, 'abc']) {
    const res = await harness.api(`/api/quizzes/${quizId}/questions`, {
      method: 'POST', headers, body: { ...base, text: `Bad points ${String(points)}`, points },
    });
    assert.equal(res.status, 400, `create points=${String(points)} must be rejected`);
    assert.equal(res.body.error, POINTS_ERROR);
  }
});

test('HTTP update preserves points when omitted and rejects explicit bad values', async () => {
  const owner = harness.seedUser('instructor', 'points-update-owner');
  const course = courseRepo.create(`PTU-${owner.id}`, 'Points update', owner.id).course;
  const headers = { authorization: `Bearer ${harness.mint(owner)}` };
  const createdQuiz = await harness.api(`/api/quizzes/course/${course.id}`, { method: 'POST', headers, body: {} });
  assert.equal(createdQuiz.status, 201);
  const quizId = createdQuiz.body.quiz_id as number;
  const created = await harness.api(`/api/quizzes/${quizId}/questions`, {
    method: 'POST', headers, body: { ...base, text: 'Preserve points', points: 2.5 },
  });
  assert.equal(created.status, 201);
  const questionId = created.body.question.id as number;

  const renamed = await harness.api(`/api/quizzes/questions/${questionId}`, {
    method: 'PUT', headers, body: { text: 'Renamed without points' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.question.points, 2.5);

  for (const points of ['', null, 0, false, true, [2], {}, 1001, 'abc']) {
    const res = await harness.api(`/api/quizzes/questions/${questionId}`, {
      method: 'PUT', headers, body: { points },
    });
    assert.equal(res.status, 400, `update points=${String(points)} must be rejected`);
    assert.equal(res.body.error, POINTS_ERROR);
    const current = await harness.api(`/api/quizzes/${quizId}`, { headers });
    const saved = current.body.versions[0].questions.find((q: { id: number }) => q.id === questionId);
    assert.equal(saved.points, 2.5, 'rejected update must not change saved points');
  }

  const updated = await harness.api(`/api/quizzes/questions/${questionId}`, {
    method: 'PUT', headers, body: { points: 4 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.question.points, 4);
});
