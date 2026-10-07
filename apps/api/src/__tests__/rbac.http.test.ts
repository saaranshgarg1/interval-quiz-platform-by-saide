import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { app } from '../server.js';
import { userRepo, courseRepo } from '../repo.js';
import { signToken, hashPassword } from '../auth.js';
import type { User } from '../types.js';

// HTTP-level proof of the RBAC gates. Unlike the service tests, these drive the
// real Express stack (requireAuth → assert* guards) so the instructor-vs-TA
// split and the register-escalation fix are exercised end to end.

let server: Server;
let base: string;

function mint(user: User): string {
  return signToken(user);
}

/** Seed a user with a chosen global role and a random email. */
function seedUser(role: User['role'], label: string): User {
  const rnd = Math.random().toString(36).slice(2, 10);
  return userRepo.create(`${label} ${rnd}`, `${label}.${rnd}@example.com`, hashPassword('pw-secret-123'), role);
}

interface ApiResult {
  status: number;
  body: any;
}

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('register ignores client-supplied role and always mints a student', async () => {
  const rnd = Math.random().toString(36).slice(2, 10);
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Mallory', email: `mallory.${rnd}@example.com`, password: 'pw-secret-123', role: 'admin' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'student');
});

test('course creation is gated to global instructor/admin', async () => {
  const student = seedUser('student', 'gstudent');
  const instructor = seedUser('instructor', 'ginstructor');

  const denied = await api('/api/courses', {
    method: 'POST',
    token: mint(student),
    body: { code: 'CS-DENY', name: 'Nope' },
  });
  assert.equal(denied.status, 403);

  const ok = await api('/api/courses', {
    method: 'POST',
    token: mint(instructor),
    body: { code: 'CS-OK', name: 'Yes' },
  });
  assert.equal(ok.status, 201);
});

interface Scope {
  courseId: number;
  instructor: User;
  ta: User;
  student: User;
  outsider: User;
  admin: User;
}

/** Course with one instructor (creator), one TA, one enrolled student, plus an outsider and an admin. */
function seedCourse(): Scope {
  const instructor = seedUser('instructor', 'instr');
  const ta = seedUser('student', 'ta');
  const student = seedUser('student', 'stud');
  const outsider = seedUser('student', 'out');
  const admin = seedUser('admin', 'admin');
  const rnd = Math.random().toString(36).slice(2, 8);
  const { course } = courseRepo.create(`C-${rnd}`, 'Scoped course', instructor.id);
  courseRepo.addMember(course.id, ta.id, 'ta');
  courseRepo.addMember(course.id, student.id, 'student');
  return { courseId: course.id, instructor, ta, student, outsider, admin };
}

test('roster is staff-only: student denied, TA allowed', async () => {
  const s = seedCourse();
  const denied = await api(`/api/courses/${s.courseId}/roster`, { token: mint(s.student) });
  assert.equal(denied.status, 403);
  const ok = await api(`/api/courses/${s.courseId}/roster`, { token: mint(s.ta) });
  assert.equal(ok.status, 200);
});

test('member management is instructor-only: TA denied, instructor allowed', async () => {
  const s = seedCourse();
  const denied = await api(`/api/courses/${s.courseId}/members`, {
    method: 'PUT',
    token: mint(s.ta),
    body: { email: s.outsider.email, memberRole: 'ta' },
  });
  assert.equal(denied.status, 403);

  const ok = await api(`/api/courses/${s.courseId}/members`, {
    method: 'PUT',
    token: mint(s.instructor),
    body: { email: s.outsider.email, memberRole: 'ta' },
  });
  assert.equal(ok.status, 200);
});

test('last instructor cannot be removed, even by admin', async () => {
  const s = seedCourse();
  const r = await api(`/api/courses/${s.courseId}/members/${s.instructor.id}`, {
    method: 'DELETE',
    token: mint(s.admin),
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /last instructor/i);
});

test('bank delete is instructor-only; create is staff', async () => {
  const s = seedCourse();
  const created = await api(`/api/banks/course/${s.courseId}`, {
    method: 'POST',
    token: mint(s.ta),
    body: { name: 'Bank A' },
  });
  assert.equal(created.status, 201);
  const bankId = created.body.bank.id;

  const denied = await api(`/api/banks/${bankId}`, { method: 'DELETE', token: mint(s.ta) });
  assert.equal(denied.status, 403);

  const ok = await api(`/api/banks/${bankId}`, { method: 'DELETE', token: mint(s.instructor) });
  assert.equal(ok.status, 200);
});

test('quiz publish is instructor-only; drafting is staff', async () => {
  const s = seedCourse();
  const created = await api(`/api/quizzes/course/${s.courseId}`, { method: 'POST', token: mint(s.ta) });
  assert.equal(created.status, 201);
  const quizId = created.body.quiz_id;

  const q = await api(`/api/quizzes/${quizId}/questions`, {
    method: 'POST',
    token: mint(s.ta),
    body: { qtype: 'single', text: '2+2?', options: ['3', '4'], answer: 1, points: 1 },
  });
  assert.equal(q.status, 201);

  const denied = await api(`/api/quizzes/${quizId}/publish`, { method: 'PATCH', token: mint(s.ta) });
  assert.equal(denied.status, 403);

  const ok = await api(`/api/quizzes/${quizId}/publish`, { method: 'PATCH', token: mint(s.instructor) });
  assert.equal(ok.status, 200);
});

test('accommodations are instructor-only: TA denied, instructor allowed', async () => {
  const s = seedCourse();
  const denied = await api(`/api/accommodations/course/${s.courseId}`, {
    method: 'POST',
    token: mint(s.ta),
    body: { user_id: s.student.id, time_multiplier: 1.5 },
  });
  assert.equal(denied.status, 403);

  const ok = await api(`/api/accommodations/course/${s.courseId}`, {
    method: 'POST',
    token: mint(s.instructor),
    body: { user_id: s.student.id, time_multiplier: 1.5 },
  });
  assert.equal(ok.status, 200);
});

test('admin surface rejects non-admins, admits admin', async () => {
  const s = seedCourse();
  const denied = await api('/api/admin/users', { token: mint(s.instructor) });
  assert.equal(denied.status, 403);
  const ok = await api('/api/admin/users', { token: mint(s.admin) });
  assert.equal(ok.status, 200);
});

test('unauthenticated requests are rejected', async () => {
  const r = await api('/api/courses');
  assert.equal(r.status, 401);
});

// --------------------------------------------------- new instructor features

/** Create a published single-question quiz, returning its ids. */
async function seedPublishedQuiz(s: Scope): Promise<{ quizId: number; questionId: number }> {
  const created = await api(`/api/quizzes/course/${s.courseId}`, { method: 'POST', token: mint(s.instructor) });
  const quizId = created.body.quiz_id;
  const q = await api(`/api/quizzes/${quizId}/questions`, {
    method: 'POST',
    token: mint(s.instructor),
    body: { qtype: 'single', text: 'cap?', options: ['a', 'b'], answer: 1, points: 1 },
  });
  await api(`/api/quizzes/${quizId}/publish`, { method: 'PATCH', token: mint(s.instructor) });
  return { quizId, questionId: q.body.question.id };
}

test('copy quiz clones content into a fresh draft quiz (item 9)', async () => {
  const s = seedCourse();
  const { quizId } = await seedPublishedQuiz(s);
  const copy = await api(`/api/quizzes/${quizId}/copy`, { method: 'POST', token: mint(s.instructor) });
  assert.equal(copy.status, 201);
  assert.notEqual(copy.body.quiz_id, quizId);
  assert.equal(copy.body.status, 'draft');
  assert.equal(copy.body.questions.length, 1);
  assert.match(copy.body.title, /\(copy\)/);
});

test('delete quiz is instructor-only and removes it (item 10)', async () => {
  const s = seedCourse();
  const { quizId } = await seedPublishedQuiz(s);
  const denied = await api(`/api/quizzes/${quizId}`, { method: 'DELETE', token: mint(s.ta) });
  assert.equal(denied.status, 403);
  const ok = await api(`/api/quizzes/${quizId}`, { method: 'DELETE', token: mint(s.instructor) });
  assert.equal(ok.status, 200);
  const gone = await api(`/api/quizzes/${quizId}`, { token: mint(s.instructor) });
  assert.equal(gone.status, 404);
});

test('restore version clones a prior version into a new draft (item 6)', async () => {
  const s = seedCourse();
  const { quizId } = await seedPublishedQuiz(s);
  const restored = await api(`/api/quizzes/${quizId}/versions/1/restore`, { method: 'POST', token: mint(s.instructor) });
  assert.equal(restored.status, 201);
  assert.equal(restored.body.version, 2);
  assert.equal(restored.body.status, 'draft');
  assert.equal(restored.body.questions.length, 1);
});

test('published question answer key is editable in place; structure is not (item 7)', async () => {
  const s = seedCourse();
  const { questionId } = await seedPublishedQuiz(s);
  // Structural edit via the draft route is frozen.
  const frozen = await api(`/api/quizzes/questions/${questionId}`, {
    method: 'PUT',
    token: mint(s.instructor),
    body: { text: 'changed' },
  });
  assert.equal(frozen.status, 409);
  // Answer-only rekey is allowed.
  const rekey = await api(`/api/quizzes/questions/${questionId}/answer`, {
    method: 'PATCH',
    token: mint(s.instructor),
    body: { answer: 0 },
  });
  assert.equal(rekey.status, 200);
  assert.equal(rekey.body.question.answer, 0);
});

test('scheduled quiz rejects attempts outside its window (item 8)', async () => {
  const s = seedCourse();
  const created = await api(`/api/quizzes/course/${s.courseId}`, { method: 'POST', token: mint(s.instructor) });
  const quizId = created.body.quiz_id;
  await api(`/api/quizzes/${quizId}/questions`, {
    method: 'POST',
    token: mint(s.instructor),
    body: { qtype: 'single', text: 'q', options: ['a', 'b'], answer: 0, points: 1 },
  });
  // Open a window in the future.
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const put = await api(`/api/quizzes/${quizId}`, {
    method: 'PUT',
    token: mint(s.instructor),
    body: { quiz_type: 'scheduled', window_opens_at: future, window_duration_minutes: 30 },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.quiz_type, 'scheduled');
  const draftVersionId = put.body.id;
  await api(`/api/quizzes/${quizId}/publish`, { method: 'PATCH', token: mint(s.instructor) });
  // Student tries to start before the window opens.
  const start = await api(`/api/attempts/quiz/${draftVersionId}`, {
    method: 'POST',
    token: mint(s.student),
  });
  assert.equal(start.status, 403);
  assert.match(start.body.error, /opens at/i);
});

test('scheduled quiz PUT requires a window start and duration (item 8)', async () => {
  const s = seedCourse();
  const created = await api(`/api/quizzes/course/${s.courseId}`, { method: 'POST', token: mint(s.instructor) });
  const quizId = created.body.quiz_id;
  const bad = await api(`/api/quizzes/${quizId}`, {
    method: 'PUT',
    token: mint(s.instructor),
    body: { quiz_type: 'scheduled' },
  });
  assert.equal(bad.status, 400);
});

test('bulk enroll adds known emails and reports unknown ones (item 12)', async () => {
  const s = seedCourse();
  const known = seedUser('student', 'bulk');
  const denied = await api(`/api/courses/${s.courseId}/members/bulk`, {
    method: 'POST',
    token: mint(s.ta),
    body: { emails: [known.email] },
  });
  assert.equal(denied.status, 403);

  const ok = await api(`/api/courses/${s.courseId}/members/bulk`, {
    method: 'POST',
    token: mint(s.instructor),
    body: { emails: [known.email, 'ghost-nobody@example.com'] },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.enrolled.length, 1);
  assert.deepEqual(ok.body.not_found, ['ghost-nobody@example.com']);
});
