import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

// This file intentionally does NOT import './_env.js'. Every other suite file
// imports it to share one throwaway INTERVAL_DATA_DIR, but this drill must own
// fresh source/restore directories and must never reuse a suite-wide database.
// The only processes that load application code are started below with an
// explicitly sanitized environment, so an inherited INTERVAL_* value from the
// developer's shell cannot redirect them at real data.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, '../..');
const tsxCli = path.join(apiRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * Copy the inherited environment minus every INTERVAL_* setting, then apply
 * only the values this drill needs. This is what keeps a developer's exported
 * INTERVAL_DATA_DIR (or INTERVAL_DB_SYNC) out of both subprocesses.
 */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('INTERVAL_')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** Run the locally installed tsx CLI with the current Node binary (no npx/PATH lookup). */
function runLocalTsx(scriptPath: string, env: Record<string, string>): SpawnSyncReturns<string> {
  assert.ok(
    fs.existsSync(tsxCli),
    `Local tsx runtime is not installed at ${tsxCli}; run npm install in apps/api before running this test.`,
  );
  return spawnSync(process.execPath, [tsxCli, scriptPath], {
    cwd: apiRoot,
    env: cleanEnv(env),
    encoding: 'utf-8',
  });
}

const SENTINEL_ROWS = 8;

describe('Backup and Restoration Verification', () => {
  it('creates a native backup under WAL and restores it independently into a fresh database directory', () => {
    const dirSource = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-backup-src-'));
    const dirDest = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-backup-dest-'));
    // Scripts live outside dirSource so the source database and its WAL can be
    // deleted before the restore is verified.
    const dirScripts = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-backup-scripts-'));

    try {
      const dbModuleUrl = pathToFileURL(path.join(apiRoot, 'src', 'db.ts')).href;

      // Populate one related row in each core table, then take the production
      // backupDatabase() snapshot while the writes are still in the WAL.
      const populateScript = `import fs from 'node:fs';
const { db, backupDatabase, DB_PATH, DATA_DIR } = await import(${JSON.stringify(dbModuleUrl)});

db.prepare("INSERT INTO users (id, name, email, password_hash, role) VALUES (101, 'Sentinel Student', 'sentinel@test.com', 'hash123', 'student')").run();
db.prepare("INSERT INTO courses (id, code, name, created_by) VALUES (201, 'CS101', 'Intro to CS', 101)").run();
db.prepare("INSERT INTO quizzes (id, course_id, created_by) VALUES (301, 201, 101)").run();
db.prepare("INSERT INTO quiz_versions (id, quiz_id, course_id, created_by, version, title, status) VALUES (401, 301, 201, 101, 1, 'Exam 1', 'published')").run();
db.prepare("INSERT INTO questions (id, quiz_version_id, qtype, text, answer, order_index) VALUES (501, 401, 'single', 'What is 2+2?', '4', 1)").run();
db.prepare("INSERT INTO attempts (id, quiz_version_id, user_id, status, question_order, seed) VALUES (601, 401, 101, 'submitted', '[501]', 42)").run();
db.prepare("INSERT INTO answer_revisions (id, attempt_id, question_id, position, answer, saved_at, status) VALUES (701, 601, 501, 0, '4', datetime('now'), 'submitted')").run();
db.prepare("INSERT INTO results (id, attempt_id, quiz_version_id, user_id, score, max_score) VALUES (801, 601, 401, 101, 10, 10)").run();

// Evidence the snapshot really is taken from a live WAL, not a rolled-back journal.
const walPresent = fs.existsSync(DB_PATH + '-wal');
const backupFile = await backupDatabase();
console.log('DATA_DIR:' + DATA_DIR);
console.log('WAL_PRESENT:' + walPresent);
console.log('BACKUP_FILE:' + backupFile);
`;
      const populatePath = path.join(dirScripts, 'populate.mjs');
      fs.writeFileSync(populatePath, populateScript, 'utf-8');

      const sourceProc = runLocalTsx(populatePath, { INTERVAL_DATA_DIR: dirSource });
      assert.strictEqual(
        sourceProc.status,
        0,
        `Source population and backup failed: ${sourceProc.stderr || sourceProc.stdout}`,
      );
      assert.ok(
        sourceProc.stdout.includes(`DATA_DIR:${dirSource}`),
        `Child process did not use the temporary data directory; inherited INTERVAL_* config leaked. stdout=${sourceProc.stdout}`,
      );
      assert.ok(
        sourceProc.stdout.includes('WAL_PRESENT:true'),
        `Expected a live WAL before backup; stdout=${sourceProc.stdout}`,
      );

      const match = sourceProc.stdout.match(/BACKUP_FILE:(.*)/);
      assert.ok(match, 'Backup file path not found in stdout');
      const captured = match[1];
      assert.ok(captured, 'Backup file path was empty');
      const backupPath = captured.trim();

      assert.strictEqual(
        path.dirname(backupPath),
        path.join(dirSource, 'backups'),
        `Backup was written outside the temporary source directory: ${backupPath}`,
      );
      assert.ok(fs.existsSync(backupPath), `Backup file does not exist at ${backupPath}`);
      assert.ok(fs.statSync(backupPath).size > 0, 'Backup file is empty');

      // Restore: a standalone database file, copied into an empty directory.
      const restoredDbPath = path.join(dirDest, 'interval.db');
      fs.copyFileSync(backupPath, restoredDbPath);
      assert.deepStrictEqual(fs.readdirSync(dirDest).sort(), ['interval.db']);

      // Independent restore: remove the source database and its WAL so nothing
      // in the verification path can fall back to the original files.
      fs.rmSync(dirSource, { recursive: true, force: true });
      assert.ok(!fs.existsSync(dirSource), 'Source database directory was not removed');

      // A fresh plain-Node process (no tsx, no app config, no _env.js) verifies
      // structure, exact rows, and relational consistency in the restored copy.
      const verifyScript = `import assert from 'node:assert';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const intervalKeys = Object.keys(process.env).filter((key) => key.startsWith('INTERVAL_'));
assert.strictEqual(intervalKeys.length, 0, 'Restore verifier inherited INTERVAL configuration: ' + intervalKeys.join(','));
console.log('INTERVAL_ENV_KEYS:' + intervalKeys.length);

const dbPath = process.env.RESTORED_DB_PATH;
assert.ok(dbPath, 'RESTORED_DB_PATH must be set');
assert.ok(fs.existsSync(dbPath), 'Restored database file is missing');

const db = new DatabaseSync(dbPath);

const integrity = db.prepare('PRAGMA integrity_check').all();
assert.strictEqual(integrity.length, 1, 'integrity_check returned an unexpected number of rows');
assert.strictEqual(integrity[0].integrity_check, 'ok', 'integrity_check failed');
console.log('INTEGRITY_CHECK:' + integrity[0].integrity_check);

const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
assert.strictEqual(fkCheck.length, 0, 'foreign_key_check reported violations: ' + JSON.stringify(fkCheck));
console.log('FOREIGN_KEY_CHECK:' + fkCheck.length);

const schemaTables = new Set(
  db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name),
);
for (const required of ['users', 'courses', 'quizzes', 'quiz_versions', 'questions', 'attempts', 'answer_revisions', 'results', 'schema_migrations']) {
  assert.ok(schemaTables.has(required), 'Missing table after restore: ' + required);
}

const tables = ['users', 'courses', 'quizzes', 'quiz_versions', 'questions', 'attempts', 'answer_revisions', 'results'];
const counts = {};
for (const table of tables) {
  counts[table] = db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}
assert.deepStrictEqual(counts, {
  users: 1,
  courses: 1,
  quizzes: 1,
  quiz_versions: 1,
  questions: 1,
  attempts: 1,
  answer_revisions: 1,
  results: 1,
});

const user = db.prepare('SELECT * FROM users WHERE id = 101').get();
assert.ok(user, 'User record not found');
assert.strictEqual(user.name, 'Sentinel Student');
assert.strictEqual(user.email, 'sentinel@test.com');
assert.strictEqual(user.password_hash, 'hash123');
assert.strictEqual(user.role, 'student');

const course = db.prepare('SELECT * FROM courses WHERE id = 201').get();
assert.ok(course, 'Course record not found');
assert.strictEqual(course.code, 'CS101');
assert.strictEqual(course.name, 'Intro to CS');
assert.strictEqual(course.created_by, 101);

const quiz = db.prepare('SELECT * FROM quizzes WHERE id = 301').get();
assert.ok(quiz, 'Quiz record not found');
assert.strictEqual(quiz.course_id, 201);
assert.strictEqual(quiz.created_by, 101);

const version = db.prepare('SELECT * FROM quiz_versions WHERE id = 401').get();
assert.ok(version, 'Quiz version record not found');
assert.strictEqual(version.quiz_id, 301);
assert.strictEqual(version.version, 1);
assert.strictEqual(version.title, 'Exam 1');
assert.strictEqual(version.status, 'published');
assert.strictEqual(version.quiz_type, 'anytime');

const question = db.prepare('SELECT * FROM questions WHERE id = 501').get();
assert.ok(question, 'Question record not found');
assert.strictEqual(question.quiz_version_id, 401);
assert.strictEqual(question.qtype, 'single');
assert.strictEqual(question.text, 'What is 2+2?');
assert.strictEqual(question.answer, '4');
assert.strictEqual(question.order_index, 1);

const attempt = db.prepare('SELECT * FROM attempts WHERE id = 601').get();
assert.ok(attempt, 'Attempt record not found');
assert.strictEqual(attempt.quiz_version_id, 401);
assert.strictEqual(attempt.user_id, 101);
assert.strictEqual(attempt.status, 'submitted');
assert.strictEqual(attempt.question_order, '[501]');
assert.strictEqual(attempt.seed, 42);

const revision = db.prepare('SELECT * FROM answer_revisions WHERE id = 701').get();
assert.ok(revision, 'Answer revision record not found');
assert.strictEqual(revision.attempt_id, 601);
assert.strictEqual(revision.question_id, 501);
assert.strictEqual(revision.position, 0);
assert.strictEqual(revision.answer, '4');
assert.strictEqual(revision.status, 'submitted');

const result = db.prepare('SELECT * FROM results WHERE id = 801').get();
assert.ok(result, 'Result record not found');
assert.strictEqual(result.attempt_id, 601);
assert.strictEqual(result.quiz_version_id, 401);
assert.strictEqual(result.user_id, 101);
assert.strictEqual(result.score, 10);
assert.strictEqual(result.max_score, 10);

// One row per sentinel table only proves independent inserts; this join proves
// the restored foreign-key graph still connects the same entities.
const joined = db.prepare(
  'SELECT u.name AS user_name, u.email AS user_email, ' +
  'c.code AS course_code, c.name AS course_name, ' +
  'qv.title AS quiz_title, q.text AS question_text, q.answer AS question_answer, ' +
  'a.status AS attempt_status, a.seed AS attempt_seed, ' +
  'ar.answer AS revision_answer, r.score AS result_score, r.max_score AS result_max_score ' +
  'FROM users u ' +
  'JOIN courses c ON c.created_by = u.id ' +
  'JOIN quizzes qz ON qz.course_id = c.id ' +
  'JOIN quiz_versions qv ON qv.quiz_id = qz.id ' +
  'JOIN questions q ON q.quiz_version_id = qv.id ' +
  'JOIN attempts a ON a.quiz_version_id = qv.id ' +
  'JOIN answer_revisions ar ON ar.attempt_id = a.id AND ar.question_id = q.id ' +
  'JOIN results r ON r.attempt_id = a.id ' +
  'WHERE u.id = 101',
).all();
assert.strictEqual(joined.length, 1, 'Relational join across restored tables returned an unexpected number of rows');
assert.deepStrictEqual({ ...joined[0] }, {
  user_name: 'Sentinel Student',
  user_email: 'sentinel@test.com',
  course_code: 'CS101',
  course_name: 'Intro to CS',
  quiz_title: 'Exam 1',
  question_text: 'What is 2+2?',
  question_answer: '4',
  attempt_status: 'submitted',
  attempt_seed: 42,
  revision_answer: '4',
  result_score: 10,
  result_max_score: 10,
});

// The restored copy must also accept writes (WAL recovery and page allocation
// work), not merely answer reads. This touches only the temporary restore copy.
db.exec("INSERT INTO audit_log (action, target) VALUES ('restore-write-probe', 'backup.restore.test')");
const probe = db.prepare("SELECT action, target FROM audit_log WHERE action = 'restore-write-probe'").get();
assert.ok(probe, 'Write probe row not found in restored database');
assert.strictEqual(probe.target, 'backup.restore.test');

db.close();
console.log('SENTINEL_ROWS:${SENTINEL_ROWS}');
console.log('RESTORE_VERIFIED_SUCCESSFULLY');
`;
      const verifyPath = path.join(dirScripts, 'verify.mjs');
      fs.writeFileSync(verifyPath, verifyScript, 'utf-8');

      const verifyProc = spawnSync(process.execPath, [verifyPath], {
        // Deliberately minimal environment: no PATH, no HOME, no INTERVAL_*.
        env: { RESTORED_DB_PATH: restoredDbPath },
        encoding: 'utf-8',
      });
      assert.strictEqual(
        verifyProc.status,
        0,
        `Restoration verification subprocess failed: ${verifyProc.stderr || verifyProc.stdout}`,
      );
      assert.ok(verifyProc.stdout.includes('INTERVAL_ENV_KEYS:0'), `Verifier environment was not sanitized: ${verifyProc.stdout}`);
      assert.ok(verifyProc.stdout.includes('INTEGRITY_CHECK:ok'), `Integrity check not ok: ${verifyProc.stdout}`);
      assert.ok(verifyProc.stdout.includes('FOREIGN_KEY_CHECK:0'), `Foreign key violations: ${verifyProc.stdout}`);
      assert.ok(verifyProc.stdout.includes(`SENTINEL_ROWS:${SENTINEL_ROWS}`), `Sentinel row count mismatch: ${verifyProc.stdout}`);
      assert.ok(verifyProc.stdout.includes('RESTORE_VERIFIED_SUCCESSFULLY'));
    } finally {
      for (const dir of [dirSource, dirDest, dirScripts]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
