import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.js';
import { attemptRepo, courseRepo, questionRepo, quizRepo, quizVersionRepo, resultRepo } from '../repo.js';

const h = new TestHarness();
before(async () => { await h.start(); });
after(async () => { await h.stop(); });

function fixture() {
  const instructor = h.seedUser('instructor', 'never-instructor');
  const student = h.seedUser('student', 'never-student');
  const { course } = courseRepo.create(`NEVER-${student.id}`, 'Never-score policy regression', instructor.id);
  courseRepo.addMember(course.id, student.id, 'student');
  const quizId = quizRepo.create(course.id, instructor.id);
  const versionId = quizVersionRepo.createDraft(quizId, course.id, instructor.id, 1);
  quizVersionRepo.updateMeta(versionId, { show_scores: 'never' });
  const question = questionRepo.create(versionId, {
    qtype: 'single', text: 'Private answer key', options: ['A', 'B'], answer: 1, points: 1,
  });
  quizVersionRepo.publish(versionId);
  const attemptId = attemptRepo.create(versionId, student.id, JSON.stringify([question.id]), 42, null);
  attemptRepo.updateStatus(attemptId, 'submitted', { score: 0, max_score: 1 });
  resultRepo.upsert(attemptId, versionId, student.id, 0, 1);
  return {
    versionId, attemptId,
    instructorHeaders: { authorization: `Bearer ${h.mint(instructor)}` },
    studentHeaders: { authorization: `Bearer ${h.mint(student)}` },
  };
}

for (const answerKey of [false, true]) {
  test(`never policy refuses bulk release with answer_key=${answerKey} without changing flags`, async () => {
    const f = fixture();
    const before = resultRepo.getByAttempt(f.attemptId);
    const response = await h.api(`/api/results/quiz/${f.versionId}/release`, {
      method: 'POST', headers: f.instructorHeaders, body: { answer_key: answerKey },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'This quiz never shows scores.');
    assert.deepEqual(resultRepo.getByAttempt(f.attemptId), before);
    const own = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: f.studentHeaders });
    assert.equal(own.status, 404);
    const mine = await h.api('/api/results/mine', { headers: f.studentHeaders });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.results, []);
  });
}

test('never policy hides legacy released scores and keys without mutating stored grades', async () => {
  const f = fixture();
  // Simulate a row released before the policy guard existed.
  resultRepo.releaseByAttempt(f.attemptId);
  resultRepo.setKeyReleased(f.attemptId, 1);
  const before = resultRepo.getByAttempt(f.attemptId);
  const own = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: f.studentHeaders });
  assert.equal(own.status, 404);
  assert.equal(own.body.result, undefined);
  const mine = await h.api('/api/results/mine', { headers: f.studentHeaders });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.results, []);
  const attempts = await h.api(`/api/attempts/quiz/${f.versionId}/mine`, { headers: f.studentHeaders });
  assert.equal(attempts.status, 200);
  assert.equal(attempts.body.attempts[0].score, null);
  assert.equal(attempts.body.attempts[0].can_view_result, false);
  const staff = await h.api(`/api/review/attempt/${f.attemptId}`, { headers: f.instructorHeaders });
  assert.equal(staff.status, 200);
  assert.deepEqual(resultRepo.getByAttempt(f.attemptId), before);
});
