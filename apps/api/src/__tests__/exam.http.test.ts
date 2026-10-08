import './_env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { app } from '../server.js';
import { userRepo, courseRepo } from '../repo.js';
import { signToken, hashPassword } from '../auth.js';
import type { User } from '../types.js';

// HTTP-level proof of the exam platform: what students can and cannot see, the
// per-attempt session header, and the proctoring endpoints' RBAC.

let server: Server;
let base: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface ApiResult {
  status: number;
  body: any;
  text: string;
}

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; session?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.session) headers['x-attempt-session'] = opts.session;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

const rnd = () => Math.random().toString(36).slice(2, 9);

function seedUser(role: User['role'], label: string, entry: string | null = null): User {
  const r = rnd();
  return userRepo.create(`${label} ${r}`, `${label}.${r}@example.com`, hashPassword('pw-secret-123'), role, entry);
}

interface Scope {
  courseId: number;
  instructor: User;
  ta: User;
  student: User;
  quizId: number;
  versionId: number;
  tokens: { instructor: string; ta: string; student: string };
}

/** Course + published 2-question quiz with the given exam settings. */
async function seedExam(examSettings: Record<string, unknown> = {}): Promise<Scope> {
  const instructor = seedUser('instructor', 'instr');
  const ta = seedUser('student', 'ta');
  const student = seedUser('student', 'stud', `2023CS${rnd().toUpperCase()}`);
  const { course } = courseRepo.create(`X-${rnd()}`, 'Exam course', instructor.id);
  courseRepo.addMember(course.id, ta.id, 'ta');
  courseRepo.addMember(course.id, student.id, 'student');
  const tokens = { instructor: signToken(instructor), ta: signToken(ta), student: signToken(student) };
  const created = await api(`/api/quizzes/course/${course.id}`, { method: 'POST', token: tokens.instructor });
  const quizId = created.body.quiz_id as number;
  for (const body of [
    { qtype: 'single', text: 'SECRET-QUESTION-ONE', options: ['a', 'b'], answer: 1, points: 1 },
    { qtype: 'short', text: 'SECRET-QUESTION-TWO', answer: 'yes', points: 1 },
  ]) {
    const q = await api(`/api/quizzes/${quizId}/questions`, { method: 'POST', token: tokens.instructor, body });
    assert.equal(q.status, 201, q.text);
  }
  const put = await api(`/api/quizzes/${quizId}`, {
    method: 'PUT',
    token: tokens.instructor,
    body: { title: 'Midterm', duration_minutes: 30, exam_settings: examSettings },
  });
  assert.equal(put.status, 200, put.text);
  const pub = await api(`/api/quizzes/${quizId}/publish`, { method: 'PATCH', token: tokens.instructor });
  assert.equal(pub.status, 200, pub.text);
  return { courseId: course.id, instructor, ta, student, quizId, versionId: pub.body.id, tokens };
}

test('students see rules and counts but never question text before the attempt', async () => {
  const s = await seedExam({ allow_tab_switch: false, access_code: 'ROOM-12' });
  const list = await api(`/api/quizzes/course/${s.courseId}`, { token: s.tokens.student });
  assert.equal(list.status, 200);
  assert.doesNotMatch(list.text, /SECRET-QUESTION/);
  assert.doesNotMatch(list.text, /ROOM-12/, 'the access code is never sent to students');
  const preflight = await api(`/api/quizzes/${s.quizId}`, { token: s.tokens.student });
  assert.equal(preflight.status, 200, 'students can load the preflight page');
  const v = preflight.body.versions[0];
  assert.equal(v.question_count, 2);
  assert.deepEqual(v.questions, []);
  assert.equal(v.exam_settings.requires_access_code, true);
  assert.ok(v.rules.some((r: string) => /switch browser tabs/.test(r)));
  assert.doesNotMatch(preflight.text, /SECRET-QUESTION|ROOM-12/);
  // Staff still get everything.
  const staff = await api(`/api/quizzes/${s.quizId}`, { token: s.tokens.ta });
  assert.match(staff.text, /SECRET-QUESTION-ONE/);
});

test('attempt endpoints require the X-Attempt-Session header issued at start', async () => {
  const s = await seedExam({});
  const start = await api(`/api/attempts/quiz/${s.versionId}`, { method: 'POST', token: s.tokens.student });
  assert.equal(start.status, 201, start.text);
  const { session_token: session, attempt, questions } = start.body;
  assert.ok(session);
  const q = questions[0];
  const body = { answers: [{ question_id: q.id, answer: q.qtype === 'short' ? 'yes' : 1, revision: 1 }] };

  const missing = await api(`/api/attempts/${attempt.id}/answers`, { method: 'PUT', token: s.tokens.student, body });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'session_required');
  assert.equal(missing.body.can_resume, true);

  const ok = await api(`/api/attempts/${attempt.id}/answers`, { method: 'PUT', token: s.tokens.student, body, session });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.acks[0].acknowledged, true);

  const hb = await api(`/api/attempts/${attempt.id}/heartbeat`, { method: 'POST', token: s.tokens.student, body: {}, session });
  assert.equal(hb.status, 200);
  assert.equal(hb.body.status, 'in_progress');

  // Another student cannot touch it even with the token.
  const other = seedUser('student', 'other');
  courseRepo.addMember(s.courseId, other.id, 'student');
  const stolen = await api(`/api/attempts/${attempt.id}`, { token: signToken(other), session });
  assert.equal(stolen.status, 403);
});

test('strict lock surfaces as HTTP 423 from the events endpoint', async () => {
  const s = await seedExam({ allow_tab_switch: false, violation_action: 'lock', max_violations: 1 });
  const start = await api(`/api/attempts/quiz/${s.versionId}`, { method: 'POST', token: s.tokens.student });
  const ev = await api(`/api/attempts/${start.body.attempt.id}/events`, {
    method: 'POST',
    token: s.tokens.student,
    session: start.body.session_token,
    body: { kind: 'page_hidden', detail: 'visibilitychange' },
  });
  assert.equal(ev.status, 423);
  assert.equal(ev.body.action, 'locked');
});

test('proctor RBAC: TA monitors and announces; time and rulings are instructor-only', async () => {
  const s = await seedExam({});
  const student = await api(`/api/proctor/quiz/${s.quizId}`, { token: s.tokens.student });
  assert.equal(student.status, 403);
  const monitor = await api(`/api/proctor/quiz/${s.quizId}`, { token: s.tokens.ta });
  assert.equal(monitor.status, 200);
  assert.equal(monitor.body.summary.enrolled, 1);

  const taExtend = await api(`/api/proctor/quiz/${s.quizId}/extend`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { minutes: 5 },
  });
  assert.equal(taExtend.status, 403);
  const taPause = await api(`/api/proctor/quiz/${s.quizId}/pause`, { method: 'POST', token: s.tokens.ta });
  assert.equal(taPause.status, 403);
  const taAnnounce = await api(`/api/proctor/quiz/${s.quizId}/announce`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { message: 'Ten minutes left.' },
  });
  assert.equal(taAnnounce.status, 200);

  const start = await api(`/api/attempts/quiz/${s.versionId}`, { method: 'POST', token: s.tokens.student });
  const taAction = await api(`/api/proctor/attempt/${start.body.attempt.id}/action`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { action: 'lock' },
  });
  assert.equal(taAction.status, 403);
  const hb = await api(`/api/attempts/${start.body.attempt.id}/heartbeat`, {
    method: 'POST',
    token: s.tokens.student,
    session: start.body.session_token,
    body: {},
  });
  assert.equal(hb.body.announcements[0].message, 'Ten minutes left.');
});

test('instructor extends one student by entry number; unknown ids are reported', async () => {
  const s = await seedExam({});
  const start = await api(`/api/attempts/quiz/${s.versionId}`, { method: 'POST', token: s.tokens.student });
  const before = start.body.attempt.expires_at as string;
  const res = await api(`/api/proctor/quiz/${s.quizId}/extend`, {
    method: 'POST',
    token: s.tokens.instructor,
    body: {
      minutes: 7,
      scope: 'students',
      students: `${s.student.entry_number!.toLowerCase()}, NOT-A-STUDENT`,
      reason: 'late bus',
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.extended, 1);
  assert.deepEqual(res.body.not_found, ['NOT-A-STUDENT']);
  const monitor = await api(`/api/proctor/quiz/${s.quizId}`, { token: s.tokens.instructor });
  const row = monitor.body.students.find((r: any) => r.user_id === s.student.id);
  assert.notEqual(row.attempt.expires_at, before);
  assert.equal(row.attempt.extra_seconds, 420);
  const none = await api(`/api/proctor/quiz/${s.quizId}/extend`, {
    method: 'POST',
    token: s.tokens.instructor,
    body: { minutes: 7, scope: 'students', students: 'ghost' },
  });
  assert.equal(none.status, 404);
});

test('gradebook CSV has entry numbers, absent students and neutralised formulas', async () => {
  const s = await seedExam({});
  const absentee = userRepo.create('=HYPERLINK("evil")', `absent.${rnd()}@example.com`, hashPassword('pw-secret-123'), 'student', null);
  courseRepo.addMember(s.courseId, absentee.id, 'student');
  const start = await api(`/api/attempts/quiz/${s.versionId}`, { method: 'POST', token: s.tokens.student });
  await api(`/api/attempts/${start.body.attempt.id}/submit`, {
    method: 'POST',
    token: s.tokens.student,
    session: start.body.session_token,
  });
  const csv = await api(`/api/results/quiz/${s.versionId}/export.csv`, { token: s.tokens.instructor });
  assert.equal(csv.status, 200);
  assert.match(csv.text, new RegExp(s.student.entry_number!));
  assert.match(csv.text, /"absent"/);
  assert.match(csv.text, /"'=HYPERLINK/);
  assert.match(csv.text, /submitted_by_student/);
  const taCsv = await api(`/api/results/quiz/${s.versionId}/export.csv`, { token: s.tokens.ta });
  assert.equal(taCsv.status, 403);
});

test('login is throttled per account, not per network', async () => {
  const user = seedUser('student', 'throttle');
  for (let i = 0; i < 10; i++) {
    const r = await api('/api/auth/login', { method: 'POST', body: { email: user.email, password: 'wrong-password' } });
    assert.equal(r.status, 401);
  }
  const blocked = await api('/api/auth/login', { method: 'POST', body: { email: user.email, password: 'pw-secret-123' } });
  assert.equal(blocked.status, 429);
  // Classmates on the same network are unaffected.
  const other = seedUser('student', 'neighbour');
  const ok = await api('/api/auth/login', { method: 'POST', body: { email: other.email, password: 'pw-secret-123' } });
  assert.equal(ok.status, 200, ok.text);
});

test('sign-out-everywhere and role changes revoke existing tokens', async () => {
  const user = seedUser('student', 'revoke');
  const token = signToken(user);
  assert.equal((await api('/api/auth/me', { token })).status, 200);
  assert.equal((await api('/api/auth/logout-all', { method: 'POST', token })).status, 200);
  assert.equal((await api('/api/auth/me', { token })).status, 401);

  const admin = seedUser('admin', 'admin');
  const target = seedUser('instructor', 'demoted');
  const targetToken = signToken(target);
  const demote = await api(`/api/admin/users/${target.id}/role`, {
    method: 'PATCH',
    token: signToken(admin),
    body: { role: 'student' },
  });
  assert.equal(demote.status, 200);
  assert.equal((await api('/api/courses', { method: 'POST', token: targetToken, body: { code: 'X', name: 'Y' } })).status, 401);
});

test('pending enrollment: invited before registering, enrolled on sign-up with entry number', async () => {
  const s = await seedExam({});
  const email = `newcomer.${rnd()}@example.com`;
  const entry = `2024AI${rnd().toUpperCase()}`;
  const enroll = await api(`/api/courses/${s.courseId}/members/bulk`, {
    method: 'POST',
    token: s.tokens.instructor,
    body: { emails: `${email}, ${entry}, New Comer\nnot-an-email` },
  });
  assert.equal(enroll.status, 200, enroll.text);
  assert.deepEqual(enroll.body.pending, [email]);
  assert.deepEqual(enroll.body.invalid, ['not-an-email']);
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'New Comer', email, password: 'long-enough-1' },
  });
  assert.equal(reg.status, 201, reg.text);
  assert.equal(reg.body.user.entry_number, entry);
  const courses = await api('/api/courses', { token: reg.body.token });
  assert.ok(courses.body.courses.some((c: any) => c.id === s.courseId));
});

test('register validates passwords and refuses duplicate entry numbers', async () => {
  const short = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Shorty', email: `short.${rnd()}@example.com`, password: 'abc' },
  });
  assert.equal(short.status, 400);
  const taken = seedUser('student', 'holder', `2021ME${rnd().toUpperCase()}`);
  const dup = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Copycat', email: `copy.${rnd()}@example.com`, password: 'long-enough-1', entry_number: taken.entry_number },
  });
  assert.equal(dup.status, 409);
});

test('settings validation errors come back as 400 with a message', async () => {
  const instructor = seedUser('instructor', 'v');
  const { course } = courseRepo.create(`V-${rnd()}`, 'Validation', instructor.id);
  const token = signToken(instructor);
  const created = await api(`/api/quizzes/course/${course.id}`, { method: 'POST', token });
  const bad = await api(`/api/quizzes/${created.body.quiz_id}`, {
    method: 'PUT',
    token,
    body: { exam_settings: { allowed_networks: ['not-a-network'] } },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not-a-network/);
  const preset = await api(`/api/quizzes/${created.body.quiz_id}`, { method: 'PUT', token, body: { preset: 'strict' } });
  assert.equal(preset.status, 200);
  assert.equal(preset.body.preset, 'strict');
  assert.equal(preset.body.integrity_policy, 'strict');
});

test('flags: TA raises, only the instructor resolves; report and live overview are staff-only', async () => {
  const s = await seedExam({ allow_tab_switch: false });
  const start = await api(`/api/attempts/quiz/${s.versionId}`, { method: 'POST', token: s.tokens.student });
  const attemptId = start.body.attempt.id;
  await api(`/api/attempts/${attemptId}/events`, {
    method: 'POST',
    token: s.tokens.student,
    session: start.body.session_token,
    body: { kind: 'tab_hidden' },
  });
  const raised = await api(`/api/proctor/attempt/${attemptId}/flags`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { severity: 'medium', reason: 'Talking to neighbour' },
  });
  assert.equal(raised.status, 201, raised.text);
  const studentFlag = await api(`/api/proctor/attempt/${attemptId}/flags`, {
    method: 'POST',
    token: s.tokens.student,
    body: { severity: 'low', reason: 'x' },
  });
  assert.equal(studentFlag.status, 403);

  const report = await api(`/api/proctor/quiz/${s.quizId}/flags`, { token: s.tokens.ta });
  assert.equal(report.status, 200);
  assert.equal(report.body.candidates[0].signals.tab_hidden, 1);
  assert.equal(report.body.candidates[0].manual_flags.length, 1);
  assert.equal((await api(`/api/proctor/quiz/${s.quizId}/flags`, { token: s.tokens.student })).status, 403);

  const flagId = raised.body.flag.id;
  const taResolve = await api(`/api/proctor/flags/${flagId}/resolve`, { method: 'POST', token: s.tokens.ta, body: { resolution: 'ok' } });
  assert.equal(taResolve.status, 403);
  const resolved = await api(`/api/proctor/flags/${flagId}/resolve`, {
    method: 'POST',
    token: s.tokens.instructor,
    body: { resolution: 'Spoke to student; asking for a pen' },
  });
  assert.equal(resolved.status, 200);

  const live = await api('/api/proctor/live', { token: s.tokens.ta });
  assert.equal(live.status, 200);
  assert.ok(live.body.exams.some((e: any) => e.quiz_id === s.quizId && e.state === 'live' && e.in_progress === 1));
  const studentLive = await api('/api/proctor/live', { token: s.tokens.student });
  assert.equal(studentLive.body.exams.length, 0, 'students proctor nothing');

  const csv = await api(`/api/results/quiz/${s.versionId}/export.csv`, { token: s.tokens.instructor });
  assert.match(csv.text, /"flag_level"/);
});

test('CORS: the site served by this API may call it; foreign origins are refused with 403', async () => {
  const user = seedUser('student', 'cors');
  const call = (origin: string) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: user.email, password: 'pw-secret-123' }),
    });
  assert.equal((await call(base)).status, 200, 'same origin (production single-process deploy)');
  assert.equal((await call('http://localhost:5173')).status, 200, 'dev server origin from the allow-list');
  assert.equal((await call('https://evil.example')).status, 403);
});

test('random bank slots: difficulty saved, pool checked, bank in use cannot be deleted', async () => {
  const s = await seedExam({});
  const bank = await api(`/api/banks/course/${s.courseId}`, { method: 'POST', token: s.tokens.instructor, body: { name: 'Unit 2 pool' } });
  const bankId = bank.body.bank.id;
  const add = (difficulty: string, i: number) =>
    api(`/api/banks/${bankId}/questions`, {
      method: 'POST',
      token: s.tokens.ta,
      body: { qtype: 'single', text: `${difficulty} ${i}`, options: ['x', 'y'], answer: 1, difficulty },
    });
  for (let i = 0; i < 2; i++) assert.equal((await add('hard', i)).status, 201);
  const easy = await add('easy', 0);
  assert.equal(easy.body.question.difficulty, 'easy');
  const broken = await api(`/api/banks/${bankId}/questions`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { qtype: 'single', text: 'bad', options: ['x', 'y'], answer: 5 },
  });
  assert.equal(broken.status, 400, 'bank questions are validated like quiz questions');
  const imported = await api(`/api/banks/${bankId}/import`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { questions: [{ qtype: 'short', text: 'ok', answer: 'yes', difficulty: 'med' }, { qtype: 'short', text: '' }] },
  });
  assert.equal(imported.body.count, 1);
  assert.equal(imported.body.skipped.length, 1);

  const created = await api(`/api/quizzes/course/${s.courseId}`, { method: 'POST', token: s.tokens.instructor });
  const quizId = created.body.quiz_id;
  const tooMany = await api(`/api/quizzes/${quizId}/slots`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { bank_id: bankId, difficulty: 'hard', count: 3, points: 2 },
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.code, 'pool_too_small');
  const ok = await api(`/api/quizzes/${quizId}/slots`, {
    method: 'POST',
    token: s.tokens.ta,
    body: { bank_id: bankId, difficulty: 'hard', count: 2, points: 2.5 },
  });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.slots.length, 2);
  assert.equal(ok.body.slots[0].pool_size, 2);
  assert.equal(ok.body.question_count, 2);
  assert.equal(ok.body.total_points, 5);
  const pub = await api(`/api/quizzes/${quizId}/publish`, { method: 'PATCH', token: s.tokens.instructor });
  assert.equal(pub.status, 200, pub.text);

  const del = await api(`/api/banks/${bankId}`, { method: 'DELETE', token: s.tokens.instructor });
  assert.equal(del.status, 409);
  assert.equal(del.body.code, 'bank_in_use');

  const start = await api(`/api/attempts/quiz/${pub.body.id}`, { method: 'POST', token: s.tokens.student });
  assert.equal(start.status, 201, start.text);
  assert.deepEqual(start.body.questions.map((q: any) => q.points), [2.5, 2.5]);
  // Students never see the bank name or its other questions.
  assert.doesNotMatch(JSON.stringify(start.body), /Unit 2 pool|"easy 0"/);
});
