import { db } from './db.js';
import { nowUtc } from './util.js';
import type { ManualMark } from './services/grading.js';

// ---------------------------------------------------------------- manual marks

export interface ManualGrade {
  id: number;
  attempt_id: number;
  question_id: number;
  marks: number;
  feedback: string;
  graded_by: number | null;
  graded_by_name?: string | null;
  graded_at: string;
}

export const manualGradeRepo = {
  forAttempt(attemptId: number): Map<number, ManualMark> {
    const rows = db
      .prepare('SELECT question_id, marks, feedback FROM manual_grades WHERE attempt_id = ?')
      .all(attemptId) as { question_id: number; marks: number; feedback: string }[];
    return new Map(rows.map((r) => [Number(r.question_id), { marks: Number(r.marks), feedback: String(r.feedback) }]));
  },
  /** attempt id → (question id → marks), for every attempt on a version. */
  forVersion(quizVersionId: number): Map<number, Map<number, ManualMark>> {
    const rows = db
      .prepare(
        `SELECT mg.attempt_id, mg.question_id, mg.marks, mg.feedback FROM manual_grades mg
         JOIN attempts a ON a.id = mg.attempt_id WHERE a.quiz_version_id = ?`,
      )
      .all(quizVersionId) as { attempt_id: number; question_id: number; marks: number; feedback: string }[];
    const out = new Map<number, Map<number, ManualMark>>();
    for (const r of rows) {
      let m = out.get(Number(r.attempt_id));
      if (!m) out.set(Number(r.attempt_id), (m = new Map()));
      m.set(Number(r.question_id), { marks: Number(r.marks), feedback: String(r.feedback) });
    }
    return out;
  },
  listForVersion(quizVersionId: number): ManualGrade[] {
    return db
      .prepare(
        `SELECT mg.*, u.name AS graded_by_name FROM manual_grades mg
         JOIN attempts a ON a.id = mg.attempt_id
         LEFT JOIN users u ON u.id = mg.graded_by
         WHERE a.quiz_version_id = ?`,
      )
      .all(quizVersionId) as unknown as ManualGrade[];
  },
  set(attemptId: number, questionId: number, marks: number, feedback: string, by: number): void {
    db.prepare(
      `INSERT INTO manual_grades (attempt_id, question_id, marks, feedback, graded_by, graded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (attempt_id, question_id)
       DO UPDATE SET marks = excluded.marks, feedback = excluded.feedback,
                     graded_by = excluded.graded_by, graded_at = excluded.graded_at`,
    ).run(attemptId, questionId, marks, feedback, by, nowUtc());
  },
  clear(attemptId: number, questionId: number): void {
    db.prepare('DELETE FROM manual_grades WHERE attempt_id = ? AND question_id = ?').run(attemptId, questionId);
  },
};

// ---------------------------------------------------------------- raise hand

export type HandStatus = 'open' | 'answered' | 'dismissed';

export interface HandRaise {
  id: number;
  quiz_id: number;
  attempt_id: number;
  user_id: number;
  question_id: number | null;
  message: string;
  status: HandStatus;
  reply: string | null;
  broadcast: number;
  replied_by: number | null;
  created_at: string;
  answered_at: string | null;
  student_name?: string;
  student_entry?: string | null;
  replied_by_name?: string | null;
}

export const handRepo = {
  add(quizId: number, attemptId: number, userId: number, questionId: number | null, message: string): number {
    const res = db
      .prepare(
        `INSERT INTO hand_raises (quiz_id, attempt_id, user_id, question_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(quizId, attemptId, userId, questionId, message, nowUtc());
    return Number(res.lastInsertRowid);
  },
  get(id: number): HandRaise | undefined {
    return db.prepare('SELECT * FROM hand_raises WHERE id = ?').get(id) as unknown as HandRaise | undefined;
  },
  forAttempt(attemptId: number): HandRaise[] {
    return db
      .prepare('SELECT * FROM hand_raises WHERE attempt_id = ? ORDER BY id')
      .all(attemptId) as unknown as HandRaise[];
  },
  counts(attemptId: number): { open: number; total: number } {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'open'), 0) AS open FROM hand_raises WHERE attempt_id = ?`,
      )
      .get(attemptId) as { total: number; open: number };
    return { open: Number(row.open), total: Number(row.total) };
  },
  listForQuiz(quizId: number): HandRaise[] {
    return db
      .prepare(
        `SELECT h.*, u.name AS student_name, u.entry_number AS student_entry, r.name AS replied_by_name
         FROM hand_raises h
         JOIN users u ON u.id = h.user_id
         LEFT JOIN users r ON r.id = h.replied_by
         WHERE h.quiz_id = ?
         ORDER BY (h.status = 'open') DESC, h.id DESC
         LIMIT 300`,
      )
      .all(quizId) as unknown as HandRaise[];
  },
  openCountsByQuestion(quizId: number): Map<number, number> {
    const rows = db
      .prepare(
        `SELECT question_id, COUNT(*) AS n FROM hand_raises
         WHERE quiz_id = ? AND question_id IS NOT NULL GROUP BY question_id`,
      )
      .all(quizId) as { question_id: number; n: number }[];
    return new Map(rows.map((r) => [Number(r.question_id), Number(r.n)]));
  },
  resolve(id: number, status: HandStatus, reply: string | null, broadcast: boolean, by: number): void {
    db.prepare(
      `UPDATE hand_raises SET status = ?, reply = ?, broadcast = ?, replied_by = ?, answered_at = ? WHERE id = ?`,
    ).run(status, reply, broadcast ? 1 : 0, by, nowUtc(), id);
  },
};

// ---------------------------------------------------------------- appeals

export type AppealKind = 'grading' | 'integrity';
export type AppealStatus = 'open' | 'accepted' | 'rejected';

export interface Appeal {
  id: number;
  attempt_id: number;
  user_id: number;
  kind: AppealKind;
  question_id: number | null;
  message: string;
  status: AppealStatus;
  response: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  created_at: string;
  student_name?: string;
  student_entry?: string | null;
  resolved_by_name?: string | null;
}

export const appealRepo = {
  add(attemptId: number, userId: number, kind: AppealKind, questionId: number | null, message: string): number {
    const res = db
      .prepare(
        `INSERT INTO appeals (attempt_id, user_id, kind, question_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(attemptId, userId, kind, questionId, message, nowUtc());
    return Number(res.lastInsertRowid);
  },
  get(id: number): Appeal | undefined {
    return db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) as unknown as Appeal | undefined;
  },
  forAttempt(attemptId: number): Appeal[] {
    return db
      .prepare(
        `SELECT ap.*, r.name AS resolved_by_name FROM appeals ap
         LEFT JOIN users r ON r.id = ap.resolved_by
         WHERE ap.attempt_id = ? ORDER BY ap.id`,
      )
      .all(attemptId) as unknown as Appeal[];
  },
  listForVersion(quizVersionId: number): Appeal[] {
    return db
      .prepare(
        `SELECT ap.*, u.name AS student_name, u.entry_number AS student_entry, r.name AS resolved_by_name
         FROM appeals ap
         JOIN attempts a ON a.id = ap.attempt_id
         JOIN users u ON u.id = ap.user_id
         LEFT JOIN users r ON r.id = ap.resolved_by
         WHERE a.quiz_version_id = ?
         ORDER BY (ap.status = 'open') DESC, ap.id DESC`,
      )
      .all(quizVersionId) as unknown as Appeal[];
  },
  openDuplicate(attemptId: number, kind: AppealKind, questionId: number | null): boolean {
    const row = db
      .prepare(
        `SELECT 1 FROM appeals WHERE attempt_id = ? AND kind = ? AND status = 'open'
           AND COALESCE(question_id, 0) = COALESCE(?, 0)`,
      )
      .get(attemptId, kind, questionId);
    return Boolean(row);
  },
  count(attemptId: number): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM appeals WHERE attempt_id = ?').get(attemptId) as { n: number };
    return Number(row.n);
  },
  resolve(id: number, status: AppealStatus, response: string | null, by: number): void {
    db.prepare('UPDATE appeals SET status = ?, response = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(
      status,
      response,
      by,
      nowUtc(),
      id,
    );
  },
};
