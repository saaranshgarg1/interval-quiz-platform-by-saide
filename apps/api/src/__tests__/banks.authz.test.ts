import './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.js';
import { bankRepo, courseRepo } from '../repo.js';

const harness = new TestHarness();
before(async () => { await harness.start(); });
after(async () => { await harness.stop(); });

test('question deletion must belong to the authorized bank, not another course', async () => {
  const owner = harness.seedUser('instructor', 'bank-owner');
  const other = harness.seedUser('instructor', 'other-owner');
  const ownCourse = courseRepo.create(`OWN-${owner.id}`, 'Owned course', owner.id).course;
  const otherCourse = courseRepo.create(`OTHER-${other.id}`, 'Other course', other.id).course;
  const ownBank = bankRepo.create(ownCourse.id, owner.id, 'Own bank', '');
  const foreignBank = bankRepo.create(otherCourse.id, other.id, 'Other bank', '');
  const data = { qtype: 'single' as const, text: 'Choose one', options: ['Yes', 'No'], answer: 0,
    tolerance: null, points: 1, tags: [], difficulty: 'medium' as const, allow_assumptions: false };
  const ownQuestion = bankRepo.addQuestion(ownBank.id, data);
  const foreignQuestion = bankRepo.addQuestion(foreignBank.id, data);
  const headers = { authorization: `Bearer ${harness.mint(owner)}` };

  const denied = await harness.api(`/api/banks/${ownBank.id}/questions/${foreignQuestion.id}`, {
    method: 'DELETE', headers,
  });
  assert.equal(denied.status, 404);
  assert.match(denied.body.error, /not found in this bank/i);
  assert.ok(bankRepo.getQuestion(foreignQuestion.id), 'Foreign question must remain unchanged');
  assert.ok(bankRepo.getQuestion(ownQuestion.id));

  const allowed = await harness.api(`/api/banks/${ownBank.id}/questions/${ownQuestion.id}`, {
    method: 'DELETE', headers,
  });
  assert.equal(allowed.status, 200);
  assert.equal(bankRepo.getQuestion(ownQuestion.id), undefined);
  assert.ok(bankRepo.getQuestion(foreignQuestion.id));
});
