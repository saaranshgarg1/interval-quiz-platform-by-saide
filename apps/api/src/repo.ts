import { db } from './db.js';
import {
  type User,
  type PublicUser,
  type Course,
  type CourseRole,
  type Quiz,
  type QuizVersion,
  type Question,
  type QuestionType,
  type Attempt,
  type AttemptStatus,
  type AnswerRevision,
  type PolicyEvent,
  type ReviewDecision,
  type Result,
  type QuizStatus,
  type IntegrityPolicy,
  type PolicyTrigger,
  type ShowScores,
  type QuizType,
  type QuestionBank,
  type BankQuestion,
  type StudentAccommodation,
  type QuizAnalytics,
  type QuestionAnalyticsItem,
  type ScoreBucket,
} from './types.js';
import { jsonParse, nowUtc, makeReceipt, randomToken } from './util.js';
import { isAnswerCorrect } from './services/grading.js';

export type QuestionRow = Omit<Question, 'options' | 'answer'> & {
  options: string | null;
  answer: string;
};

function pubUser(u: User): PublicUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

function mapQuestion(row: Record<string, unknown>): Question {
  return {
    id: Number(row.id),
    quiz_version_id: Number(row.quiz_version_id),
    version: Number(row.version),
    qtype: row.qtype as QuestionType,
    text: String(row.text),
    options: jsonParse<string[]>(row.options as string | null, []),
    answer: row.answer != null ? JSON.parse(String(row.answer)) : null,
    tolerance: row.tolerance == null ? null : Number(row.tolerance),
    points: Number(row.points),
    order_index: Number(row.order_index),
    is_latest: Number(row.is_latest),
    created_at: String(row.created_at),
  };
}

function mapAttempt(row: Record<string, unknown>): Attempt {
  return {
    id: Number(row.id),
    quiz_version_id: Number(row.quiz_version_id),
    user_id: Number(row.user_id),
    status: row.status as AttemptStatus,
    started_at: String(row.started_at),
    expires_at: row.expires_at == null ? null : String(row.expires_at),
    submitted_at: row.submitted_at == null ? null : String(row.submitted_at),
    question_order: String(row.question_order),
    seed: Number(row.seed),
    score: row.score == null ? null : Number(row.score),
    max_score: row.max_score == null ? null : Number(row.max_score),
    graded_at: row.graded_at == null ? null : String(row.graded_at),
    receipt: row.receipt == null ? null : String(row.receipt),
    release_token: row.release_token == null ? null : String(row.release_token),
    submitted_revision: Number(row.submitted_revision),
    created_at: String(row.created_at),
  };
}

// ---------------------------------------------------------------- users

export const userRepo = {
  findByEmail(email: string): User | undefined {
    return db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.trim()) as User | undefined;
  },
  findById(id: number): User | undefined {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  },
  create(name: string, email: string, passwordHash: string, role: User['role']): User {
    const res = db
      .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name.trim(), email.trim(), passwordHash, role);
    const id = Number(res.lastInsertRowid);
    return userRepo.findById(id) as User;
  },
};

// ---------------------------------------------------------------- courses

export const courseRepo = {
  create(code: string, name: string, createdBy: number): { course: Course; version: number } {
    db.exec('BEGIN');
    try {
      const c = db
        .prepare('INSERT INTO courses (code, name, created_by) VALUES (?, ?, ?)')
        .run(code.trim(), name.trim(), createdBy);
      const courseId = Number(c.lastInsertRowid);
      db.prepare(
        'INSERT INTO memberships (course_id, user_id, role) VALUES (?, ?, ?)',
      ).run(courseId, createdBy, 'instructor');
      db.exec('COMMIT');
      const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId) as Course;
      return { course, version: 1 };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
  get(id: number): Course | undefined {
    return db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as Course | undefined;
  },
  /** Courses the user belongs to, ordered by recent activity. */
  listForUser(userId: number): Course[] {
    return db
      .prepare(
        `SELECT c.* FROM courses c
         JOIN memberships m ON m.course_id = c.id
         WHERE m.user_id = ?
         ORDER BY c.created_at DESC`,
      )
      .all(userId) as Course[];
  },
  /** Roster for a course. */
  roster(courseId: number): (CourseRole & PublicUser)[] {
    return db
      .prepare(
        `SELECT m.role, u.id, u.name, u.email, u.role AS account_role, u.created_at AS created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.course_id = ? ORDER BY u.name`,
      )
      .all(courseId) as (CourseRole & PublicUser)[];
  },
  courseRole(courseId: number, userId: number): CourseRole | null {
    const row = db
      .prepare('SELECT role FROM memberships WHERE course_id = ? AND user_id = ?')
      .get(courseId, userId) as { role: CourseRole } | undefined;
    return row ? row.role : null;
  },
  addMember(courseId: number, userId: number, role: CourseRole): void {
    db.prepare(
      'INSERT OR REPLACE INTO memberships (course_id, user_id, role) VALUES (?, ?, ?)',
    ).run(courseId, userId, role);
  },
  removeMember(courseId: number, userId: number): void {
    db.prepare('DELETE FROM memberships WHERE course_id = ? AND user_id = ?').run(
      courseId,
      userId,
    );
  },
  /**
   * Enroll a list of emails as students. Reports which emails had no account.
   * Existing members keep their role (INSERT OR IGNORE). Item 12.
   */
  bulkEnroll(
    courseId: number,
    emails: string[],
    role: CourseRole = 'student',
  ): { enrolled: PublicUser[]; not_found: string[] } {
    const enrolled: PublicUser[] = [];
    const not_found: string[] = [];
    const seen = new Set<string>();
    db.exec('BEGIN');
    try {
      for (const raw of emails) {
        const email = raw.trim();
        if (!email) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const user = userRepo.findByEmail(email);
        if (!user) {
          not_found.push(email);
          continue;
        }
        db.prepare(
          'INSERT OR IGNORE INTO memberships (course_id, user_id, role) VALUES (?, ?, ?)',
        ).run(courseId, user.id, role);
        enrolled.push(pubUser(user));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { enrolled, not_found };
  },
  canManage(courseId: number, userId: number): boolean {
    const role = courseRepo.courseRole(courseId, userId);
    return role === 'instructor' || role === 'ta';
  },
};

// ---------------------------------------------------------------- quizzes

/** Insert a draft quiz_version row copying all content columns from `src`. Must run inside a txn. */
function cloneVersionRow(
  src: QuizVersion,
  quizId: number,
  courseId: number,
  createdBy: number,
  version: number,
): number {
  const res = db
    .prepare(
      `INSERT INTO quiz_versions
         (quiz_id, course_id, created_by, version, status, title, instructions,
          duration_minutes, shuffle_questions, shuffle_options, attempts_allowed,
          integrity_policy, policy_trigger, show_scores,
          quiz_type, window_opens_at, window_duration_minutes)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      quizId,
      courseId,
      createdBy,
      version,
      src.title,
      src.instructions,
      src.duration_minutes,
      src.shuffle_questions,
      src.shuffle_options,
      src.attempts_allowed,
      src.integrity_policy,
      src.policy_trigger,
      src.show_scores,
      src.quiz_type,
      src.window_opens_at,
      src.window_duration_minutes,
    );
  return Number(res.lastInsertRowid);
}

/** Copy every question from one version to another (as v1/latest). Must run inside a txn. */
function copyQuestions(fromVersionId: number, toVersionId: number): void {
  const sourceQuestions = questionRepo.listForVersion(fromVersionId);
  for (const q of sourceQuestions) {
    db.prepare(
      `INSERT INTO questions
         (quiz_version_id, version, qtype, text, options, answer, tolerance, points, order_index)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      toVersionId,
      q.qtype,
      q.text,
      JSON.stringify(q.options),
      q.answer == null ? 'null' : JSON.stringify(q.answer),
      q.tolerance,
      q.points,
      q.order_index,
    );
  }
}

export const quizRepo = {
  get(id: number): Quiz | undefined {
    return db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id) as Quiz | undefined;
  },
  create(courseId: number, createdBy: number): number {
    const res = db
      .prepare('INSERT INTO quizzes (course_id, created_by) VALUES (?, ?)')
      .run(courseId, createdBy);
    return Number(res.lastInsertRowid);
  },
  listForCourse(courseId: number): Quiz[] {
    return db
      .prepare('SELECT * FROM quizzes WHERE course_id = ? ORDER BY id')
      .all(courseId) as Quiz[];
  },
  /**
   * Deep-copy a quiz into a fresh quiz in the same course: a single draft v1
   * carrying the latest version's content. Item 9.
   */
  copy(sourceQuizId: number, createdBy: number): number {
    db.exec('BEGIN');
    try {
      const source = quizRepo.get(sourceQuizId);
      if (!source) throw new Error('quiz not found');
      const src = quizVersionRepo.latest(sourceQuizId);
      if (!src) throw new Error('quiz has no versions');
      const newQuizId = Number(
        db
          .prepare('INSERT INTO quizzes (course_id, created_by) VALUES (?, ?)')
          .run(source.course_id, createdBy).lastInsertRowid,
      );
      const newVersionId = cloneVersionRow(src, newQuizId, source.course_id, createdBy, 1);
      // Keep the copy's title distinct so instructors can tell them apart.
      db.prepare('UPDATE quiz_versions SET title = ? WHERE id = ?').run(
        `${src.title} (copy)`,
        newVersionId,
      );
      copyQuestions(src.id, newVersionId);
      db.exec('COMMIT');
      return newQuizId;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
  /**
   * Delete a quiz and everything hanging off it. attempts have no ON DELETE
   * CASCADE from quiz_versions, so purge them (and their children) explicitly
   * before the version rows go. Item 10.
   */
  delete(quizId: number): void {
    db.exec('BEGIN');
    try {
      const versionIds = (
        db.prepare('SELECT id FROM quiz_versions WHERE quiz_id = ?').all(quizId) as {
          id: number;
        }[]
      ).map((r) => r.id);
      for (const vid of versionIds) {
        // answer_revisions, policy_events, review_decisions, results cascade off attempts.
        db.prepare('DELETE FROM attempts WHERE quiz_version_id = ?').run(vid);
      }
      // quiz_versions + questions cascade off quizzes.
      db.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};

export const quizVersionRepo = {
  get(id: number): QuizVersion | undefined {
    return db.prepare('SELECT * FROM quiz_versions WHERE id = ?').get(id) as QuizVersion | undefined;
  },
  getByVersion(quizId: number, version: number): QuizVersion | undefined {
    return db
      .prepare('SELECT * FROM quiz_versions WHERE quiz_id = ? AND version = ?')
      .get(quizId, version) as QuizVersion | undefined;
  },
  listForQuiz(quizId: number): QuizVersion[] {
    return db
      .prepare('SELECT * FROM quiz_versions WHERE quiz_id = ? ORDER BY version DESC')
      .all(quizId) as QuizVersion[];
  },
  latest(quizId: number): QuizVersion | undefined {
    return db
      .prepare('SELECT * FROM quiz_versions WHERE quiz_id = ? ORDER BY version DESC LIMIT 1')
      .get(quizId) as QuizVersion | undefined;
  },
  latestPublished(quizId: number): QuizVersion | undefined {
    return db
      .prepare(
        `SELECT * FROM quiz_versions WHERE quiz_id = ? AND status = 'published'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(quizId) as QuizVersion | undefined;
  },
  activeVersionForCourse(courseId: number): QuizVersion[] {
    return db
      .prepare(
        `SELECT * FROM quiz_versions WHERE course_id = ? AND status = 'published'
         ORDER BY published_at DESC`,
      )
      .all(courseId) as QuizVersion[];
  },
  createDraft(
    quizId: number,
    courseId: number,
    createdBy: number,
    version: number,
  ): number {
    const res = db
      .prepare(
        `INSERT INTO quiz_versions (quiz_id, course_id, created_by, version, title)
         VALUES (?, ?, ?, ?, 'Untitled quiz')`,
      )
      .run(quizId, courseId, createdBy, version);
    return Number(res.lastInsertRowid);
  },
  clonePublished(quizId: number, createdBy: number): QuizVersion {
    db.exec('BEGIN');
    try {
      const latest = quizVersionRepo.latest(quizId);
      if (!latest) throw new Error('quiz not found');
      const nextVersion = latest.version + 1;
      const newVersionId = cloneVersionRow(latest, quizId, latest.course_id, createdBy, nextVersion);
      copyQuestions(latest.id, newVersionId);
      db.exec('COMMIT');
      return quizVersionRepo.getByVersion(quizId, nextVersion) as QuizVersion;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
  /**
   * Restore a prior version: clone the chosen source version's content into a
   * brand-new draft on top of the stack (never mutates history). Item 6.
   */
  restoreVersion(quizId: number, sourceVersion: number, createdBy: number): QuizVersion {
    db.exec('BEGIN');
    try {
      const src = quizVersionRepo.getByVersion(quizId, sourceVersion);
      if (!src) throw new Error('source version not found');
      const latest = quizVersionRepo.latest(quizId);
      if (!latest) throw new Error('quiz not found');
      const nextVersion = latest.version + 1;
      const newVersionId = cloneVersionRow(src, quizId, src.course_id, createdBy, nextVersion);
      copyQuestions(src.id, newVersionId);
      db.exec('COMMIT');
      return quizVersionRepo.getByVersion(quizId, nextVersion) as QuizVersion;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
  updateMeta(
    id: number,
    meta: Partial<
      Pick<
        QuizVersion,
        | 'title'
        | 'instructions'
        | 'duration_minutes'
        | 'shuffle_questions'
        | 'shuffle_options'
        | 'attempts_allowed'
        | 'integrity_policy'
        | 'policy_trigger'
        | 'show_scores'
        | 'quiz_type'
        | 'window_opens_at'
        | 'window_duration_minutes'
      >
    >,
  ): void {
    // Columns where NULL is a meaningful value the caller may want to persist
    // (clearing a scheduled window / unlimited duration). Everything else keeps
    // the historical "skip null" behaviour.
    const nullable = new Set<keyof typeof meta>([
      'duration_minutes',
      'window_opens_at',
      'window_duration_minutes',
    ]);
    const allowed: (keyof typeof meta)[] = [
      'title',
      'instructions',
      'duration_minutes',
      'shuffle_questions',
      'shuffle_options',
      'attempts_allowed',
      'integrity_policy',
      'policy_trigger',
      'show_scores',
      'quiz_type',
      'window_opens_at',
      'window_duration_minutes',
    ];
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const key of allowed) {
      if (!(key in meta)) continue;
      const value = meta[key];
      if (value === undefined) continue;
      if (value === null && !nullable.has(key)) continue;
      sets.push(`${key} = ?`);
      args.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    args.push(id);
    db.prepare(`UPDATE quiz_versions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  },
  publish(id: number): void {
    db.prepare(
      `UPDATE quiz_versions SET status = 'published', published_at = ? WHERE id = ?`,
    ).run(nowUtc(), id);
  },
  archive(id: number): void {
    db.prepare(
      `UPDATE quiz_versions SET status = 'archived', archived_at = ? WHERE id = ?`,
    ).run(nowUtc(), id);
  },
};

export const questionRepo = {
  listForVersion(quizVersionId: number): Question[] {
    const rows = db
      .prepare('SELECT * FROM questions WHERE quiz_version_id = ? ORDER BY order_index, id')
      .all(quizVersionId) as QuestionRow[];
    return rows.map(mapQuestion);
  },
  get(id: number): Question | undefined {
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | QuestionRow
      | undefined;
    return row ? mapQuestion(row) : undefined;
  },
  create(
    quizVersionId: number,
    data: {
      qtype: QuestionType;
      text: string;
      options?: string[];
      answer: unknown;
      tolerance?: number | null;
      points: number;
    },
  ): Question {
    const next = (db
      .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM questions WHERE quiz_version_id = ?')
      .get(quizVersionId) as { n: number }).n;
    const res = db
      .prepare(
        `INSERT INTO questions
           (quiz_version_id, qtype, text, options, answer, tolerance, points, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quizVersionId,
        data.qtype,
        data.text,
        data.options ? JSON.stringify(data.options) : null,
        data.answer == null ? 'null' : JSON.stringify(data.answer),
        data.tolerance ?? null,
        data.points,
        next,
      );
    return questionRepo.get(Number(res.lastInsertRowid)) as Question;
  },
  update(
    id: number,
    data: Partial<{
      qtype: QuestionType;
      text: string;
      options: string[];
      answer: unknown;
      tolerance: number | null;
      points: number;
    }>,
  ): Question | undefined {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (data.qtype !== undefined) {
      sets.push('qtype = ?');
      args.push(data.qtype);
    }
    if (data.text !== undefined) {
      sets.push('text = ?');
      args.push(data.text);
    }
    if (data.options !== undefined) {
      sets.push('options = ?');
      args.push(JSON.stringify(data.options));
    }
    if (data.answer !== undefined) {
      sets.push('answer = ?');
      args.push(data.answer == null ? 'null' : JSON.stringify(data.answer));
    }
    if (data.tolerance !== undefined) {
      sets.push('tolerance = ?');
      args.push(data.tolerance);
    }
    if (data.points !== undefined) {
      sets.push('points = ?');
      args.push(data.points);
    }
    if (sets.length === 0) return questionRepo.get(id);
    args.push(id);
    db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return questionRepo.get(id);
  },
  remove(id: number): void {
    db.prepare('DELETE FROM questions WHERE id = ?').run(id);
  },
  reorder(quizVersionId: number, ids: number[]): void {
    db.exec('BEGIN');
    try {
      ids.forEach((qid, index) => {
        db.prepare(
          'UPDATE questions SET order_index = ? WHERE id = ? AND quiz_version_id = ?',
        ).run(index, qid, quizVersionId);
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};

// ---------------------------------------------------------------- attempts

export const attemptRepo = {
  create(
    quizVersionId: number,
    userId: number,
    questionOrder: string,
    seed: number,
    expiresAt: string | null,
  ): number {
    const res = db
      .prepare(
        `INSERT INTO attempts (quiz_version_id, user_id, question_order, seed, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(quizVersionId, userId, questionOrder, seed, expiresAt);
    return Number(res.lastInsertRowid);
  },
  get(id: number): Attempt | undefined {
    const row = db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapAttempt(row) : undefined;
  },
  listForUserQuiz(userId: number, quizVersionId: number): Attempt[] {
    const rows = db
      .prepare('SELECT * FROM attempts WHERE user_id = ? AND quiz_version_id = ? ORDER BY id DESC')
      .all(userId, quizVersionId) as Record<string, unknown>[];
    return rows.map(mapAttempt);
  },
  listForVersion(quizVersionId: number): Attempt[] {
    const rows = db
      .prepare('SELECT * FROM attempts WHERE quiz_version_id = ? ORDER BY id DESC')
      .all(quizVersionId) as Record<string, unknown>[];
    return rows.map(mapAttempt);
  },
  updateStatus(id: number, status: AttemptStatus, extra: Partial<Attempt> = {}): void {
    const sets = ['status = ?'];
    const args: (string | number | null)[] = [status];
    if (extra.submitted_at !== undefined) {
      sets.push('submitted_at = ?');
      args.push(extra.submitted_at);
    }
    if (extra.score !== undefined) {
      sets.push('score = ?');
      args.push(extra.score);
    }
    if (extra.max_score !== undefined) {
      sets.push('max_score = ?');
      args.push(extra.max_score);
    }
    if (extra.graded_at !== undefined) {
      sets.push('graded_at = ?');
      args.push(extra.graded_at);
    }
    if (extra.receipt !== undefined) {
      sets.push('receipt = ?');
      args.push(extra.receipt);
    }
    if (extra.release_token !== undefined) {
      sets.push('release_token = ?');
      args.push(extra.release_token);
    }
    if (extra.submitted_revision !== undefined) {
      sets.push('submitted_revision = ?');
      args.push(extra.submitted_revision);
    }
    args.push(id);
    db.prepare(`UPDATE attempts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  },
  setReceipt(id: number, receipt: string, token: string): void {
    db.prepare(
      'UPDATE attempts SET receipt = ?, release_token = ? WHERE id = ?',
    ).run(receipt, token, id);
  },
  usedAttempts(userId: number, quizVersionId: number): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts
         WHERE user_id = ? AND quiz_version_id = ?
           AND status NOT IN ('locked')`,
      )
      .get(userId, quizVersionId) as { n: number };
    return Number(row.n);
  },
};

export const answerRepo = {
  listForAttempt(attemptId: number): AnswerRevision[] {
    return db
      .prepare('SELECT * FROM answer_revisions WHERE attempt_id = ? ORDER BY position')
      .all(attemptId) as AnswerRevision[];
  },
  getForQuestion(attemptId: number, questionId: number): AnswerRevision | undefined {
    return db
      .prepare('SELECT * FROM answer_revisions WHERE attempt_id = ? AND question_id = ?')
      .get(attemptId, questionId) as AnswerRevision | undefined;
  },
  /**
   * Idempotent acknowledged save. Only accepts a revision newer than what the
   * server already holds; returns the acknowledged revision number.
   */
  save(
    attemptId: number,
    questionId: number,
    position: number,
    answerJson: string,
    revision: number,
  ): { acknowledged: boolean; revision: number; saved_at: string } {
    const existing = answerRepo.getForQuestion(attemptId, questionId);
    const savedAt = nowUtc();
    if (!existing) {
      db.prepare(
        `INSERT INTO answer_revisions (attempt_id, question_id, position, answer, revision, saved_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'saved')`,
      ).run(attemptId, questionId, position, answerJson, revision, savedAt);
      return { acknowledged: true, revision, saved_at: savedAt };
    }
    if (revision <= existing.revision) {
      return {
        acknowledged: true,
        revision: existing.revision,
        saved_at: existing.saved_at,
      };
    }
    db.prepare(
      `UPDATE answer_revisions SET answer = ?, revision = ?, saved_at = ?, status = 'saved'
       WHERE attempt_id = ? AND question_id = ?`,
    ).run(answerJson, revision, savedAt, attemptId, questionId);
    return { acknowledged: true, revision, saved_at: savedAt };
  },
  markSubmitted(attemptId: number): void {
    db.prepare(
      `UPDATE answer_revisions SET status = 'submitted' WHERE attempt_id = ?`,
    ).run(attemptId);
  },
};

// ---------------------------------------------------------------- policy + review

export const policyRepo = {
  log(attemptId: number, kind: string, detail: string | null, source: string): number {
    const res = db
      .prepare(
        `INSERT INTO policy_events (attempt_id, kind, detail, recorded_at, source)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(attemptId, kind, detail, nowUtc(), source);
    return Number(res.lastInsertRowid);
  },
  listForAttempt(attemptId: number): PolicyEvent[] {
    return db
      .prepare('SELECT * FROM policy_events WHERE attempt_id = ? ORDER BY id')
      .all(attemptId) as PolicyEvent[];
  },
  touchRevocation(attemptId: number, kind: string, detail: string): number {
    return policyRepo.log(attemptId, kind, detail, 'server');
  },
};

export const reviewRepo = {
  add(attemptId: number, decidedBy: number, decision: string, reason: string | null): number {
    const res = db
      .prepare(
        `INSERT INTO review_decisions (attempt_id, decided_by, decision, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(attemptId, decidedBy, decision, reason, nowUtc());
    return Number(res.lastInsertRowid);
  },
  listForAttempt(attemptId: number): ReviewDecision[] {
    return db
      .prepare(
        `SELECT rd.*, u.name AS decided_by_name, u.email AS decided_by_email
         FROM review_decisions rd JOIN users u ON u.id = rd.decided_by
         WHERE rd.attempt_id = ? ORDER BY rd.id`,
      )
      .all(attemptId) as ReviewDecision[];
  },
};

// ---------------------------------------------------------------- results

export const resultRepo = {
  upsert(
    attemptId: number,
    quizVersionId: number,
    userId: number,
    score: number,
    maxScore: number,
  ): Result {
    db.exec('BEGIN');
    try {
      const existing = db
        .prepare('SELECT * FROM results WHERE attempt_id = ?')
        .get(attemptId) as Result | undefined;
      if (existing) {
        db.prepare(
          'UPDATE results SET score = ?, max_score = ?, graded_at = ? WHERE attempt_id = ?',
        ).run(score, maxScore, nowUtc(), attemptId);
        const updated = db
          .prepare('SELECT * FROM results WHERE attempt_id = ?')
          .get(attemptId) as Result;
        db.exec('COMMIT');
        return updated;
      }
      const res = db
        .prepare(
          `INSERT INTO results (attempt_id, quiz_version_id, user_id, score, max_score, graded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(attemptId, quizVersionId, userId, score, maxScore, nowUtc());
      db.exec('COMMIT');
      return db
        .prepare('SELECT * FROM results WHERE id = ?')
        .get(Number(res.lastInsertRowid)) as Result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
  getByAttempt(attemptId: number): Result | undefined {
    return db
      .prepare('SELECT * FROM results WHERE attempt_id = ?')
      .get(attemptId) as Result | undefined;
  },
  listForUser(userId: number): Result[] {
    return db
      .prepare(
        `SELECT r.*, qv.title AS quiz_title, qv.version, c.code AS course_code, c.name AS course_name,
                a.submitted_at
         FROM results r
         JOIN quiz_versions qv ON qv.id = r.quiz_version_id
         JOIN courses c ON c.id = qv.course_id
         JOIN attempts a ON a.id = r.attempt_id
         WHERE r.user_id = ? AND r.released = 1
         ORDER BY r.released_at DESC`,
      )
      .all(userId) as (Result & Record<string, unknown>)[];
  },
  listForVersion(quizVersionId: number): Result[] {
    return db
      .prepare('SELECT * FROM results WHERE quiz_version_id = ?')
      .all(quizVersionId) as Result[];
  },
  releaseByAttempt(attemptId: number): void {
    db.prepare(
      `UPDATE results SET released = 1, released_at = ? WHERE attempt_id = ?`,
    ).run(nowUtc(), attemptId);
  },
  releaseAllForVersion(quizVersionId: number, answerKey = false): number {
    const res = db
      .prepare(
        `UPDATE results SET released = 1, released_at = ?, answer_key_released = ?
         WHERE quiz_version_id = ?`,
      )
      .run(nowUtc(), answerKey ? 1 : 0, quizVersionId);
    return Number(res.changes);
  },
  setKeyReleased(attemptId: number, on: number): void {
    db.prepare(
      'UPDATE results SET answer_key_released = ? WHERE attempt_id = ?',
    ).run(on, attemptId);
  },
};

// ---------------------------------------------------------------- banks

function mapBankQuestion(row: Record<string, unknown>): BankQuestion {
  return {
    id: Number(row.id),
    bank_id: Number(row.bank_id),
    qtype: row.qtype as QuestionType,
    text: String(row.text),
    options: jsonParse<string[]>(row.options as string | null, []),
    answer: jsonParse<unknown>(row.answer as string, ''),
    tolerance: row.tolerance != null ? Number(row.tolerance) : null,
    points: Number(row.points ?? 1),
    tags: jsonParse<string[]>(row.tags as string | null, []),
    created_at: String(row.created_at),
  };
}

export const bankRepo = {
  listForCourse(courseId: number): (QuestionBank & { question_count: number })[] {
    return db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM bank_questions bq WHERE bq.bank_id = b.id) as question_count
         FROM question_banks b
         WHERE b.course_id = ?
         ORDER BY b.id DESC`,
      )
      .all(courseId) as (QuestionBank & { question_count: number })[];
  },
  get(id: number): QuestionBank | undefined {
    return db.prepare('SELECT * FROM question_banks WHERE id = ?').get(id) as
      | QuestionBank
      | undefined;
  },
  create(courseId: number, createdBy: number, name: string, description: string): QuestionBank {
    const res = db
      .prepare(
        `INSERT INTO question_banks (course_id, created_by, name, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(courseId, createdBy, name, description, nowUtc());
    return db
      .prepare('SELECT * FROM question_banks WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as QuestionBank;
  },
  delete(id: number): void {
    db.prepare('DELETE FROM question_banks WHERE id = ?').run(id);
  },
  listQuestions(bankId: number): BankQuestion[] {
    const rows = db
      .prepare('SELECT * FROM bank_questions WHERE bank_id = ? ORDER BY id ASC')
      .all(bankId) as Record<string, unknown>[];
    return rows.map(mapBankQuestion);
  },
  addQuestion(
    bankId: number,
    q: {
      qtype: QuestionType;
      text: string;
      options?: string[];
      answer: unknown;
      tolerance?: number | null;
      points?: number;
      tags?: string[];
    },
  ): BankQuestion {
    const res = db
      .prepare(
        `INSERT INTO bank_questions (bank_id, qtype, text, options, answer, tolerance, points, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bankId,
        q.qtype,
        q.text,
        JSON.stringify(q.options ?? []),
        JSON.stringify(q.answer),
        q.tolerance ?? null,
        q.points ?? 1,
        JSON.stringify(q.tags ?? []),
        nowUtc(),
      );
    const row = db
      .prepare('SELECT * FROM bank_questions WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
    return mapBankQuestion(row);
  },
  deleteQuestion(id: number): void {
    db.prepare('DELETE FROM bank_questions WHERE id = ?').run(id);
  },
};

// ---------------------------------------------------------------- accommodations

export const accommodationRepo = {
  listForCourse(courseId: number): StudentAccommodation[] {
    return db
      .prepare(
        `SELECT sa.*, u.name AS user_name, u.email AS user_email
         FROM student_accommodations sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.course_id = ?
         ORDER BY u.name ASC`,
      )
      .all(courseId) as StudentAccommodation[];
  },
  get(courseId: number, userId: number): StudentAccommodation | undefined {
    return db
      .prepare(
        `SELECT sa.*, u.name AS user_name, u.email AS user_email
         FROM student_accommodations sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.course_id = ? AND sa.user_id = ?`,
      )
      .get(courseId, userId) as StudentAccommodation | undefined;
  },
  upsert(
    courseId: number,
    userId: number,
    timeMultiplier: number,
    extraMinutes: number,
    notes: string,
  ): StudentAccommodation {
    db.prepare(
      `INSERT INTO student_accommodations (course_id, user_id, time_multiplier, extra_minutes, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(course_id, user_id) DO UPDATE SET
         time_multiplier = excluded.time_multiplier,
         extra_minutes = excluded.extra_minutes,
         notes = excluded.notes`,
    ).run(courseId, userId, timeMultiplier, extraMinutes, notes, nowUtc());
    return this.get(courseId, userId)!;
  },
  delete(courseId: number, userId: number): void {
    db.prepare(
      'DELETE FROM student_accommodations WHERE course_id = ? AND user_id = ?',
    ).run(courseId, userId);
  },
};

// ---------------------------------------------------------------- analytics

export const analyticsRepo = {
  getQuizAnalytics(quizVersionId: number): QuizAnalytics {
    const version = db
      .prepare('SELECT * FROM quiz_versions WHERE id = ?')
      .get(quizVersionId) as QuizVersion | undefined;
    if (!version) {
      throw new Error(`Quiz version ${quizVersionId} not found`);
    }

    const attempts = db
      .prepare('SELECT * FROM attempts WHERE quiz_version_id = ?')
      .all(quizVersionId) as Attempt[];

    const submitted = attempts.filter((a) => a.status === 'submitted');
    const locked = attempts.filter((a) => a.status === 'locked' || a.status === 'under_review');
    const expired = attempts.filter((a) => a.status === 'expired');

    const scores = submitted
      .map((a) => a.score)
      .filter((s): s is number => s !== null && s !== undefined);

    let meanScore = 0;
    let medianScore = 0;
    let highestScore = 0;
    let lowestScore = 0;
    let maxScore = submitted[0]?.max_score ?? 0;

    if (scores.length > 0) {
      scores.sort((a, b) => a - b);
      meanScore = Math.round((scores.reduce((sum, s) => sum + s, 0) / scores.length) * 100) / 100;
      highestScore = scores[scores.length - 1] ?? 0;
      lowestScore = scores[0] ?? 0;
      const mid = Math.floor(scores.length / 2);
      const midVal = scores[mid] ?? 0;
      const midPrev = scores[mid - 1] ?? 0;
      medianScore =
        scores.length % 2 !== 0
          ? midVal
          : Math.round(((midPrev + midVal) / 2) * 100) / 100;
    }

    const buckets: ScoreBucket[] = [
      { range: '0-20%', count: 0 },
      { range: '21-40%', count: 0 },
      { range: '41-60%', count: 0 },
      { range: '61-80%', count: 0 },
      { range: '81-100%', count: 0 },
    ];

    const b0 = buckets[0]!;
    const b1 = buckets[1]!;
    const b2 = buckets[2]!;
    const b3 = buckets[3]!;
    const b4 = buckets[4]!;

    for (const s of scores) {
      const pct = maxScore > 0 ? (s / maxScore) * 100 : 0;
      if (pct <= 20) b0.count++;
      else if (pct <= 40) b1.count++;
      else if (pct <= 60) b2.count++;
      else if (pct <= 80) b3.count++;
      else b4.count++;
    }

    const questionRows = db
      .prepare('SELECT * FROM questions WHERE quiz_version_id = ? ORDER BY order_index ASC')
      .all(quizVersionId) as Record<string, unknown>[];
    const questions = questionRows.map(mapQuestion);

    const n = submitted.length;
    const cut = Math.max(1, Math.round(n * 0.27));
    const sortedAttempts = [...submitted].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const topGroup = sortedAttempts.slice(0, cut);
    const bottomGroup = sortedAttempts.slice(Math.max(0, n - cut));

    const questionAnalytics: QuestionAnalyticsItem[] = [];

    for (const q of questions) {
      let totalAnswers = 0;
      let correctAnswers = 0;

      for (const att of submitted) {
        const rev = db
          .prepare('SELECT answer FROM answer_revisions WHERE attempt_id = ? AND question_id = ?')
          .get(att.id, q.id) as { answer: string } | undefined;
        if (rev) {
          totalAnswers++;
          const val = jsonParse<unknown>(rev.answer, null);
          if (isAnswerCorrect(q, val)) {
            correctAnswers++;
          }
        }
      }

      let topCorrect = 0;
      for (const att of topGroup) {
        const rev = db
          .prepare('SELECT answer FROM answer_revisions WHERE attempt_id = ? AND question_id = ?')
          .get(att.id, q.id) as { answer: string } | undefined;
        if (rev && isAnswerCorrect(q, jsonParse<unknown>(rev.answer, null))) {
          topCorrect++;
        }
      }

      let bottomCorrect = 0;
      for (const att of bottomGroup) {
        const rev = db
          .prepare('SELECT answer FROM answer_revisions WHERE attempt_id = ? AND question_id = ?')
          .get(att.id, q.id) as { answer: string } | undefined;
        if (rev && isAnswerCorrect(q, jsonParse<unknown>(rev.answer, null))) {
          bottomCorrect++;
        }
      }

      const topAcc = topGroup.length > 0 ? topCorrect / topGroup.length : 0;
      const bottomAcc = bottomGroup.length > 0 ? bottomCorrect / bottomGroup.length : 0;
      const discrimination = Math.round((topAcc - bottomAcc) * 100) / 100;
      const accuracyRate =
        totalAnswers > 0 ? Math.round((correctAnswers / totalAnswers) * 100) / 100 : 0;

      questionAnalytics.push({
        question_id: q.id,
        order_index: q.order_index,
        text: q.text,
        qtype: q.qtype,
        points: q.points,
        total_answers: totalAnswers,
        correct_answers: correctAnswers,
        accuracy_rate: accuracyRate,
        discrimination_index: discrimination,
      });
    }

    const attemptRows = db
      .prepare(
        `SELECT a.*, u.name AS user_name, u.email AS user_email
         FROM attempts a
         JOIN users u ON u.id = a.user_id
         WHERE a.quiz_version_id = ?
         ORDER BY a.submitted_at DESC, a.id DESC`,
      )
      .all(quizVersionId) as (Attempt & { user_name: string; user_email: string })[];

    const submissions = attemptRows.map((a) => ({
      attempt_id: a.id,
      user_id: a.user_id,
      user_name: a.user_name,
      user_email: a.user_email,
      status: a.status,
      score: a.score,
      max_score: a.max_score,
      started_at: a.started_at,
      submitted_at: a.submitted_at,
      receipt: a.receipt,
    }));

    return {
      quiz_id: version.quiz_id,
      quiz_version_id: version.id,
      title: version.title,
      total_attempts: attempts.length,
      submitted_count: submitted.length,
      locked_count: locked.length,
      expired_count: expired.length,
      mean_score: meanScore,
      median_score: medianScore,
      max_score: maxScore,
      highest_score: highestScore,
      lowest_score: lowestScore,
      score_buckets: buckets,
      question_analytics: questionAnalytics,
      submissions,
    };
  },
};

export { pubUser, mapQuestion, mapAttempt, makeReceipt, randomToken };
export type { QuizStatus, IntegrityPolicy, PolicyTrigger, ShowScores };