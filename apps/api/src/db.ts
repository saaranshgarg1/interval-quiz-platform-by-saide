import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR =
  process.env.INTERVAL_DATA_DIR ??
  path.resolve(__dirname, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'interval.db');

const raw = new DatabaseSync(DB_PATH);

raw.exec('PRAGMA journal_mode = WAL;');
raw.exec('PRAGMA foreign_keys = ON;');
// Block (don't error) when another connection holds a write lock — keeps
// concurrent writers (e.g. parallel test processes) from hitting SQLITE_BUSY.
raw.exec('PRAGMA busy_timeout = 5000;');
// In WAL mode NORMAL never corrupts the database; it only skips the fsync per
// commit (an OS crash may roll back the last few hundred ms of writes, a process
// crash loses nothing). That is what lets a single node serve hundreds of
// autosaves per second. Set INTERVAL_DB_SYNC=FULL to fsync every commit.
raw.exec(`PRAGMA synchronous = ${process.env.INTERVAL_DB_SYNC === 'FULL' ? 'FULL' : 'NORMAL'};`);
raw.exec('PRAGMA cache_size = -32000;'); // ~32 MB page cache
raw.exec('PRAGMA temp_store = MEMORY;');

/**
 * Prepared-statement cache. node:sqlite compiles SQL on every `prepare`, which
 * dominated request time under load; statements are reusable because every
 * call runs to completion synchronously.
 */
const statements = new Map<string, StatementSync>();
const MAX_CACHED_STATEMENTS = 2000;

export const db = {
  prepare(sql: string): StatementSync {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql);
      if (statements.size >= MAX_CACHED_STATEMENTS) statements.clear();
      statements.set(sql, stmt);
    }
    return stmt;
  },
  exec(sql: string): void {
    raw.exec(sql);
  },
  get isTransaction(): boolean {
    return raw.isTransaction;
  },
  close(): void {
    statements.clear();
    raw.close();
  },
};

/**
 * Online, incremental backup into a standalone database file. Copies a few
 * hundred pages per step and yields between steps, so it can run during a live
 * exam without stalling saves. Keeps the newest `keep` files in the folder.
 */
export async function backupDatabase(dir = path.join(DATA_DIR, 'backups'), keep = 48): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `interval-${stamp}.db`);
  await backup(raw, file, { rate: 200 });
  const old = fs
    .readdirSync(dir)
    .filter((f) => /^interval-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

let txDepth = 0;

/**
 * Run `fn` atomically. The outermost call opens `BEGIN IMMEDIATE`; nested calls
 * become savepoints, so repo helpers that need atomicity can be composed inside
 * larger service-level transactions. `fn` must be synchronous.
 */
export function transaction<T>(fn: () => T): T {
  const outer = txDepth === 0;
  const savepoint = `sp_${txDepth}`;
  raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  txDepth++;
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('transaction() callbacks must be synchronous.');
    raw.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (e) {
    if (outer) {
      if (raw.isTransaction) raw.exec('ROLLBACK');
    } else {
      raw.exec(`ROLLBACK TO ${savepoint}`);
      raw.exec(`RELEASE ${savepoint}`);
    }
    throw e;
  } finally {
    txDepth--;
  }
}

const BASELINE_SQL = `
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('student','instructor','admin')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS courses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL CHECK (role IN ('student','ta','instructor')),
      UNIQUE (course_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS quizzes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quiz_versions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id           INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      course_id         INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      created_by        INTEGER NOT NULL REFERENCES users(id),
      version           INTEGER NOT NULL DEFAULT 1,
      status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
      title             TEXT NOT NULL,
      instructions      TEXT NOT NULL DEFAULT '',
      duration_minutes  INTEGER,
      shuffle_questions INTEGER NOT NULL DEFAULT 0,
      shuffle_options   INTEGER NOT NULL DEFAULT 0,
      attempts_allowed  INTEGER NOT NULL DEFAULT 1,
      integrity_policy  TEXT NOT NULL DEFAULT 'off' CHECK (integrity_policy IN ('off','warn','strict')),
      policy_trigger    TEXT NOT NULL DEFAULT 'focus_exit' CHECK (policy_trigger IN ('focus_exit','page_hidden')),
      show_scores       TEXT NOT NULL DEFAULT 'release' CHECK (show_scores IN ('never','release','immediate')),
      published_at      TEXT,
      archived_at       TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (quiz_id, version)
    );

    CREATE TABLE IF NOT EXISTS questions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_version_id INTEGER NOT NULL REFERENCES quiz_versions(id) ON DELETE CASCADE,
      version        INTEGER NOT NULL DEFAULT 1,
      qtype          TEXT NOT NULL CHECK (qtype IN ('single','multiple','short','numeric')),
      text           TEXT NOT NULL,
      options        TEXT,
      answer         TEXT NOT NULL,
      tolerance      REAL,
      points         REAL NOT NULL DEFAULT 1,
      order_index    INTEGER NOT NULL,
      is_latest      INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_version_id     INTEGER NOT NULL REFERENCES quiz_versions(id),
      user_id             INTEGER NOT NULL REFERENCES users(id),
      status              TEXT NOT NULL DEFAULT 'in_progress'
                          CHECK (status IN ('in_progress','submitted','expired','locked','under_review','reinstated')),
      started_at          TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at          TEXT,
      submitted_at        TEXT,
      question_order      TEXT NOT NULL,
      seed                INTEGER NOT NULL,
      score               REAL,
      max_score           REAL,
      graded_at           TEXT,
      receipt             TEXT,
      release_token       TEXT,
      submitted_revision  INTEGER NOT NULL DEFAULT 0,
      last_save_at        TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_quiz ON attempts(quiz_version_id);

    CREATE TABLE IF NOT EXISTS answer_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id),
      position    INTEGER NOT NULL,
      answer      TEXT NOT NULL,
      revision    INTEGER NOT NULL DEFAULT 1,
      saved_at    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('pending','saved','submitted')),
      UNIQUE (attempt_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS policy_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      detail      TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      source      TEXT NOT NULL DEFAULT 'client'
    );

    CREATE TABLE IF NOT EXISTS review_decisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      decided_by INTEGER NOT NULL REFERENCES users(id),
      decision   TEXT NOT NULL,
      reason     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS results (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id         INTEGER NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
      quiz_version_id    INTEGER NOT NULL REFERENCES quiz_versions(id),
      user_id            INTEGER NOT NULL REFERENCES users(id),
      score              REAL NOT NULL,
      max_score          REAL NOT NULL,
      answer_key_released INTEGER NOT NULL DEFAULT 0,
      released           INTEGER NOT NULL DEFAULT 0,
      released_at        TEXT,
      graded_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS question_banks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_by  INTEGER NOT NULL REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bank_questions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id     INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
      qtype       TEXT NOT NULL CHECK (qtype IN ('single','multiple','short','numeric')),
      text        TEXT NOT NULL,
      options     TEXT,
      answer      TEXT NOT NULL,
      tolerance   REAL,
      points      REAL NOT NULL DEFAULT 1,
      tags        TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS student_accommodations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id       INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      time_multiplier REAL NOT NULL DEFAULT 1.0,
      extra_minutes   INTEGER NOT NULL DEFAULT 0,
      notes           TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (course_id, user_id)
    );
  `;

// __MIGRATIONS_BLOCK__

interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Runs before `sql`, in the same transaction (table rebuilds). */
  before?: () => void;
  /** Table rebuilds need foreign-key enforcement off while the old table is dropped. */
  foreignKeysOff?: boolean;
}

const OLD_QTYPE_CHECK = "CHECK (qtype IN ('single','multiple','short','numeric'))";
const NEW_QTYPE_CHECK = "CHECK (qtype IN ('single','multiple','short','numeric','descriptive'))";

/**
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt from its own
 * stored definition (keeping every column added by later ALTERs) with the new
 * constraint, its rows copied, and its indexes recreated. Foreign keys in
 * other tables refer to it by name and keep working once it is renamed back.
 */
function widenQuestionTypes(table: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  if (!row || !row.sql.includes(OLD_QTYPE_CHECK)) return;
  const indexes = (db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table) as { sql: string }[]).map((r) => r.sql);
  const createNew = row.sql
    .replace(OLD_QTYPE_CHECK, NEW_QTYPE_CHECK)
    .replace(new RegExp(`^CREATE TABLE\\s+"?${table}"?`), `CREATE TABLE ${table}_rebuild`);
  raw.exec(createNew);
  raw.exec(`INSERT INTO ${table}_rebuild SELECT * FROM ${table}`);
  raw.exec(`DROP TABLE ${table}`);
  raw.exec(`ALTER TABLE ${table}_rebuild RENAME TO ${table}`);
  for (const sql of indexes) raw.exec(sql);
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', sql: BASELINE_SQL },
  {
    version: 2,
    name: 'audit_log',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id   INTEGER,
        actor_role TEXT,
        course_id  INTEGER,
        action     TEXT NOT NULL,
        target     TEXT,
        before     TEXT,
        after      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_course ON audit_log(course_id);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
    `,
  },
  {
    version: 3,
    name: 'scheduled_quiz_window',
    // Timed quizzes: an availability window on top of the per-attempt timer.
    //   quiz_type = 'anytime'   → attemptable whenever published (default; existing behaviour).
    //   quiz_type = 'scheduled' → attemptable only inside [window_opens_at, window_opens_at + window_duration_minutes).
    // duration_minutes still governs each individual attempt's countdown.
    sql: `
      ALTER TABLE quiz_versions ADD COLUMN quiz_type TEXT NOT NULL DEFAULT 'anytime'
        CHECK (quiz_type IN ('anytime','scheduled'));
      ALTER TABLE quiz_versions ADD COLUMN window_opens_at TEXT;
      ALTER TABLE quiz_versions ADD COLUMN window_duration_minutes INTEGER;
    `,
  },
  {
    version: 4,
    name: 'exam_platform',
    // Strict-exam platform:
    //   users          — entry numbers (IIT roll numbers) + per-user token version for revocation
    //   quiz_versions  — exam_settings JSON (proctoring/timing/access rules)
    //   quizzes        — live runtime state (paused / closed) shared by every version
    //   questions      — optional per-question time limit
    //   attempts       — session binding, heartbeat presence, violation counter, sequential cursor
    //   time_extensions / announcements / answer_history / pending_enrollments — new tables
    sql: `
      ALTER TABLE users ADD COLUMN entry_number TEXT;
      ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entry
        ON users(entry_number COLLATE NOCASE) WHERE entry_number IS NOT NULL;
      UPDATE OR IGNORE users
         SET entry_number = upper(substr(email, 1, instr(email, '@') - 1))
       WHERE entry_number IS NULL
         AND lower(substr(email, 1, instr(email, '@') - 1))
             GLOB '[0-9][0-9][0-9][0-9][a-z][a-z][a-z][0-9][0-9][0-9][0-9]';

      ALTER TABLE quiz_versions ADD COLUMN exam_settings TEXT NOT NULL DEFAULT '{}';

      -- Live state belongs to the quiz (the exam), not a version: students still
      -- writing v1 after a v2 publish are paused/closed/extended together.
      ALTER TABLE quizzes ADD COLUMN paused_at TEXT;
      ALTER TABLE quizzes ADD COLUMN closed_at TEXT;

      ALTER TABLE questions ADD COLUMN time_limit_seconds INTEGER;

      ALTER TABLE attempts ADD COLUMN session_hash TEXT;
      ALTER TABLE attempts ADD COLUMN session_started_at TEXT;
      ALTER TABLE attempts ADD COLUMN session_left_at TEXT;
      ALTER TABLE attempts ADD COLUMN reentry_allowed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE attempts ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE attempts ADD COLUMN last_seen_at TEXT;
      ALTER TABLE attempts ADD COLUMN start_ip TEXT;
      ALTER TABLE attempts ADD COLUMN last_ip TEXT;
      ALTER TABLE attempts ADD COLUMN user_agent TEXT;
      ALTER TABLE attempts ADD COLUMN violation_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE attempts ADD COLUMN last_violation_at TEXT;
      ALTER TABLE attempts ADD COLUMN current_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE attempts ADD COLUMN question_started_at TEXT;
      ALTER TABLE attempts ADD COLUMN question_expires_at TEXT;
      ALTER TABLE attempts ADD COLUMN extra_seconds INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE attempts ADD COLUMN lock_reason TEXT;
      ALTER TABLE attempts ADD COLUMN finalize_reason TEXT;

      CREATE INDEX IF NOT EXISTS idx_attempts_version_user ON attempts(quiz_version_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_status_expiry ON attempts(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_attempts_status_qexpiry ON attempts(status, question_expires_at);
      CREATE INDEX IF NOT EXISTS idx_policy_events_attempt ON policy_events(attempt_id, id);
      CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_questions_version ON questions(quiz_version_id, order_index);
      CREATE INDEX IF NOT EXISTS idx_results_version ON results(quiz_version_id);

      CREATE TABLE IF NOT EXISTS time_extensions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id         INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        seconds         INTEGER NOT NULL,
        applies_to_new  INTEGER NOT NULL DEFAULT 1,
        kind            TEXT NOT NULL DEFAULT 'extension' CHECK (kind IN ('extension','pause')),
        reason          TEXT,
        created_by      INTEGER REFERENCES users(id),
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_extensions_quiz ON time_extensions(quiz_id, user_id);

      CREATE TABLE IF NOT EXISTS announcements (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id         INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        message         TEXT NOT NULL,
        created_by      INTEGER REFERENCES users(id),
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_announcements_quiz ON announcements(quiz_id, id);

      CREATE TABLE IF NOT EXISTS answer_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL,
        answer      TEXT NOT NULL,
        revision    INTEGER NOT NULL,
        saved_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_answer_history_attempt ON answer_history(attempt_id, question_id);

      CREATE TABLE IF NOT EXISTS pending_enrollments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        email        TEXT NOT NULL COLLATE NOCASE,
        role         TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','ta','instructor')),
        entry_number TEXT,
        name         TEXT,
        created_by   INTEGER REFERENCES users(id),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (course_id, email)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_enrollments(email);
    `,
  },
  {
    version: 5,
    name: 'attempt_flags',
    // Flags raised by staff on a candidate's attempt (seen something in the hall,
    // suspicious answer pattern…), alongside the automatic browser signals.
    sql: `
      CREATE TABLE IF NOT EXISTS attempt_flags (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        severity    TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
        reason      TEXT NOT NULL,
        created_by  INTEGER REFERENCES users(id),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolved_by INTEGER REFERENCES users(id),
        resolution  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_attempt_flags_attempt ON attempt_flags(attempt_id);
    `,
  },
  {
    version: 6,
    name: 'random_bank_questions',
    // Random questions from a bank: a quiz holds "slots" (bank + difficulty/tag
    // filter + marks); each student's attempt draws a different bank question per
    // slot. A drawn question is copied once into `questions` (slot_id set) and
    // reused by every student who draws it, so grading/results/analytics see an
    // ordinary question. Authoring lists exclude rows with slot_id.
    sql: `
      ALTER TABLE bank_questions ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium'
        CHECK (difficulty IN ('easy','medium','hard'));

      CREATE TABLE IF NOT EXISTS question_slots (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_version_id    INTEGER NOT NULL REFERENCES quiz_versions(id) ON DELETE CASCADE,
        bank_id            INTEGER NOT NULL REFERENCES question_banks(id),
        difficulty         TEXT CHECK (difficulty IN ('easy','medium','hard')),
        tag                TEXT,
        points             REAL NOT NULL DEFAULT 1,
        time_limit_seconds INTEGER,
        order_index        INTEGER NOT NULL,
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_slots_version ON question_slots(quiz_version_id, order_index);
      CREATE INDEX IF NOT EXISTS idx_slots_bank ON question_slots(bank_id);

      ALTER TABLE questions ADD COLUMN slot_id INTEGER REFERENCES question_slots(id) ON DELETE CASCADE;
      ALTER TABLE questions ADD COLUMN bank_question_id INTEGER;
      ALTER TABLE questions ADD COLUMN draw_count INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_slot_bank ON questions(slot_id, bank_question_id)
        WHERE slot_id IS NOT NULL;
    `,
  },
  {
    version: 7,
    name: 'grading_and_insight',
    // Descriptive (hand-marked) questions; per-question assumptions; manual marks;
    // regrading (accept-also answers, full marks, drop) and fairness bonuses;
    // raise-hand questions; clarifications pinned to a question; appeals;
    // accessibility profiles and an account-wide time accommodation.
    foreignKeysOff: true,
    before: () => {
      widenQuestionTypes('questions');
      widenQuestionTypes('bank_questions');
    },
    sql: `
      ALTER TABLE questions ADD COLUMN allow_assumptions INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE questions ADD COLUMN grading_mode TEXT NOT NULL DEFAULT 'normal'
        CHECK (grading_mode IN ('normal','full_marks','dropped'));
      ALTER TABLE questions ADD COLUMN accept_also TEXT;
      ALTER TABLE questions ADD COLUMN bonus REAL NOT NULL DEFAULT 0;
      ALTER TABLE bank_questions ADD COLUMN allow_assumptions INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE answer_revisions ADD COLUMN assumption TEXT;
      ALTER TABLE answer_history ADD COLUMN assumption TEXT;
      ALTER TABLE results ADD COLUMN pending_manual INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE announcements ADD COLUMN question_id INTEGER;

      ALTER TABLE users ADD COLUMN a11y TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE users ADD COLUMN time_multiplier REAL NOT NULL DEFAULT 1;

      CREATE TABLE IF NOT EXISTS manual_grades (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL,
        marks       REAL NOT NULL,
        feedback    TEXT NOT NULL DEFAULT '',
        graded_by   INTEGER REFERENCES users(id),
        graded_at   TEXT NOT NULL,
        UNIQUE (attempt_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS hand_raises (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        question_id INTEGER,
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
        reply       TEXT,
        broadcast   INTEGER NOT NULL DEFAULT 0,
        replied_by  INTEGER REFERENCES users(id),
        created_at  TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hand_raises_quiz ON hand_raises(quiz_id, status);
      CREATE INDEX IF NOT EXISTS idx_hand_raises_attempt ON hand_raises(attempt_id);

      CREATE TABLE IF NOT EXISTS appeals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('grading','integrity')),
        question_id INTEGER,
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
        response    TEXT,
        resolved_by INTEGER REFERENCES users(id),
        resolved_at TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_appeals_attempt ON appeals(attempt_id);
    `,
  },
];

/** Apply pending migrations in order, each in its own transaction. Idempotent. */
export function migrate(): void {
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => Number(r.version),
    ),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    if (m.foreignKeysOff) raw.exec('PRAGMA foreign_keys = OFF;');
    try {
      transaction(() => {
        // Rows that were already orphaned are not this migration's to fix; new ones are fatal.
        const brokenBefore = m.foreignKeysOff ? raw.prepare('PRAGMA foreign_key_check').all().length : 0;
        m.before?.();
        raw.exec(m.sql);
        if (m.foreignKeysOff) {
          const broken = raw.prepare('PRAGMA foreign_key_check').all().length;
          if (broken > brokenBefore) throw new Error(`Migration #${m.version} broke ${broken - brokenBefore} foreign keys.`);
        }
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      });
    } finally {
      if (m.foreignKeysOff) raw.exec('PRAGMA foreign_keys = ON;');
    }
    // Schema changed: cached statements may reference the old shape.
    statements.clear();
    console.log(`[interval-api][migrate] applied #${m.version} ${m.name}`);
  }
}

migrate();
