import './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.js';
import { courseRepo, quizRepo, quizVersionRepo } from '../repo.js';

const harness = new TestHarness();
before(async () => { await harness.start(); });
after(async () => { await harness.stop(); });

test('admin course access remains privileged even with a student membership', async () => {
  const instructor = harness.seedUser('instructor', 'owner');
  const admin = harness.seedUser('admin', 'administrator');
  const student = harness.seedUser('student', 'learner');
  const { course } = courseRepo.create(`ADMIN-${admin.id}`, 'Admin role regression', instructor.id);
  courseRepo.addMember(course.id, admin.id, 'student');
  courseRepo.addMember(course.id, student.id, 'student');

  const adminHeaders = { authorization: `Bearer ${harness.mint(admin)}` };
  const detail = await harness.api(`/api/courses/${course.id}`, { headers: adminHeaders });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.role, 'admin');
  assert.equal(detail.body.roster.length, 3);

  const roster = await harness.api(`/api/courses/${course.id}/roster`, { headers: adminHeaders });
  assert.equal(roster.status, 200);
  const denied = await harness.api(`/api/courses/${course.id}/roster`, {
    headers: { authorization: `Bearer ${harness.mint(student)}` },
  });
  assert.equal(denied.status, 403);
});

test('quiz detail exposes effective course role rather than global role', async () => {
  const owner = harness.seedUser('instructor', 'role-owner');
  const learner = harness.seedUser('instructor', 'role-learner');
  const ta = harness.seedUser('student', 'role-ta');
  const admin = harness.seedUser('admin', 'role-admin');
  const { course } = courseRepo.create(`PREFLIGHT-${owner.id}`, 'Preflight roles', owner.id);
  courseRepo.addMember(course.id, learner.id, 'student');
  courseRepo.addMember(course.id, ta.id, 'ta');
  const quizId = quizRepo.create(course.id, owner.id);
  const versionId = quizVersionRepo.createDraft(quizId, course.id, owner.id, 1);
  quizVersionRepo.publish(versionId);

  for (const [user, role] of [[learner, 'student'], [ta, 'ta'], [admin, 'instructor']] as const) {
    const detail = await harness.api(`/api/quizzes/${quizId}`, {
      headers: { authorization: `Bearer ${harness.mint(user)}` },
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.viewer_role, role);
  }
});
