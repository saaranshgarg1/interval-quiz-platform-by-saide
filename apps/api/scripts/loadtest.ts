/**
 * Load test: N students sitting one exam at the same time.
 *
 *   pnpm --filter @interval/api loadtest                 # 500 students, 120 s exam
 *   pnpm --filter @interval/api loadtest -- --students 800 --duration 300
 *   pnpm --filter @interval/api loadtest -- --students 1000 --quizzes 10   # 10 exams live at once
 *
 * What it does
 *   1. Builds the API (tsc) and seeds a throwaway database: one course, N
 *      enrolled students, and a published 25-question exam with proctoring on
 *      (tab/window switches counted, copy-paste blocked, shuffled questions and
 *      options, 60-minute timer).
 *   2. Boots the production build (node dist/server.js) in its own process.
 *   3. Login burst      — all N students sign in at once (real scrypt).
 *   4. Start burst      — all N start the exam in the same instant.
 *   5. Exam phase       — every student autosaves an answer every 2–6 s, sends a
 *                         heartbeat every 15 s and occasionally trips a
 *                         violation; two staff poll the live monitor every 5 s.
 *   6. Submit burst     — all N submit at once.
 *
 * Reports per-endpoint latency percentiles, error counts, throughput and the
 * server's own event-loop delay, and writes the numbers to docs/loadtest/.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i] as string;
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
}
const STUDENTS = Number(args.get('students') ?? 500);
/** Separate courses/exams running at the same time; students are split evenly. */
const QUIZZES = Math.max(1, Number(args.get('quizzes') ?? 1));
const DURATION_S = Number(args.get('duration') ?? 120);
const PORT = Number(args.get('port') ?? 4610);
const BASE = `http://127.0.0.1:${PORT}`;
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(API_DIR, '../../docs/loadtest');

// One throwaway database + secrets shared by this process (seeding) and the server.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-loadtest-'));
process.env.INTERVAL_DATA_DIR = DATA_DIR;
process.env.INTERVAL_PASSWORD_PEPPER = 'loadtest-pepper';
process.env.INTERVAL_JWT_SECRET = 'loadtest-jwt-secret';

const PASSWORD = 'loadtest-password';

// ------------------------------------------------------------------ metrics

const samples = new Map<string, number[]>();
const failures = new Map<string, Map<string, number>>();

function record(name: string, ms: number, failure: string | null) {
  if (!samples.has(name)) samples.set(name, []);
  samples.get(name)!.push(ms);
  if (failure) {
    if (!failures.has(name)) failures.set(name, new Map());
    const f = failures.get(name)!;
    f.set(failure, (f.get(failure) ?? 0) + 1);
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

interface Call {
  ok: boolean;
  status: number;
  body: any;
}

/**
 * Keep-alive like a browser: a student's tab reuses its connection between
 * autosaves (fetch's default pool drops idle sockets after 4 s, which would
 * measure TCP connects instead of the server).
 */
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity, keepAliveMsecs: 30_000 });

const retries = new Map<string, number>();
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

/**
 * Like the real student client: a request that never reached the server
 * (refused/reset connection) is retried with backoff. Every endpoint used here
 * is idempotent server-side, so a retry can never double-apply. Retries are
 * counted and reported separately.
 */
async function call(
  name: string,
  method: string,
  url: string,
  opts: { token?: string; session?: string; body?: unknown } = {},
): Promise<Call> {
  for (let attempt = 0; ; attempt++) {
    const res = await callOnce(name, method, url, opts, attempt < 4);
    if (res !== 'retry') return res;
    retries.set(name, (retries.get(name) ?? 0) + 1);
    await sleep(100 * 2 ** attempt + Math.random() * 100);
  }
}

function callOnce(
  name: string,
  method: string,
  url: string,
  opts: { token?: string; session?: string; body?: unknown },
  mayRetry: boolean,
): Promise<Call | 'retry'> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.session) headers['x-attempt-session'] = opts.session;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers['content-length'] = String(Buffer.byteLength(payload));
  const t0 = performance.now();
  return new Promise((resolve) => {
    const req = http.request(`${BASE}${url}`, { method, headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        record(name, performance.now() - t0, ok ? null : String(status));
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any = text;
        if ((res.headers['content-type'] ?? '').includes('json')) {
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
        }
        resolve({ ok, status, body });
      });
    });
    req.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code ?? e.name ?? 'network';
      if (mayRetry && RETRYABLE.has(code)) {
        resolve('retry');
        return;
      }
      record(name, performance.now() - t0, code);
      resolve({ ok: false, status: 0, body: null });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

// ------------------------------------------------------------------ seed

interface SeededExam {
  versionId: number;
  quizId: number;
}

async function seed(): Promise<{ exams: SeededExam[]; staffEmail: string }> {
  const { transaction } = await import('../src/db.js');
  const { userRepo, courseRepo, quizRepo, quizVersionRepo, questionRepo } = await import('../src/repo.js');
  const { hashPassword } = await import('../src/auth.js');
  const { applyPreset, defaultSettings, normalizeSettings } = await import('../src/services/exam-settings.js');

  const hash = hashPassword(PASSWORD); // one hash reused: seeding speed, login still verifies for real
  const staffEmail = 'loadtest.instructor@iitrpr.ac.in';
  return transaction(() => {
    const instructor = userRepo.create('Load Test Instructor', staffEmail, hash, 'instructor');
    const courses = Array.from({ length: QUIZZES }, (_, q) => courseRepo.create(`LT${101 + q}`, `Load Test ${q + 1}`, instructor.id).course);
    for (let i = 1; i <= STUDENTS; i++) {
      const entry = `2026LT${String(i).padStart(4, '0')}`;
      const s = userRepo.create(`Student ${i}`, `${entry.toLowerCase()}@iitrpr.ac.in`, hash, 'student', entry);
      courseRepo.addMember((courses[(i - 1) % QUIZZES] as (typeof courses)[number]).id, s.id, 'student');
    }
    return { exams: courses.map((course) => createExam(course.id)), staffEmail };

    function createExam(courseId: number): SeededExam {
    const course = { id: courseId };
    const quizId = quizRepo.create(course.id, instructor.id);
    const versionId = quizVersionRepo.createDraft(quizId, course.id, instructor.id, 1);
    const settings = normalizeSettings({ violation_action: 'lock', max_violations: 5 }, applyPreset(defaultSettings(), 'standard'));
    quizVersionRepo.updateMeta(versionId, {
      title: 'Load test midterm',
      duration_minutes: 60,
      shuffle_questions: 1,
      shuffle_options: 1,
      exam_settings: JSON.stringify(settings),
      integrity_policy: 'warn',
    });
    for (let i = 0; i < 25; i++) {
      const kind = i % 5;
      if (kind <= 1) {
        questionRepo.create(versionId, { qtype: 'single', text: `Single ${i}: pick the second option`, options: ['A', 'B', 'C', 'D'], answer: 1, points: 1 });
      } else if (kind === 2) {
        questionRepo.create(versionId, { qtype: 'multiple', text: `Multiple ${i}`, options: ['A', 'B', 'C', 'D', 'E'], answer: [0, 2], points: 2 });
      } else if (kind === 3) {
        questionRepo.create(versionId, { qtype: 'numeric', text: `Numeric ${i}: 6 × 7`, answer: 42, tolerance: 0.01, points: 1 });
      } else {
        questionRepo.create(versionId, { qtype: 'short', text: `Short ${i}: capital of France`, answer: 'paris', points: 1 });
      }
    }
    quizVersionRepo.publish(versionId);
    return { versionId, quizId };
    }
  });
}

// ------------------------------------------------------------------ server

function startServer(): ChildProcess {
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      UV_THREADPOOL_SIZE: String(Math.max(4, Math.min(16, os.cpus().length))),
      INTERVAL_WEB_DIST: path.join(DATA_DIR, 'no-web'), // API only
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('server did not come up');
}

// ------------------------------------------------------------------ students

interface Student {
  exam: SeededExam;
  email: string;
  token?: string;
  attemptId?: number;
  session?: string;
  questions: { id: number; qtype: string; options: string[] }[];
  revisions: Map<number, number>;
  lastAnnouncement: number;
}

function randomAnswer(q: Student['questions'][number]): unknown {
  switch (q.qtype) {
    case 'single':
      return Math.floor(Math.random() * q.options.length);
    case 'multiple':
      return q.options.map((_, i) => i).filter(() => Math.random() < 0.4);
    case 'numeric':
      return Math.round(rand(0, 100));
    default:
      return Math.random() < 0.5 ? 'paris' : 'lyon';
  }
}

async function examLoop(s: Student, endAt: number) {
  if (!s.attemptId || !s.session) return;
  const heartbeats = (async () => {
    await sleep(Math.min(rand(0, 15_000), Math.max(0, endAt - Date.now())));
    while (Date.now() < endAt) {
      const hb = await call('heartbeat', 'POST', `/api/attempts/${s.attemptId}/heartbeat`, {
        token: s.token,
        session: s.session,
        body: { last_announcement_id: s.lastAnnouncement },
      });
      for (const a of hb.body?.announcements ?? []) s.lastAnnouncement = Math.max(s.lastAnnouncement, a.id);
      await sleep(Math.min(15_000, Math.max(0, endAt - Date.now())));
    }
  })();
  while (Date.now() < endAt) {
    await sleep(rand(2_000, 6_000));
    if (Date.now() >= endAt) break;
    const q = s.questions[Math.floor(Math.random() * s.questions.length)];
    if (!q) break;
    const revision = (s.revisions.get(q.id) ?? 0) + 1;
    s.revisions.set(q.id, revision);
    await call('save answer', 'PUT', `/api/attempts/${s.attemptId}/answers`, {
      token: s.token,
      session: s.session,
      body: { answers: [{ question_id: q.id, answer: randomAnswer(q), revision }] },
    });
    if (Math.random() < 0.01) {
      await call('integrity event', 'POST', `/api/attempts/${s.attemptId}/events`, {
        token: s.token,
        session: s.session,
        body: { kind: 'window_blur', detail: 'load test' },
      });
    }
  }
  await heartbeats;
}

async function staffLoop(token: string, quizId: number, endAt: number) {
  let after = 0;
  while (Date.now() < endAt) {
    await call(`monitor (${Math.ceil(STUDENTS / QUIZZES)} rows)`, 'GET', `/api/proctor/quiz/${quizId}`, { token });
    const feed = await call('monitor event feed', 'GET', `/api/proctor/quiz/${quizId}/events?after=${after}`, { token });
    after = Math.max(after, ...((feed.body?.events ?? []) as { id: number }[]).map((e) => e.id));
    await sleep(Math.min(5_000, Math.max(0, endAt - Date.now())));
  }
}

// ------------------------------------------------------------------ main

async function phase<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; seconds: number }> {
  process.stdout.write(`\n▶ ${label}… `);
  const t0 = performance.now();
  const result = await fn();
  const seconds = (performance.now() - t0) / 1000;
  process.stdout.write(`done in ${seconds.toFixed(1)} s`);
  return { result, seconds };
}

async function main() {
  console.log(
    `Interval load test — ${STUDENTS} students across ${QUIZZES} live exam(s), ${DURATION_S} s exam phase, data in ${DATA_DIR}`,
  );
  await phase('building API (tsc)', async () => execSync('npx tsc -p tsconfig.json', { cwd: API_DIR, stdio: 'inherit' }));
  const { result: seeded } = await phase(`seeding ${STUDENTS} students + ${QUIZZES} 25-question exam(s)`, seed);
  const server = startServer();
  const timings: Record<string, number> = {};
  try {
    await phase('waiting for server', waitForHealth);

    const students: Student[] = Array.from({ length: STUDENTS }, (_, i) => ({
      email: `2026lt${String(i + 1).padStart(4, '0')}@iitrpr.ac.in`,
      exam: seeded.exams[i % QUIZZES] as SeededExam,
      questions: [],
      revisions: new Map(),
      lastAnnouncement: 0,
    }));

    timings.login_burst_s = (
      await phase(`login burst (${STUDENTS} at once)`, () =>
        Promise.all(
          students.map(async (s) => {
            const r = await call('login', 'POST', '/api/auth/login', { body: { email: s.email, password: PASSWORD } });
            s.token = r.body?.token;
          }),
        ),
      )
    ).seconds;

    timings.start_burst_s = (
      await phase(`start burst (${STUDENTS} at once)`, () =>
        Promise.all(
          students.map(async (s) => {
            if (!s.token) return;
            const r = await call('start attempt', 'POST', `/api/attempts/quiz/${s.exam.versionId}`, { token: s.token });
            s.attemptId = r.body?.attempt?.id;
            s.session = r.body?.session_token;
            s.questions = r.body?.questions ?? [];
          }),
        ),
      )
    ).seconds;

    const staff = await call('login', 'POST', '/api/auth/login', { body: { email: seeded.staffEmail, password: PASSWORD } });
    // One live monitor per exam (two when there is a single exam), polling every 5 s.
    const monitors = QUIZZES === 1 ? [seeded.exams[0], seeded.exams[0]] : seeded.exams;
    const cpuBefore = (await (await fetch(`${BASE}/api/health`)).json()).cpu_ms as number;
    const endAt = Date.now() + DURATION_S * 1000;
    const examPhase = await phase(`exam phase (${DURATION_S} s of autosave + heartbeats + live monitor)`, () =>
      Promise.all([
        ...students.map((s) => examLoop(s, endAt)),
        ...monitors.map((m) => staffLoop(staff.body.token, (m as SeededExam).quizId, endAt)),
      ]),
    );
    timings.exam_phase_s = examPhase.seconds;
    const cpuAfter = (await (await fetch(`${BASE}/api/health`)).json()).cpu_ms as number;
    timings.exam_phase_cpu_percent_of_one_core = Math.round(((cpuAfter - cpuBefore) / (examPhase.seconds * 1000)) * 1000) / 10;

    timings.submit_burst_s = (
      await phase(`submit burst (${STUDENTS} at once)`, () =>
        Promise.all(
          students.map((s) =>
            s.attemptId
              ? call('submit', 'POST', `/api/attempts/${s.attemptId}/submit`, { token: s.token, session: s.session })
              : Promise.resolve(null),
          ),
        ),
      )
    ).seconds;

    await call('gradebook CSV export', 'GET', `/api/results/quiz/${(seeded.exams[0] as SeededExam).versionId}/export.csv`, {
      token: staff.body.token,
    });

    const health = await (await fetch(`${BASE}/api/health`)).json();
    report(timings, health, examPhase.seconds);
  } finally {
    server.kill('SIGTERM');
    agent.destroy();
  }
}

function report(timings: Record<string, number>, health: any, examSeconds: number) {
  const rows = [...samples.entries()].map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const errs = failures.get(name);
    return {
      endpoint: name,
      requests: values.length,
      connection_retries: retries.get(name) ?? 0,
      errors: errs ? [...errs.values()].reduce((a, b) => a + b, 0) : 0,
      error_kinds: errs ? Object.fromEntries(errs) : {},
      p50_ms: Math.round(pct(sorted, 50)),
      p95_ms: Math.round(pct(sorted, 95)),
      p99_ms: Math.round(pct(sorted, 99)),
      max_ms: Math.round(sorted[sorted.length - 1] ?? 0),
    };
  });
  const examRequests = [...samples.entries()]
    .filter(([n]) => ['save answer', 'heartbeat', 'integrity event'].includes(n) || n.startsWith('monitor'))
    .reduce((a, [, v]) => a + v.length, 0);
  const totalErrors = rows.reduce((a, r) => a + r.errors, 0);

  console.log('\n\n| Endpoint | Requests | Errors | Conn. retries | p50 ms | p95 ms | p99 ms | max ms |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(
      `| ${r.endpoint} | ${r.requests} | ${r.errors} | ${r.connection_retries} | ${r.p50_ms} | ${r.p95_ms} | ${r.p99_ms} | ${r.max_ms} |`,
    );
  }
  console.log(`\nBursts: login ${timings.login_burst_s?.toFixed(1)} s · start ${timings.start_burst_s?.toFixed(1)} s · submit ${timings.submit_burst_s?.toFixed(1)} s`);
  console.log(`Exam phase throughput: ${(examRequests / examSeconds).toFixed(1)} req/s sustained`);
  console.log(`Server event-loop delay: p50 ${health.event_loop_delay_ms.p50} ms · p99 ${health.event_loop_delay_ms.p99} ms · max ${health.event_loop_delay_ms.max} ms · RSS ${health.memory_mb} MB`);
  console.log(`Server CPU during the exam phase: ${timings.exam_phase_cpu_percent_of_one_core}% of one core`);
  console.log(`Total errors: ${totalErrors}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `results-${STUDENTS}-students${QUIZZES > 1 ? `-${QUIZZES}-quizzes` : ''}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        students: STUDENTS,
        live_quizzes: QUIZZES,
        exam_phase_seconds: DURATION_S,
        machine: { platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, node: process.version },
        bursts_seconds: timings,
        exam_phase_req_per_s: Math.round((examRequests / examSeconds) * 10) / 10,
        server: health,
        endpoints: rows,
        total_errors: totalErrors,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
