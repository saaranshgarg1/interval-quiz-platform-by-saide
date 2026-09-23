import { DatabaseSync } from 'node:sqlite';
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

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function migrate() {
  db.exec(`
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
  `);
}

migrate();