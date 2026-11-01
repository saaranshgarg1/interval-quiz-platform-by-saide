import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.js';
import {
  answerRepo,
  attemptRepo,
  courseRepo,
  questionRepo,
  quizRepo,
  quizVersionRepo,
  resultRepo,
} from '../repo.js';
import type { ShowScores, User } from '../types.js';

/**
 * Privacy of the student-facing result surfaces.
 *
 * Intended contract (derived from the explicit guard on a single release and
 * from services/finalize.ts scoreVisible):
 *   never     - the student never sees a score or answer key;
 *   release   - the student sees the score only after an instructor releases it,
 *               and the answer key only after the key itself is released;
 *   immediate - the student sees the score as soon as the attempt is graded,
 *               but still not the answer key.
 * Staff may inspect unreleased work through the staff-only review route.
 */

const h = new TestHarness();
before(async () => { await h.start(); });
after(async () => { await h.stop(); });

const auth = (user: User) => ({ authorization: `Bearer ${h.mint(user)}` });

let seq = 0;
interface FixtureOptions {
  released?: boolean;
  keyReleased?: boolean;
}
interface Fixture {
  instructor: User;
  owner: User;
  stranger: User;
  courseId: number;
  versionId: number;
  questionId: number;
  attemptId: number;
}

function fixture(showScores: ShowScores, opts: FixtureOptions = {}): Fixture {
  const tag = ++seq;
  const instructor = h.seedUser('instructor', `privacy-inst-${tag}`);
  const owner = h.seedUser('student', `privacy-owner-${tag}`);
  const stranger = h.seedUser('student', `privacy-stranger-${tag}`);
  const { course } = courseRepo.create(`PRV${tag}`, `Privacy course ${tag}`, instructor.id);
  courseRepo.addMember(course.id, owner.id, 'student');
  courseRepo.addMember(course.id, stranger.id, 'student');

  const quizId = quizRepo.create(course.id, instructor.id);
  const versionId = quizVersionRepo.createDraft(quizId, course.id, instructor.id, 1);
  quizVersionRepo.updateMeta(versionId, {
    title: `Privacy quiz ${tag}`,
    show_scores: showScores,
  });
  const question = questionRepo.create(versionId, {
    qtype: 'single',
    text: '2+2?',
    options: ['3', '4'],
    answer: 1,
    points: 1,
  });
  const attemptId = attemptRepo.create(versionId, owner.id, JSON.stringify([question.id]), 1, null);
  answerRepo.save(attemptId, question.id, 0, '1', 1);
  resultRepo.upsert(attemptId, versionId, owner.id, 1, 1);
  attemptRepo.updateStatus(attemptId, 'submitted', { score: 1, max_score: 1 });
  if (opts.released) resultRepo.releaseByAttempt(attemptId);
  if (opts.keyReleased) resultRepo.setKeyReleased(attemptId, 1);
  return {
    instructor,
    owner,
    stranger,
    courseId: course.id,
    versionId,
    questionId: question.id,
    attemptId,
  };
}

test('never policy: individual release is refused and the owner sees no result', async () => {
  const f = fixture('never');

  const refused = await h.api(`/api/results/attempt/${f.attemptId}`, {
    method: 'PUT',
    body: { release: true },
    headers: auth(f.instructor),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /never shows scores/i);

  const own = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.owner) });
  assert.equal(own.status, 404);

  const mine = await h.api('/api/results/mine', { headers: auth(f.owner) });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.results, []);

  const attempts = await h.api(`/api/attempts/quiz/${f.versionId}/mine`, { headers: auth(f.owner) });
  assert.equal(attempts.status, 200);
  assert.equal(attempts.body.attempts[0].score, null);
  assert.equal(attempts.body.attempts[0].can_view_result, false);

  // Toggling the key does not unlock anything while the score itself is hidden.
  const key = await h.api(`/api/results/attempt/${f.attemptId}`, {
    method: 'PUT',
    body: { answer_key: true },
    headers: auth(f.instructor),
  });
  assert.equal(key.status, 200);
  const stillHidden = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.owner) });
  assert.equal(stillHidden.status, 404);

  // Staff inspect the attempt through the staff-only review route instead.
  const review = await h.api(`/api/review/attempt/${f.attemptId}`, { headers: auth(f.instructor) });
  assert.equal(review.status, 200);
});

test('release policy: score and answer key appear only after an instructor releases them', async () => {
  const f = fixture('release');

  const beforeOwner = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.owner) });
  assert.equal(beforeOwner.status, 404);
  const beforeInstructor = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.instructor) });
  assert.equal(beforeInstructor.status, 404);
  const beforeStranger = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.stranger) });
  assert.equal(beforeStranger.status, 403);

  const release = await h.api(`/api/results/attempt/${f.attemptId}`, {
    method: 'PUT',
    body: { release: true },
    headers: auth(f.instructor),
  });
  assert.equal(release.status, 200);

  const owner = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.owner) });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.result.score, 1);
  assert.equal(owner.body.result.max_score, 1);
  assert.equal(owner.body.result.released, 1);
  const item = owner.body.result.per_question[0];
  assert.equal(item.correct_answer, null, 'answer key must stay redacted until released');
  assert.deepEqual(item.accept_also, []);

  const mine = await h.api('/api/results/mine', { headers: auth(f.owner) });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.results.map((r: { attempt_id: number }) => r.attempt_id), [f.attemptId]);

  const instructor = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.instructor) });
  assert.equal(instructor.status, 200);
  assert.equal(instructor.body.result.per_question[0].correct_answer, null);
  const stranger = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.stranger) });
  assert.equal(stranger.status, 403);

  const key = await h.api(`/api/results/attempt/${f.attemptId}`, {
    method: 'PUT',
    body: { answer_key: true },
    headers: auth(f.instructor),
  });
  assert.equal(key.status, 200);

  const keyed = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.owner) });
  assert.equal(keyed.status, 200);
  assert.equal(keyed.body.result.per_question[0].correct_answer, 1);
  assert.deepEqual(keyed.body.result.per_question[0].accept_also, []);
  const keyedStranger = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.stranger) });
  assert.equal(keyedStranger.status, 403);
});

test('immediate policy: owner sees the score without a release; non-owner does not', async () => {
  const f = fixture('immediate', { released: true });

  const owner = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.owner) });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.result.score, 1);
  assert.equal(owner.body.result.released, 1);
  assert.equal(owner.body.result.per_question[0].correct_answer, null, 'key is still instructor-only');

  const mine = await h.api('/api/results/mine', { headers: auth(f.owner) });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.results.map((r: { attempt_id: number }) => r.attempt_id), [f.attemptId]);

  const attempts = await h.api(`/api/attempts/quiz/${f.versionId}/mine`, { headers: auth(f.owner) });
  assert.equal(attempts.status, 200);
  assert.equal(attempts.body.attempts[0].score, 1);
  assert.equal(attempts.body.attempts[0].can_view_result, true);

  const stranger = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.stranger) });
  assert.equal(stranger.status, 403);
});

test('never policy: a staff-side released flag must not expose scores on any student surface', async () => {
  const f = fixture('never');

  const bulk = await h.api(`/api/results/quiz/${f.versionId}/release`, {
    method: 'POST',
    body: { answer_key: false },
    headers: auth(f.instructor),
  });

  // The invariant must hold even if a released flag exists on the row (legacy
  // data, another release path, or a future bulk handler). Model that state
  // directly instead of assuming how the bulk route chooses to behave.
  resultRepo.releaseByAttempt(f.attemptId);
  assert.equal(resultRepo.getByAttempt(f.attemptId)?.released, 1, 'sanity: released flag is set');

  // A never-policy quiz must not become visible to the student in any form,
  // regardless of what a staff-side release writes to the results row.
  const own = await h.api(`/api/results/attempt/${f.attemptId}`, { headers: auth(f.owner) });
  const mine = await h.api('/api/results/mine', { headers: auth(f.owner) });
  const attempts = await h.api(`/api/attempts/quiz/${f.versionId}/mine`, { headers: auth(f.owner) });

  const leaks: string[] = [];
  if (own.status !== 404) {
    leaks.push(
      `GET /api/results/attempt/:id -> ${own.status} (score ${own.body?.result?.score ?? 'n/a'})`,
    );
  }
  if (mine.body?.results?.length) {
    leaks.push(`GET /api/results/mine -> ${mine.body.results.length} released result row(s)`);
  }
  assert.deepEqual(
    leaks,
    [],
    `bulk release returned ${bulk.status}; show_scores=never leaked to the student via: ${leaks.join('; ')}`,
  );

  // The attempts list already honours the policy; keep it as a regression guard.
  assert.equal(attempts.status, 200);
  assert.equal(attempts.body.attempts[0].score, null);
  assert.equal(attempts.body.attempts[0].can_view_result, false);
});
