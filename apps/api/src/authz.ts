import type { Response, NextFunction } from 'express';
import { db } from './db.js';
import { AppError } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { courseRepo } from './repo.js';
import type { CourseRole } from './types.js';

/**
 * Authorization core. Every course-scoped handler resolves the protected
 * resource to its owning course, then calls one of these guards. Deny-by-default:
 * a caller with no matching membership is rejected with 403.
 *
 * Global `admin` bypasses course membership entirely and is treated as an
 * instructor on every course.
 */

/** Assert the caller holds one of `allowed` course roles. Returns the effective role. */
export function assertCourseRole(
  req: AuthedRequest,
  courseId: number,
  ...allowed: CourseRole[]
): CourseRole {
  if (req.userRole === 'admin') {
    req.courseRole = 'instructor';
    return 'instructor';
  }
  const role = courseRepo.courseRole(courseId, req.userId as number);
  if (!role || !allowed.includes(role)) {
    throw new AppError(403, 'You do not have permission for this action.');
  }
  req.courseRole = role;
  return role;
}

/** Any enrolled member (student | ta | instructor) or admin. */
export function assertMember(req: AuthedRequest, courseId: number): CourseRole {
  return assertCourseRole(req, courseId, 'student', 'ta', 'instructor');
}

/** Course staff: ta | instructor (or admin). Drafting, grading, monitoring. */
export function assertStaff(req: AuthedRequest, courseId: number): CourseRole {
  return assertCourseRole(req, courseId, 'ta', 'instructor');
}

/** Instructor-only (or admin). Publish, release, delete, roster, rulings. */
export function assertInstructor(req: AuthedRequest, courseId: number): CourseRole {
  return assertCourseRole(req, courseId, 'instructor');
}

export interface AuditEntry {
  action: string;
  course_id?: number | null;
  target?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Append an immutable audit row for a privileged mutation. Never throws to the caller path. */
export function writeAudit(req: AuthedRequest, entry: AuditEntry): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor_id, actor_role, course_id, action, target, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      (req.userId as number | undefined) ?? null,
      req.userRole ?? null,
      entry.course_id ?? null,
      entry.action,
      entry.target ?? null,
      entry.before != null ? JSON.stringify(entry.before) : null,
      entry.after != null ? JSON.stringify(entry.after) : null,
    );
  } catch (e) {
    console.error('[interval-api][audit] failed to record', entry.action, e);
  }
}

/**
 * Express middleware form for routes whose courseId is a direct route param.
 * Prefer the assert* helpers inside handlers that must first load a resource.
 */
export function requireCourseRole(param: string, ...allowed: CourseRole[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    const courseId = Number(req.params[param]);
    if (!Number.isInteger(courseId)) throw new AppError(400, 'Invalid course id.');
    assertCourseRole(req, courseId, ...allowed);
    next();
  };
}
