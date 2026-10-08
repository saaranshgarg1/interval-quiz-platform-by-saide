import { db } from './db.js';
import { nowUtc } from './util.js';

/**
 * Live-exam records: time extensions and announcements. Kept apart from the
 * content repos because they describe what happened *during* an exam, not the
 * exam itself. They hang off the quiz (not a version) so students still on an
 * older published version are covered too.
 */

export interface TimeExtension {
  id: number;
  quiz_id: number;
  user_id: number | null;
  seconds: number;
  applies_to_new: number;
  kind: 'extension' | 'pause';
  reason: string | null;
  created_by: number | null;
  created_at: string;
  user_name?: string | null;
  user_entry_number?: string | null;
  created_by_name?: string | null;
}

export const extensionRepo = {
  add(e: {
    quiz_id: number;
    user_id: number | null;
    seconds: number;
    applies_to_new: boolean;
    kind: 'extension' | 'pause';
    reason: string | null;
    created_by: number | null;
  }): number {
    const res = db
      .prepare(
        `INSERT INTO time_extensions (quiz_id, user_id, seconds, applies_to_new, kind, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.quiz_id, e.user_id, e.seconds, e.applies_to_new ? 1 : 0, e.kind, e.reason, e.created_by, nowUtc());
    return Number(res.lastInsertRowid);
  },
  /**
   * Seconds that apply to one student.
   *   window:     every extension and pause (they all push the window close back)
   *   newAttempt: extensions flagged to lengthen attempts started afterwards
   */
  totals(quizId: number, userId: number): { window: number; newAttempt: number } {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(seconds), 0) AS window_seconds,
                COALESCE(SUM(CASE WHEN applies_to_new = 1 AND kind = 'extension' THEN seconds ELSE 0 END), 0) AS new_seconds
         FROM time_extensions
         WHERE quiz_id = ? AND (user_id IS NULL OR user_id = ?)`,
      )
      .get(quizId, userId) as { window_seconds: number; new_seconds: number };
    return { window: Number(row.window_seconds), newAttempt: Number(row.new_seconds) };
  },
  /** Extensions that apply to everyone (the class-wide window close). */
  globalSeconds(quizId: number): number {
    const row = db
      .prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM time_extensions WHERE quiz_id = ? AND user_id IS NULL')
      .get(quizId) as { s: number };
    return Number(row.s);
  },
  listForQuiz(quizId: number): TimeExtension[] {
    return db
      .prepare(
        `SELECT te.*, u.name AS user_name, u.entry_number AS user_entry_number, c.name AS created_by_name
         FROM time_extensions te
         LEFT JOIN users u ON u.id = te.user_id
         LEFT JOIN users c ON c.id = te.created_by
         WHERE te.quiz_id = ? ORDER BY te.id DESC`,
      )
      .all(quizId) as TimeExtension[];
  },
};

export interface Announcement {
  id: number;
  quiz_id: number;
  user_id: number | null;
  /** Clarification pinned to one question (shown only to students who were given it). */
  question_id: number | null;
  message: string;
  created_by: number | null;
  created_at: string;
  created_by_name?: string | null;
  user_name?: string | null;
}

export const announcementRepo = {
  add(quizId: number, userId: number | null, message: string, createdBy: number | null, questionId: number | null = null): number {
    const res = db
      .prepare(
        'INSERT INTO announcements (quiz_id, user_id, message, created_by, created_at, question_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(quizId, userId, message, createdBy, nowUtc(), questionId);
    return Number(res.lastInsertRowid);
  },
  /** What a student should see: broadcasts plus messages addressed to them. */
  forStudent(quizId: number, userId: number, afterId = 0): Announcement[] {
    return db
      .prepare(
        `SELECT id, quiz_id, user_id, question_id, message, created_at FROM announcements
         WHERE quiz_id = ? AND (user_id IS NULL OR user_id = ?) AND id > ?
         ORDER BY id`,
      )
      .all(quizId, userId, afterId) as Announcement[];
  },
  listForQuiz(quizId: number): Announcement[] {
    return db
      .prepare(
        `SELECT a.*, c.name AS created_by_name, u.name AS user_name
         FROM announcements a
         LEFT JOIN users c ON c.id = a.created_by
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.quiz_id = ? ORDER BY a.id DESC`,
      )
      .all(quizId) as Announcement[];
  },
};
