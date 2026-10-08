import { db, transaction } from './db.js';
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
  type Difficulty,
  type QuestionSlot,
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
  return { id: u.id, name: u.name, email: u.email, role: u.role, entry_number: u.entry_number ?? null };
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
    time_limit_seconds: row.time_limit_seconds == null ? null : Number(row.time_limit_seconds),
    slot_id: row.slot_id == null ? null : Number(row.slot_id),
    bank_question_id: row.bank_question_id == null ? null : Number(row.bank_question_id),
    allow_assumptions: Number(row.allow_assumptions ?? 0),
    grading_mode: (row.grading_mode as Question['grading_mode']) ?? 'normal',
    accept_also: jsonParse<unknown[]>(row.accept_also as string | null, []),
    bonus: Number(row.bonus ?? 0),
    created_at: String(row.created_at),
  };
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

function mapAttempt(row: Record<string, unknown>): Attempt {
  return {
    id: Number(row.id),
    quiz_version_id: Number(row.quiz_version_id),
    user_id: Number(row.user_id),
    status: row.status as AttemptStatus,
    started_at: String(row.started_at),
    expires_at: str(row.expires_at),
    submitted_at: str(row.submitted_at),
    question_order: String(row.question_order),
    seed: Number(row.seed),
    score: row.score == null ? null : Number(row.score),
    max_score: row.max_score == null ? null : Number(row.max_score),
    graded_at: str(row.graded_at),
    receipt: str(row.receipt),
    release_token: str(row.release_token),
    submitted_revision: Number(row.submitted_revision),
    created_at: String(row.created_at),
    session_hash: str(row.session_hash),
    session_started_at: str(row.session_started_at),
    session_left_at: str(row.session_left_at),
    reentry_allowed: Number(row.reentry_allowed ?? 0),
    resume_count: Number(row.resume_count ?? 0),
    last_seen_at: str(row.last_seen_at),
    start_ip: str(row.start_ip),
    last_ip: str(row.last_ip),
    user_agent: str(row.user_agent),
    violation_count: Number(row.violation_count ?? 0),
    last_violation_at: str(row.last_violation_at),
    current_index: Number(row.current_index ?? 0),
    question_started_at: str(row.question_started_at),
    question_expires_at: str(row.question_expires_at),
    extra_seconds: Number(row.extra_seconds ?? 0),
    lock_reason: str(row.lock_reason),
    finalize_reason: str(row.finalize_reason),
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
  findByEntryNumber(entry: string): User | undefined {
    return db
      .prepare('SELECT * FROM users WHERE entry_number = ? COLLATE NOCASE')
      .get(entry.trim()) as User | undefined;
  },
  create(
    name: string,
    email: string,
    passwordHash: string,
    role: User['role'],
    entryNumber: string | null = null,
  ): User {
    const res = db
      .prepare('INSERT INTO users (name, email, password_hash, role, entry_number) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), email.trim(), passwordHash, role, entryNumber);
    const id = Number(res.lastInsertRowid);
    return userRepo.findById(id) as User;
  },
  setEntryNumber(id: number, entry: string | null): void {
    db.prepare('UPDATE users SET entry_number = ? WHERE id = ?').run(entry, id);
  },
  tokenVersion(id: number): number | null {
    const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(id) as
      | { token_version: number }
      | undefined;
    return row ? Number(row.token_version) : null;
  },
  /** Invalidate every token issued to this user. */
  bumpTokenVersion(id: number): number {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
    return userRepo.tokenVersion(id) ?? 0;
  },
};

// ---------------------------------------------------------------- courses

export type RosterRow = Omit<PublicUser, 'role'> & {
  /** Course role (what the roster UI shows). */
  role: CourseRole;
  course_role: CourseRole;
  account_role: User['role'];
  created_at: string;
};

export const courseRepo = {
  create(code: string, name: string, createdBy: number): { course: Course; version: number } {
    return transaction(() => {
      const c = db
        .prepare('INSERT INTO courses (code, name, created_by) VALUES (?, ?, ?)')
        .run(code.trim(), name.trim(), createdBy);
      const courseId = Number(c.lastInsertRowid);
      db.prepare(
        'INSERT INTO memberships (course_id, user_id, role) VALUES (?, ?, ?)',
      ).run(courseId, createdBy, 'instructor');
      const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId) as Course;
      return { course, version: 1 };
    });
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
  /** Roster for a course. `role` is the course role (kept for existing clients). */
  roster(courseId: number): RosterRow[] {
    return db
      .prepare(
        `SELECT m.role, m.role AS course_role, u.id, u.name, u.email, u.entry_number,
                u.role AS account_role, u.created_at AS created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.course_id = ? ORDER BY u.name`,
      )
      .all(courseId) as RosterRow[];
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
   * Enroll a list of people. Each entry is an email, optionally with an entry
   * number and name. Existing accounts are enrolled now (keeping any existing
   * role); unknown emails become pending enrollments that are claimed when the
   * person first registers or signs in with SSO.
   */
  bulkEnroll(
    courseId: number,
    entries: (string | { email: string; entry_number?: string | null; name?: string | null })[],
    role: CourseRole = 'student',
    createdBy: number | null = null,
  ): { enrolled: PublicUser[]; not_found: string[]; pending: string[] } {
    const enrolled: PublicUser[] = [];
    const not_found: string[] = [];
    const seen = new Set<string>();
    transaction(() => {
      for (const rawEntry of entries) {
        const entry = typeof rawEntry === 'string' ? { email: rawEntry } : rawEntry;
        const email = entry.email.trim();
        if (!email) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const user = userRepo.findByEmail(email);
        if (!user) {
          not_found.push(email);
          db.prepare(
            `INSERT INTO pending_enrollments (course_id, email, role, entry_number, name, created_by)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(course_id, email) DO UPDATE SET
               role = excluded.role,
               entry_number = COALESCE(excluded.entry_number, pending_enrollments.entry_number),
               name = COALESCE(excluded.name, pending_enrollments.name)`,
          ).run(courseId, email, role, entry.entry_number ?? null, entry.name ?? null, createdBy);
          continue;
        }
        db.prepare(
          'INSERT OR IGNORE INTO memberships (course_id, user_id, role) VALUES (?, ?, ?)',
        ).run(courseId, user.id, role);
        if (entry.entry_number && !user.entry_number && !userRepo.findByEntryNumber(entry.entry_number)) {
          userRepo.setEntryNumber(user.id, entry.entry_number);
          user.entry_number = entry.entry_number;
        }
        enrolled.push(pubUser(user));
      }
    });
    return { enrolled, not_found, pending: not_found };
  },
  canManage(courseId: number, userId: number): boolean {
    const role = courseRepo.courseRole(courseId, userId);
    return role === 'instructor' || role === 'ta';
  },
};

export interface PendingEnrollment {
  id: number;
  course_id: number;
  email: string;
  role: CourseRole;
  entry_number: string | null;
  name: string | null;
  created_at: string;
}

export const pendingEnrollmentRepo = {
  listForCourse(courseId: number): PendingEnrollment[] {
    return db
      .prepare('SELECT * FROM pending_enrollments WHERE course_id = ? ORDER BY email')
      .all(courseId) as PendingEnrollment[];
  },
  remove(courseId: number, id: number): void {
    db.prepare('DELETE FROM pending_enrollments WHERE course_id = ? AND id = ?').run(courseId, id);
  },
  /** Turn every pending invitation for this email into a real membership. */
  claim(user: User): { courses: number; entry_number: string | null } {
    return transaction(() => {
      const rows = db
        .prepare('SELECT * FROM pending_enrollments WHERE email = ?')
        .all(user.email) as PendingEnrollment[];
      let entry: string | null = null;
      for (const row of rows) {
        db.prepare('INSERT OR IGNORE INTO memberships (course_id, user_id, role) VALUES (?, ?, ?)').run(
          row.course_id,
          user.id,
          row.role,
        );
        entry ??= row.entry_number;
      }
      db.prepare('DELETE FROM pending_enrollments WHERE email = ?').run(user.email);
      if (entry && !user.entry_number && !userRepo.findByEntryNumber(entry)) {
        userRepo.setEntryNumber(user.id, entry);
      } else {
        entry = null;
      }
      return { courses: rows.length, entry_number: entry };
    });
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
          quiz_type, window_opens_at, window_duration_minutes, exam_settings)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      src.exam_settings ?? '{}',
    );
  return Number(res.lastInsertRowid);
}

/**
 * Copy the authored content of one version to another (as v1/latest): its
 * questions and its random-question slots. Questions drawn for students are not
 * copied: the new version draws its own. Must run inside a txn.
 */
function copyQuestions(fromVersionId: number, toVersionId: number): void {
  for (const slot of slotRepo.listForVersion(fromVersionId)) {
    db.prepare(
      `INSERT INTO question_slots (quiz_version_id, bank_id, difficulty, tag, points, time_limit_seconds, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(toVersionId, slot.bank_id, slot.difficulty, slot.tag, slot.points, slot.time_limit_seconds, slot.order_index);
  }
  const sourceQuestions = questionRepo.listAuthored(fromVersionId);
  for (const q of sourceQuestions) {
    db.prepare(
      `INSERT INTO questions
         (quiz_version_id, version, qtype, text, options, answer, tolerance, points, order_index, time_limit_seconds,
          allow_assumptions)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      toVersionId,
      q.qtype,
      q.text,
      JSON.stringify(q.options),
      q.answer == null ? 'null' : JSON.stringify(q.answer),
      q.tolerance,
      q.points,
      q.order_index,
      q.time_limit_seconds,
      q.allow_assumptions,
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
  setPaused(id: number, pausedAt: string | null): void {
    db.prepare('UPDATE quizzes SET paused_at = ? WHERE id = ?').run(pausedAt, id);
  },
  setClosed(id: number, closedAt: string | null): void {
    db.prepare('UPDATE quizzes SET closed_at = ? WHERE id = ?').run(closedAt, id);
  },
  /**
   * Deep-copy a quiz into a fresh quiz in the same course: a single draft v1
   * carrying the latest version's content. Item 9.
   */
  copy(sourceQuizId: number, createdBy: number): number {
    return transaction(() => {
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
      return newQuizId;
    });
  },
  /**
   * Delete a quiz and everything hanging off it. attempts have no ON DELETE
   * CASCADE from quiz_versions, so purge them (and their children) explicitly
   * before the version rows go. Item 10.
   */
  delete(quizId: number): void {
    transaction(() => {
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
    });
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
    return transaction(() => {
      const latest = quizVersionRepo.latest(quizId);
      if (!latest) throw new Error('quiz not found');
      const nextVersion = latest.version + 1;
      const newVersionId = cloneVersionRow(latest, quizId, latest.course_id, createdBy, nextVersion);
      copyQuestions(latest.id, newVersionId);
      return quizVersionRepo.getByVersion(quizId, nextVersion) as QuizVersion;
    });
  },
  /**
   * Restore a prior version: clone the chosen source version's content into a
   * brand-new draft on top of the stack (never mutates history). Item 6.
   */
  restoreVersion(quizId: number, sourceVersion: number, createdBy: number): QuizVersion {
    return transaction(() => {
      const src = quizVersionRepo.getByVersion(quizId, sourceVersion);
      if (!src) throw new Error('source version not found');
      const latest = quizVersionRepo.latest(quizId);
      if (!latest) throw new Error('quiz not found');
      const nextVersion = latest.version + 1;
      const newVersionId = cloneVersionRow(src, quizId, src.course_id, createdBy, nextVersion);
      copyQuestions(src.id, newVersionId);
      return quizVersionRepo.getByVersion(quizId, nextVersion) as QuizVersion;
    });
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
        | 'exam_settings'
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
      'exam_settings',
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

export interface QuestionInput {
  qtype: QuestionType;
  text: string;
  options?: string[];
  answer: unknown;
  tolerance?: number | null;
  points: number;
  time_limit_seconds?: number | null;
  allow_assumptions?: boolean;
}

export const questionRepo = {
  /** Every question row: authored ones and those drawn for students from banks. */
  listForVersion(quizVersionId: number): Question[] {
    const rows = db
      .prepare('SELECT * FROM questions WHERE quiz_version_id = ? ORDER BY order_index, id')
      .all(quizVersionId) as QuestionRow[];
    return rows.map(mapQuestion);
  },
  /** Questions the instructor wrote (or imported): what the editor shows. */
  listAuthored(quizVersionId: number): Question[] {
    const rows = db
      .prepare('SELECT * FROM questions WHERE quiz_version_id = ? AND slot_id IS NULL ORDER BY order_index, id')
      .all(quizVersionId) as QuestionRow[];
    return rows.map(mapQuestion);
  },
  /** Items on each student's paper: authored questions plus random slots. */
  countForVersion(quizVersionId: number): number {
    const row = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM questions WHERE quiz_version_id = ? AND slot_id IS NULL)
              + (SELECT COUNT(*) FROM question_slots WHERE quiz_version_id = ?) AS n`,
      )
      .get(quizVersionId, quizVersionId) as { n: number };
    return Number(row.n);
  },
  /** Next free position, shared by questions and slots. */
  nextOrderIndex(quizVersionId: number): number {
    const row = db
      .prepare(
        `SELECT MAX(
           COALESCE((SELECT MAX(order_index) FROM questions WHERE quiz_version_id = ? AND slot_id IS NULL), -1),
           COALESCE((SELECT MAX(order_index) FROM question_slots WHERE quiz_version_id = ?), -1)) + 1 AS n`,
      )
      .get(quizVersionId, quizVersionId) as { n: number };
    return Number(row.n);
  },
  get(id: number): Question | undefined {
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | QuestionRow
      | undefined;
    return row ? mapQuestion(row) : undefined;
  },
  create(quizVersionId: number, data: QuestionInput): Question {
    const next = questionRepo.nextOrderIndex(quizVersionId);
    const res = db
      .prepare(
        `INSERT INTO questions
           (quiz_version_id, qtype, text, options, answer, tolerance, points, order_index, time_limit_seconds,
            allow_assumptions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.time_limit_seconds ?? null,
        data.allow_assumptions ? 1 : 0,
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
      time_limit_seconds: number | null;
      allow_assumptions: boolean;
      grading_mode: Question['grading_mode'];
      accept_also: unknown[];
      bonus: number;
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
    if (data.time_limit_seconds !== undefined) {
      sets.push('time_limit_seconds = ?');
      args.push(data.time_limit_seconds);
    }
    if (data.allow_assumptions !== undefined) {
      sets.push('allow_assumptions = ?');
      args.push(data.allow_assumptions ? 1 : 0);
    }
    if (data.grading_mode !== undefined) {
      sets.push('grading_mode = ?');
      args.push(data.grading_mode);
    }
    if (data.accept_also !== undefined) {
      sets.push('accept_also = ?');
      args.push(data.accept_also.length ? JSON.stringify(data.accept_also) : null);
    }
    if (data.bonus !== undefined) {
      sets.push('bonus = ?');
      args.push(data.bonus);
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
    transaction(() => {
      ids.forEach((qid, index) => {
        db.prepare(
          'UPDATE questions SET order_index = ? WHERE id = ? AND quiz_version_id = ?',
        ).run(index, qid, quizVersionId);
      });
    });
  },
};

// ---------------------------------------------------------------- attempts

/** Attempt columns services may patch; keys are interpolated, so they are whitelisted. */
const ATTEMPT_PATCHABLE = new Set<keyof Attempt>([
  'status',
  'expires_at',
  'submitted_at',
  'score',
  'max_score',
  'graded_at',
  'receipt',
  'release_token',
  'submitted_revision',
  'session_hash',
  'session_started_at',
  'session_left_at',
  'reentry_allowed',
  'resume_count',
  'last_seen_at',
  'last_ip',
  'user_agent',
  'violation_count',
  'last_violation_at',
  'current_index',
  'question_started_at',
  'question_expires_at',
  'extra_seconds',
  'lock_reason',
  'finalize_reason',
]);

export interface NewAttempt {
  quiz_version_id: number;
  user_id: number;
  question_order: string;
  seed: number;
  expires_at: string | null;
  started_at?: string;
  session_hash?: string | null;
  start_ip?: string | null;
  user_agent?: string | null;
  question_expires_at?: string | null;
}

export const attemptRepo = {
  create(
    quizVersionId: number,
    userId: number,
    questionOrder: string,
    seed: number,
    expiresAt: string | null,
  ): number {
    return attemptRepo.insert({
      quiz_version_id: quizVersionId,
      user_id: userId,
      question_order: questionOrder,
      seed,
      expires_at: expiresAt,
    });
  },
  insert(a: NewAttempt): number {
    const now = a.started_at ?? nowUtc();
    const res = db
      .prepare(
        `INSERT INTO attempts
           (quiz_version_id, user_id, question_order, seed, expires_at, started_at,
            session_hash, session_started_at, last_seen_at, start_ip, last_ip, user_agent,
            question_started_at, question_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.quiz_version_id,
        a.user_id,
        a.question_order,
        a.seed,
        a.expires_at,
        now,
        a.session_hash ?? null,
        a.session_hash ? now : null,
        a.session_hash ? now : null,
        a.start_ip ?? null,
        a.start_ip ?? null,
        a.user_agent ?? null,
        a.question_expires_at ? now : null,
        a.question_expires_at ?? null,
      );
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
  /** Every attempt the user made on any version of a quiz (newest first). */
  listForUserAcrossQuiz(userId: number, quizId: number): Attempt[] {
    const rows = db
      .prepare(
        `SELECT a.* FROM attempts a
         JOIN quiz_versions qv ON qv.id = a.quiz_version_id
         WHERE a.user_id = ? AND qv.quiz_id = ?
         ORDER BY a.id DESC`,
      )
      .all(userId, quizId) as Record<string, unknown>[];
    return rows.map(mapAttempt);
  },
  listForVersion(quizVersionId: number): Attempt[] {
    const rows = db
      .prepare('SELECT * FROM attempts WHERE quiz_version_id = ? ORDER BY id DESC')
      .all(quizVersionId) as Record<string, unknown>[];
    return rows.map(mapAttempt);
  },
  listByStatus(quizVersionId: number, statuses: AttemptStatus[]): Attempt[] {
    const marks = statuses.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT * FROM attempts WHERE quiz_version_id = ? AND status IN (${marks}) ORDER BY id`)
      .all(quizVersionId, ...statuses) as Record<string, unknown>[];
    return rows.map(mapAttempt);
  },
  patch(id: number, fields: Partial<Attempt>): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (!ATTEMPT_PATCHABLE.has(key as keyof Attempt)) throw new Error(`attempt column ${key} is not patchable`);
      sets.push(`${key} = ?`);
      args.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    args.push(id);
    db.prepare(`UPDATE attempts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  },
  updateStatus(id: number, status: AttemptStatus, extra: Partial<Attempt> = {}): void {
    attemptRepo.patch(id, { ...extra, status });
  },
  setReceipt(id: number, receipt: string, token: string): void {
    db.prepare(
      'UPDATE attempts SET receipt = ?, release_token = ? WHERE id = ?',
    ).run(receipt, token, id);
  },
  /**
   * Attempts used on a quiz, across all of its versions. Locked attempts count:
   * a locked student must not be able to sidestep review by starting afresh, and
   * publishing a corrected v2 must not hand everyone a new attempt.
   */
  usedAttempts(userId: number, quizVersionId: number): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts a
         JOIN quiz_versions qv ON qv.id = a.quiz_version_id
         WHERE a.user_id = ?
           AND qv.quiz_id = (SELECT quiz_id FROM quiz_versions WHERE id = ?)`,
      )
      .get(userId, quizVersionId) as { n: number };
    return Number(row.n);
  },
};

export interface AnswerHistoryRow {
  question_id: number;
  answer: string;
  revision: number;
  saved_at: string;
  assumption: string | null;
}

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
   * server already holds; returns the acknowledged revision number. Every
   * accepted revision is also appended to answer_history for dispute review.
   */
  save(
    attemptId: number,
    questionId: number,
    position: number,
    answerJson: string,
    revision: number,
    assumption: string | null = null,
  ): { acknowledged: boolean; revision: number; saved_at: string } {
    const existing = answerRepo.getForQuestion(attemptId, questionId);
    const savedAt = nowUtc();
    if (existing && revision <= existing.revision) {
      return {
        acknowledged: true,
        revision: existing.revision,
        saved_at: existing.saved_at,
      };
    }
    if (!existing) {
      db.prepare(
        `INSERT INTO answer_revisions (attempt_id, question_id, position, answer, revision, saved_at, status, assumption)
         VALUES (?, ?, ?, ?, ?, ?, 'saved', ?)`,
      ).run(attemptId, questionId, position, answerJson, revision, savedAt, assumption);
    } else {
      db.prepare(
        `UPDATE answer_revisions SET answer = ?, revision = ?, saved_at = ?, status = 'saved', assumption = ?
         WHERE attempt_id = ? AND question_id = ?`,
      ).run(answerJson, revision, savedAt, assumption, attemptId, questionId);
    }
    db.prepare(
      'INSERT INTO answer_history (attempt_id, question_id, answer, revision, saved_at, assumption) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(attemptId, questionId, answerJson, revision, savedAt, assumption);
    return { acknowledged: true, revision, saved_at: savedAt };
  },
  markSubmitted(attemptId: number): void {
    db.prepare(
      `UPDATE answer_revisions SET status = 'submitted' WHERE attempt_id = ?`,
    ).run(attemptId);
  },
  markSaved(attemptId: number): void {
    db.prepare(`UPDATE answer_revisions SET status = 'saved' WHERE attempt_id = ?`).run(attemptId);
  },
  history(attemptId: number): AnswerHistoryRow[] {
    return db
      .prepare('SELECT question_id, answer, revision, saved_at, assumption FROM answer_history WHERE attempt_id = ? ORDER BY id')
      .all(attemptId) as unknown as AnswerHistoryRow[];
  },
  /** Final answers of every attempt on a version (one query for analysis). */
  listForVersion(quizVersionId: number): AnswerRevision[] {
    return db
      .prepare(
        `SELECT ar.* FROM answer_revisions ar JOIN attempts a ON a.id = ar.attempt_id
         WHERE a.quiz_version_id = ?`,
      )
      .all(quizVersionId) as unknown as AnswerRevision[];
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
  /** Events for an attempt, optionally only those from one source ('client' = browser-reported). */
  countForAttempt(attemptId: number, source?: string): number {
    const row = (source
      ? db.prepare('SELECT COUNT(*) AS n FROM policy_events WHERE attempt_id = ? AND source = ?').get(attemptId, source)
      : db.prepare('SELECT COUNT(*) AS n FROM policy_events WHERE attempt_id = ?').get(attemptId)) as { n: number };
    return Number(row.n);
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
    pendingManual = 0,
  ): Result {
    return transaction(() => {
      const existing = db
        .prepare('SELECT * FROM results WHERE attempt_id = ?')
        .get(attemptId) as Result | undefined;
      if (existing) {
        db.prepare(
          'UPDATE results SET score = ?, max_score = ?, pending_manual = ?, graded_at = ? WHERE attempt_id = ?',
        ).run(score, maxScore, pendingManual, nowUtc(), attemptId);
        return db
          .prepare('SELECT * FROM results WHERE attempt_id = ?')
          .get(attemptId) as Result;
      }
      const res = db
        .prepare(
          `INSERT INTO results (attempt_id, quiz_version_id, user_id, score, max_score, pending_manual, graded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(attemptId, quizVersionId, userId, score, maxScore, pendingManual, nowUtc());
      return db
        .prepare('SELECT * FROM results WHERE id = ?')
        .get(Number(res.lastInsertRowid)) as Result;
    });
  },
  getByAttempt(attemptId: number): Result | undefined {
    return db
      .prepare('SELECT * FROM results WHERE attempt_id = ?')
      .get(attemptId) as Result | undefined;
  },
  removeForAttempt(attemptId: number): void {
    db.prepare('DELETE FROM results WHERE attempt_id = ?').run(attemptId);
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
         WHERE r.user_id = ? AND r.released = 1 AND r.pending_manual = 0
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
    difficulty: (row.difficulty as Difficulty) ?? 'medium',
    allow_assumptions: Number(row.allow_assumptions ?? 0),
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
      difficulty?: Difficulty;
      allow_assumptions?: boolean;
    },
  ): BankQuestion {
    const res = db
      .prepare(
        `INSERT INTO bank_questions
           (bank_id, qtype, text, options, answer, tolerance, points, tags, difficulty, created_at, allow_assumptions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        q.difficulty ?? 'medium',
        nowUtc(),
        q.allow_assumptions ? 1 : 0,
      );
    const row = db
      .prepare('SELECT * FROM bank_questions WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
    return mapBankQuestion(row);
  },
  deleteQuestion(id: number): void {
    db.prepare('DELETE FROM bank_questions WHERE id = ?').run(id);
  },
  getQuestion(id: number): BankQuestion | undefined {
    const row = db.prepare('SELECT * FROM bank_questions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapBankQuestion(row) : undefined;
  },
  setDifficulty(id: number, difficulty: Difficulty): void {
    db.prepare('UPDATE bank_questions SET difficulty = ? WHERE id = ?').run(difficulty, id);
  },
  /** Bank questions a random slot may draw: same difficulty (if set) and tag (if set). */
  pool(bankId: number, difficulty: Difficulty | null, tag: string | null): BankQuestion[] {
    return bankRepo
      .listQuestions(bankId)
      .filter(
        (q) =>
          (!difficulty || q.difficulty === difficulty) &&
          (!tag || q.tags.some((t) => t.toLowerCase() === tag.toLowerCase())),
      );
  },
  /** Quizzes (not archived) whose random slots draw from this bank. */
  usedBy(bankId: number): { quiz_id: number; title: string; status: string }[] {
    return db
      .prepare(
        `SELECT DISTINCT qv.quiz_id, qv.title, qv.status FROM question_slots s
         JOIN quiz_versions qv ON qv.id = s.quiz_version_id
         WHERE s.bank_id = ? AND qv.status != 'archived'`,
      )
      .all(bankId) as { quiz_id: number; title: string; status: string }[];
  },
};

// ---------------------------------------------------------------- random slots

function mapSlot(row: Record<string, unknown>): QuestionSlot {
  return {
    id: Number(row.id),
    quiz_version_id: Number(row.quiz_version_id),
    bank_id: Number(row.bank_id),
    difficulty: (row.difficulty as Difficulty | null) ?? null,
    tag: row.tag == null ? null : String(row.tag),
    points: Number(row.points),
    time_limit_seconds: row.time_limit_seconds == null ? null : Number(row.time_limit_seconds),
    order_index: Number(row.order_index),
    created_at: String(row.created_at),
  };
}

export const slotRepo = {
  listForVersion(quizVersionId: number): QuestionSlot[] {
    return (db
      .prepare('SELECT * FROM question_slots WHERE quiz_version_id = ? ORDER BY order_index, id')
      .all(quizVersionId) as Record<string, unknown>[]).map(mapSlot);
  },
  get(id: number): QuestionSlot | undefined {
    const row = db.prepare('SELECT * FROM question_slots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapSlot(row) : undefined;
  },
  create(
    quizVersionId: number,
    s: { bank_id: number; difficulty: Difficulty | null; tag: string | null; points: number; time_limit_seconds: number | null },
  ): QuestionSlot {
    const res = db
      .prepare(
        `INSERT INTO question_slots (quiz_version_id, bank_id, difficulty, tag, points, time_limit_seconds, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(quizVersionId, s.bank_id, s.difficulty, s.tag, s.points, s.time_limit_seconds, questionRepo.nextOrderIndex(quizVersionId));
    return slotRepo.get(Number(res.lastInsertRowid)) as QuestionSlot;
  },
  remove(id: number): void {
    db.prepare('DELETE FROM question_slots WHERE id = ?').run(id);
  },
  /**
   * The question row for `bankQuestion` drawn into `slot`: created on the first
   * draw (a copy, so later bank edits never change a paper) and reused by every
   * later student who draws it. Bumps its draw counter.
   */
  materialize(slot: QuestionSlot, bankQuestion: BankQuestion): number {
    const existing = db
      .prepare('SELECT id FROM questions WHERE slot_id = ? AND bank_question_id = ?')
      .get(slot.id, bankQuestion.id) as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE questions SET draw_count = draw_count + 1 WHERE id = ?').run(existing.id);
      return Number(existing.id);
    }
    const res = db
      .prepare(
        `INSERT INTO questions
           (quiz_version_id, qtype, text, options, answer, tolerance, points, order_index, time_limit_seconds,
            slot_id, bank_question_id, draw_count, allow_assumptions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        slot.quiz_version_id,
        bankQuestion.qtype,
        bankQuestion.text,
        JSON.stringify(bankQuestion.options ?? []),
        bankQuestion.answer == null ? 'null' : JSON.stringify(bankQuestion.answer),
        bankQuestion.tolerance,
        slot.points,
        slot.order_index,
        slot.time_limit_seconds,
        slot.id,
        bankQuestion.id,
        bankQuestion.allow_assumptions,
      );
    return Number(res.lastInsertRowid);
  },
  /**
   * How often each bank question has been handed out on this quiz version, over
   * all its slots, so the whole class sees the pool evenly (not just per slot).
   */
  drawCounts(quizVersionId: number): Map<number, number> {
    const rows = db
      .prepare(
        `SELECT bank_question_id, SUM(draw_count) AS n FROM questions
         WHERE quiz_version_id = ? AND slot_id IS NOT NULL GROUP BY bank_question_id`,
      )
      .all(quizVersionId) as { bank_question_id: number; n: number }[];
    return new Map(rows.map((r) => [Number(r.bank_question_id), Number(r.n)]));
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

/** Graded statuses: time-expired attempts are auto-submitted and graded, so they count. */
const GRADED_STATUSES = new Set(['submitted', 'expired']);

export const analyticsRepo = {
  getQuizAnalytics(quizVersionId: number): QuizAnalytics {
    const version = db
      .prepare('SELECT * FROM quiz_versions WHERE id = ?')
      .get(quizVersionId) as QuizVersion | undefined;
    if (!version) {
      throw new Error(`Quiz version ${quizVersionId} not found`);
    }

    const attempts = (db
      .prepare('SELECT * FROM attempts WHERE quiz_version_id = ?')
      .all(quizVersionId) as Record<string, unknown>[]).map(mapAttempt);

    const graded = attempts.filter((a) => GRADED_STATUSES.has(a.status) && a.score != null);
    const submitted = attempts.filter((a) => a.status === 'submitted');
    const locked = attempts.filter((a) => a.status === 'locked' || a.status === 'under_review');
    const expired = attempts.filter((a) => a.status === 'expired');

    const scores = graded.map((a) => a.score as number);

    let meanScore = 0;
    let medianScore = 0;
    let highestScore = 0;
    let lowestScore = 0;
    const maxScore = graded[0]?.max_score ?? 0;

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
    for (const a of graded) {
      const max = a.max_score ?? maxScore;
      const pct = max > 0 ? ((a.score as number) / max) * 100 : 0;
      const idx = pct <= 20 ? 0 : pct <= 40 ? 1 : pct <= 60 ? 2 : pct <= 80 ? 3 : 4;
      buckets[idx]!.count++;
    }

    const questions = (db
      .prepare('SELECT * FROM questions WHERE quiz_version_id = ? ORDER BY order_index ASC')
      .all(quizVersionId) as Record<string, unknown>[]).map(mapQuestion);

    // One pass over every saved answer for the version instead of a query per (question × attempt).
    const answersByAttempt = new Map<number, Map<number, unknown>>();
    const answerRows = db
      .prepare(
        `SELECT ar.attempt_id, ar.question_id, ar.answer
         FROM answer_revisions ar JOIN attempts a ON a.id = ar.attempt_id
         WHERE a.quiz_version_id = ?`,
      )
      .all(quizVersionId) as { attempt_id: number; question_id: number; answer: string }[];
    for (const row of answerRows) {
      let m = answersByAttempt.get(Number(row.attempt_id));
      if (!m) answersByAttempt.set(Number(row.attempt_id), (m = new Map()));
      m.set(Number(row.question_id), jsonParse<unknown>(row.answer, null));
    }

    const n = graded.length;
    const cut = Math.max(1, Math.round(n * 0.27));
    const sortedAttempts = [...graded].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const topGroup = sortedAttempts.slice(0, cut);
    const bottomGroup = sortedAttempts.slice(Math.max(0, n - cut));

    const correctIn = (group: Attempt[], q: Question) =>
      group.filter((att) => {
        const m = answersByAttempt.get(att.id);
        return m?.has(q.id) && isAnswerCorrect(q, m.get(q.id));
      }).length;

    const questionAnalytics: QuestionAnalyticsItem[] = questions.map((q) => {
      let totalAnswers = 0;
      let correctAnswers = 0;
      for (const att of graded) {
        const m = answersByAttempt.get(att.id);
        if (!m?.has(q.id)) continue;
        // Only questions this student was actually given count (random draws).
        totalAnswers++;
        if (isAnswerCorrect(q, m.get(q.id))) correctAnswers++;
      }
      const topAcc = topGroup.length > 0 ? correctIn(topGroup, q) / topGroup.length : 0;
      const bottomAcc = bottomGroup.length > 0 ? correctIn(bottomGroup, q) / bottomGroup.length : 0;
      return {
        question_id: q.id,
        order_index: q.order_index,
        text: q.text,
        qtype: q.qtype,
        points: q.points,
        total_answers: totalAnswers,
        correct_answers: correctAnswers,
        accuracy_rate: totalAnswers > 0 ? Math.round((correctAnswers / totalAnswers) * 100) / 100 : 0,
        discrimination_index: Math.round((topAcc - bottomAcc) * 100) / 100,
      };
    });

    const attemptRows = db
      .prepare(
        `SELECT a.*, u.name AS user_name, u.email AS user_email, u.entry_number AS user_entry_number
         FROM attempts a
         JOIN users u ON u.id = a.user_id
         WHERE a.quiz_version_id = ?
         ORDER BY a.submitted_at DESC, a.id DESC`,
      )
      .all(quizVersionId) as (Record<string, unknown> & { user_name: string; user_email: string; user_entry_number: string | null })[];

    const submissions = attemptRows.map((row) => {
      const a = mapAttempt(row);
      return {
        attempt_id: a.id,
        user_id: a.user_id,
        user_name: row.user_name,
        user_email: row.user_email,
        entry_number: row.user_entry_number ?? null,
        status: a.status,
        score: a.score,
        max_score: a.max_score,
        started_at: a.started_at,
        submitted_at: a.submitted_at,
        receipt: a.receipt,
        violation_count: a.violation_count,
        finalize_reason: a.finalize_reason,
      };
    });

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
export type { QuizStatus, IntegrityPolicy, PolicyTrigger, ShowScores, QuizType };
