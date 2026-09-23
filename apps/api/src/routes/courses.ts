import { Router } from 'express';
import { requireAuth, AppError } from '../auth.js';
import { db } from '../db.js';
import { courseRepo, userRepo, pubUser } from '../repo.js';
import type { Course } from '../types.js';
import type { AuthedRequest } from '../auth.js';

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

function staffOnly(role: string): void {
  if (role !== 'instructor' && role !== 'ta' && role !== 'admin') {
    throw new AppError(403, 'Only course staff can do this.');
  }
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
  const { code, name } = req.body ?? {};
  if (!code || !name) throw new AppError(400, 'Course code and name are required.');
  const { course, version } = courseRepo.create(String(code), String(name), req.userId as number);
  res.status(201).json({ course, version });
});

coursesRouter.get('/:courseId', (req: AuthedRequest, res) => {
  const { course, role } = withCourseRole(req, Number(req.params.courseId));
  res.json({ course, role, roster: courseRepo.roster(course.id) });
});

coursesRouter.put('/:courseId/members', (req: AuthedRequest, res) => {
  const { course, role } = withCourseRole(req, Number(req.params.courseId));
  staffOnly(role);
  const { email, memberRole } = req.body ?? {};
  const desiredRole = memberRole === 'ta' || memberRole === 'instructor' || memberRole === 'student'
    ? memberRole
    : 'student';
  const user = email ? userRepo.findByEmail(String(email)) : undefined;
  if (!user) throw new AppError(404, 'No account exists for that email.');
  if (user.id === req.userId) throw new AppError(400, 'You are already a member of this course.');
  courseRepo.addMember(course.id, user.id, desiredRole);
  res.json({ ok: true, member: { ...pubUser(user), role: desiredRole } });
});

coursesRouter.delete('/:courseId/members/:userId', (req: AuthedRequest, res) => {
  const { course, role } = withCourseRole(req, Number(req.params.courseId));
  staffOnly(role);
  const targetId = Number(req.params.userId);
  if (targetId === req.userId) throw new AppError(400, 'You cannot remove yourself.');
  const target = userRepo.findById(targetId);
  if (!target) throw new AppError(404, 'User not found.');
  courseRepo.removeMember(course.id, targetId);
  res.json({ ok: true });
});

coursesRouter.get('/:courseId/roster', (req: AuthedRequest, res) => {
  const { course, role } = withCourseRole(req, Number(req.params.courseId));
  void role;
  res.json({ roster: courseRepo.roster(course.id) });
});