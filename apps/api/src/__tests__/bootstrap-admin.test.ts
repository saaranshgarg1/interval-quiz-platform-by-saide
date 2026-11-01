import './_env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * Every case runs against a brand-new temporary database directory. The CLI is
 * executed as a child process (local tsx, never npx) so each refusal happens
 * before db.ts is imported and therefore cannot open or migrate a database.
 */

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrapPath = path.join(apiRoot, 'src', 'bootstrap-admin.ts');
const tsxUrl = import.meta.resolve('tsx');

const SECRETS = {
  INTERVAL_JWT_SECRET: 'synthetic-bootstrap-jwt-secret-for-tests-1234567890',
  INTERVAL_PASSWORD_PEPPER: 'synthetic-bootstrap-pepper-for-tests-0987654321',
};

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  const inherited = process.env.INTERVAL_DATA_DIR;
  if (inherited) fs.rmSync(inherited, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `interval-bootstrap-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.INTERVAL_DATA_DIR;
  delete env.INTERVAL_JWT_SECRET;
  delete env.INTERVAL_PASSWORD_PEPPER;
  return {
    ...env,
    NODE_ENV: 'production',
    INTERVAL_DATA_DIR: dir,
    ...SECRETS,
  };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  dir: string,
  args: string[],
  overrides: Record<string, string | undefined> = {},
  entryPath = bootstrapPath,
): RunResult {
  const env = baseEnv(dir);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ['--import', tsxUrl, entryPath, ...args],
    { cwd: dir, env, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface PreparedUser {
  id: number;
  email: string;
  token_version: number;
}

function prepareUsers(
  dir: string,
  users: { name: string; email: string; role: 'student' | 'instructor' | 'admin' }[],
): PreparedUser[] {
  const script = `
    const { userRepo } = await import('./src/repo.js');
    const users = ${JSON.stringify(users)};
    const created = users.map((u) => {
      const user = userRepo.create(u.name, u.email, 'synthetic:hash', u.role);
      return { id: user.id, email: user.email, token_version: user.token_version };
    });
    console.log('PREPARED:' + JSON.stringify(created));
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', tsxUrl, '--input-type=module', '-e', script],
    { cwd: apiRoot, env: baseEnv(dir), encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(
    result.status,
    0,
    `isolated database preparation failed: ${result.stderr || result.stdout}`,
  );
  const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith('PREPARED:'));
  assert.ok(line, 'preparation did not report created users');
  return JSON.parse(line.slice('PREPARED:'.length)) as PreparedUser[];
}

function assertNoDatabase(dir: string): void {
  assert.equal(
    fs.existsSync(path.join(dir, 'interval.db')),
    false,
    'a refused bootstrap must not create the database file',
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'a refused bootstrap must leave the data directory empty');
}

function readDb<T>(dir: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dir, 'interval.db'), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('refuses missing, malformed, duplicate, empty-value and password-bearing arguments before opening a database', () => {
  const cases: { args: string[]; message: RegExp }[] = [
    { args: [], message: /--email is required/ },
    { args: ['--email'], message: /requires a value/ },
    { args: ['--email', 'not-an-email'], message: /valid email/ },
    { args: ['--email', 'one@example.com', '--email', 'two@example.com'], message: /only once/ },
    { args: ['--email', '--password', 'secret'], message: /requires a value/ },
    { args: ['--email=operator@example.com'], message: /Only --email/ },
    { args: ['--email', 'operator@example.com', '--password', 'secret'], message: /never accepts passwords/ },
  ];

  for (const { args, message } of cases) {
    const dir = tempDir('args');
    const result = runCli(dir, args);
    assert.notEqual(result.status, 0, `expected refusal for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /Refusing:/);
    assert.match(result.stderr, message);
    assertNoDatabase(dir);
  }
});

test('refuses before opening the database when production secrets are missing, weak or dev defaults', () => {
  const cases: { overrides: Record<string, string | undefined>; message: RegExp }[] = [
    {
      overrides: { INTERVAL_JWT_SECRET: undefined, INTERVAL_PASSWORD_PEPPER: undefined },
      message: /INTERVAL_JWT_SECRET and INTERVAL_PASSWORD_PEPPER/,
    },
    {
      overrides: { INTERVAL_JWT_SECRET: undefined },
      message: /INTERVAL_JWT_SECRET/,
    },
    {
      overrides: { INTERVAL_PASSWORD_PEPPER: 'short' },
      message: /INTERVAL_PASSWORD_PEPPER/,
    },
    {
      overrides: { INTERVAL_JWT_SECRET: 'interval-dev-jwt-secret-change-me' },
      message: /INTERVAL_JWT_SECRET/,
    },
  ];

  for (const { overrides, message } of cases) {
    const dir = tempDir('secrets');
    const result = runCli(dir, ['--email', 'operator@example.com'], overrides);
    assert.notEqual(result.status, 0, 'expected a secret-configuration refusal');
    assert.match(result.stderr, /Refusing:/);
    assert.match(result.stderr, message);
    assert.ok(!result.stderr.includes('short'), 'secret values must never be printed');
    assertNoDatabase(dir);
  }
});

test('refuses implicit, relative and nonexistent database targets before importing database code', () => {
  for (const kind of ['missing', 'blank', 'relative', 'absent', 'empty', 'directory']) {
    const dir = tempDir(`target-${kind}`);
    // Run a standalone copy so even a regression cannot import the real database module.
    const entry = path.join(dir, 'bootstrap-admin.mts');
    fs.copyFileSync(bootstrapPath, entry);
    let target: string | undefined;
    switch (kind) {
      case 'blank': target = '   '; break;
      case 'relative': target = 'data'; break;
      case 'absent': target = path.join(dir, 'absent'); break;
      case 'empty': target = dir; break;
      case 'directory':
        target = dir;
        fs.mkdirSync(path.join(dir, 'interval.db'));
        break;
    }
    const before = fs.readdirSync(dir).sort();
    const result = runCli(dir, ['--email', 'operator@example.com'], { INTERVAL_DATA_DIR: target }, entry);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing: INTERVAL_DATA_DIR must/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    if (kind === 'directory') assert.deepEqual(fs.readdirSync(path.join(dir, 'interval.db')), []);
  }
});

test('refuses when no exact registered account exists and leaves the database unchanged', () => {
  const dir = tempDir('missing-target');
  const prepared = prepareUsers(dir, [
    { name: 'Alpha Student', email: 'alpha@example.com', role: 'student' },
    { name: 'Beta Student', email: 'beta@example.com', role: 'student' },
  ]);

  const result = runCli(dir, ['--email', 'ghost@example.com']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no registered account exists/i);

  readDb(dir, (db) => {
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n), 0);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n), prepared.length);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n), 0);
    for (const user of prepared) {
      const row = db.prepare('SELECT role, token_version FROM users WHERE id = ?').get(user.id) as {
        role: string;
        token_version: number;
      };
      assert.equal(row.role, 'student');
      assert.equal(Number(row.token_version), 0);
    }
  });
});

test('promotes only the exact target, revokes its tokens, records truthful audit, then refuses a second bootstrap', () => {
  const dir = tempDir('success');
  const prepared = prepareUsers(dir, [
    { name: 'Alpha Student', email: 'alpha@example.com', role: 'student' },
    { name: 'Beta Student', email: 'beta@example.com', role: 'student' },
    { name: 'Course Instructor', email: 'instructor@example.com', role: 'instructor' },
  ]);
  const alpha = prepared[0]!;
  const beta = prepared[1]!;
  const instructor = prepared[2]!;

  const first = runCli(dir, ['--email', 'alpha@example.com']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /promoted alpha@example\.com/);
  assert.match(first.stdout, /sessions revoked/);
  assert.ok(!first.stdout.includes(SECRETS.INTERVAL_JWT_SECRET));
  assert.ok(!first.stdout.includes(SECRETS.INTERVAL_PASSWORD_PEPPER));
  assert.ok(!first.stdout.includes('synthetic:hash'));

  readDb(dir, (db) => {
    const users = db.prepare('SELECT id, email, role, token_version FROM users ORDER BY id').all() as {
      id: number;
      email: string;
      role: string;
      token_version: number;
    }[];
    assert.equal(users.length, 3, 'no accounts may be created or removed');
    assert.deepEqual(
      users.map((u) => ({ id: Number(u.id), email: u.email, role: u.role })),
      [
        { id: alpha.id, email: 'alpha@example.com', role: 'admin' },
        { id: beta.id, email: 'beta@example.com', role: 'student' },
        { id: instructor.id, email: 'instructor@example.com', role: 'instructor' },
      ],
    );
    assert.equal(Number(users[0]!.token_version), 1, 'target sessions must be revoked');
    assert.equal(Number(users[1]!.token_version), 0, 'other users must not be touched');
    assert.equal(Number(users[2]!.token_version), 0, 'other users must not be touched');
    assert.equal(
      Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n),
      1,
    );

    const audit = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as {
      actor_id: number | null;
      actor_role: string | null;
      course_id: number | null;
      action: string;
      target: string;
      before: string;
      after: string;
      created_at: string;
    }[];
    assert.equal(audit.length, 1);
    const row = audit[0]!;
    assert.equal(row.actor_id, null, 'CLI bootstrap has no authenticated actor');
    assert.equal(row.actor_role, null);
    assert.equal(row.course_id, null);
    assert.equal(row.action, 'bootstrap.admin.promote');
    assert.equal(row.target, `user:${alpha.id}`);
    assert.deepEqual(JSON.parse(row.before), { role: 'student' });
    assert.deepEqual(JSON.parse(row.after), {
      role: 'admin',
      origin: 'cli-bootstrap',
      email_ownership_verified: false,
    });
    assert.ok(row.created_at);

    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  const secondTarget = runCli(dir, ['--email', 'beta@example.com']);
  assert.notEqual(secondTarget.status, 0);
  assert.match(secondTarget.stderr, /administrator already exists/i);

  const repeatTarget = runCli(dir, ['--email', 'alpha@example.com']);
  assert.notEqual(repeatTarget.status, 0);
  assert.match(repeatTarget.stderr, /administrator already exists/i);

  readDb(dir, (db) => {
    assert.equal(
      Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n),
      1,
    );
    const betaRow = db.prepare('SELECT role, token_version FROM users WHERE id = ?').get(beta.id) as {
      role: string;
      token_version: number;
    };
    assert.equal(betaRow.role, 'student');
    assert.equal(Number(betaRow.token_version), 0);
    const alphaRow = db.prepare('SELECT role, token_version FROM users WHERE id = ?').get(alpha.id) as {
      role: string;
      token_version: number;
    };
    assert.equal(alphaRow.role, 'admin');
    assert.equal(Number(alphaRow.token_version), 1, 'refused attempts must not revoke tokens again');
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n), 1);
  });
});

test('refuses when any administrator already exists before bootstrap', () => {
  const dir = tempDir('existing-admin');
  const prepared = prepareUsers(dir, [
    { name: 'Existing Admin', email: 'admin@example.com', role: 'admin' },
    { name: 'Alpha Student', email: 'alpha@example.com', role: 'student' },
  ]);
  const student = prepared[1]!;

  const result = runCli(dir, ['--email', 'alpha@example.com']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /administrator already exists/i);

  readDb(dir, (db) => {
    const row = db.prepare('SELECT role, token_version FROM users WHERE id = ?').get(student.id) as {
      role: string;
      token_version: number;
    };
    assert.equal(row.role, 'student');
    assert.equal(Number(row.token_version), 0);
    assert.equal(
      Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n),
      1,
    );
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n), 0);
  });
});
