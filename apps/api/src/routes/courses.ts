import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import { db } from '../db.js';
import { courseRepo, userRepo, pubUser } from '../repo.js';
import type { Course } from '../types.js';
import type { AuthedRequest } from '../auth.js';
import { assertInstructor, assertStaff, writeAudit } from '../authz.js';

export const coursesRouter = Router();

coursesRouter.use(requireAuth);

/** Resolve a course and return the viewer's role in it. */
function withCourseRole(req: AuthedRequest, courseId: number) {
  const course = courseRepo.get(courseId);
  if (!course) throw new AppError(404, 'Course not found.');
  const userId = req.userId as number;
  const role = courseRepo.courseRole(courseId, userId);
  if (!role) {
    // Admins may inspect any course.
    if (req.userRole === 'admin') return { course, role: 'admin' as const, isAdmin: true };
    throw new AppError(403, 'You are not enrolled in this course.');
  }
  return { course, role, isAdmin: false };
}

coursesRouter.get('/', (req: AuthedRequest, res) => {
  const userId = req.userId as number;
  if (req.userRole === 'admin') {
    const all = db
      .prepare('SELECT * FROM courses ORDER BY created_at DESC')
      .all() as Course[];
    res.json({ courses: all.map((c) => ({ ...c, my_role: 'admin' })) });
    return;
  }
  const courses = courseRepo.listForUser(userId).map((c) => ({
    ...c,
    my_role: courseRepo.courseRole(c.id, userId),
  }));
  res.json({ courses });
});

coursesRouter.post('/', (req: AuthedRequest, res) => {
  if (req.userRole !== 'instructor' && req.userRole !== 'admin') {
    throw new AppError(403, 'Only instructors can create courses.');
  }
  const { code, name } = req.body ?? {};
  if (!code || !name) throw new AppError(400, 'Course code and name are required.');
  const { course, version } = courseRepo.create(String(code), String(name), req.userId as number);
  writeAudit(req, { action: 'course.create', course_id: course.id, target: 'course:' + course.id, after: { code, name } });
  res.status(201).json({ course, version });
});

coursesRouter.get('/:courseId', (req: AuthedRequest, res) => {
  const { course, role } = withCourseRole(req, Number(req.params.courseId));
  // Roster exposes member PII — staff/admin only, matching GET /:courseId/roster.
  const isStaff = role === 'ta' || role === 'instructor' || role === 'admin';
  res.json({ course, role, roster: isStaff ? courseRepo.roster(course.id) : [] });
});

coursesRouter.put('/:courseId/members', (req: AuthedRequest, res) => {
  const { course } = withCourseRole(req, Number(req.params.courseId));
  assertInstructor(req, course.id);
  const { email, memberRole } = req.body ?? {};
  const desiredRole = memberRole === 'ta' || memberRole === 'instructor' || memberRole === 'student'
    ? memberRole
    : 'student';
  const user = email ? userRepo.findByEmail(String(email)) : undefined;
  if (!user) throw new AppError(404, 'No account exists for that email.');
  if (user.id === req.userId) throw new AppError(400, 'You are already a member of this course.');
  courseRepo.addMember(course.id, user.id, desiredRole);
  writeAudit(req, { action: 'course.member.set', course_id: course.id, target: 'user:' + user.id, after: desiredRole });
  res.json({ ok: true, member: { ...pubUser(user), role: desiredRole } });
});

coursesRouter.delete('/:courseId/members/:userId', (req: AuthedRequest, res) => {
  const { course } = withCourseRole(req, Number(req.params.courseId));
  assertInstructor(req, course.id);
  const targetId = Number(req.params.userId);
  if (targetId === req.userId) throw new AppError(400, 'You cannot remove yourself.');
  const target = userRepo.findById(targetId);
  if (!target) throw new AppError(404, 'User not found.');
  const targetCourseRole = courseRepo.courseRole(course.id, targetId);
  if (targetCourseRole === 'instructor') {
    const instructorCount = courseRepo.roster(course.id).filter((r) => r.role === 'instructor').length;
    if (instructorCount <= 1) throw new AppError(400, 'Cannot remove the last instructor.');
  }
  courseRepo.removeMember(course.id, targetId);
  writeAudit(req, { action: 'course.member.remove', course_id: course.id, target: 'user:' + targetId });
  res.json({ ok: true });
});

coursesRouter.get('/:courseId/roster', (req: AuthedRequest, res) => {
  const { course } = withCourseRole(req, Number(req.params.courseId));
  assertStaff(req, course.id);
  res.json({ roster: courseRepo.roster(course.id) });
});