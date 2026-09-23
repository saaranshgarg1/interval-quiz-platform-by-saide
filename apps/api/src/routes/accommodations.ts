import { Router } from 'express';
import { requireAuth, AppError, type AuthedRequest } from '../auth.js';
import { courseRepo, accommodationRepo } from '../repo.js';

export const accommodationsRouter = Router();

accommodationsRouter.use(requireAuth);

function requireStaff(req: AuthedRequest, courseId: number) {
  const userId = req.userId as number;
  if (req.userRole === 'admin') return;
  const role = courseRepo.courseRole(courseId, userId);
  if (role !== 'instructor' && role !== 'ta') {
    throw new AppError(403, 'Only instructors and TAs can manage student accommodations.');
  }
}

// List all accommodations for a course
accommodationsRouter.get('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  requireStaff(req, courseId);
  const accommodations = accommodationRepo.listForCourse(courseId);
  res.json({ accommodations });
});

// Get current user's accommodation in a course (for student timer disclosure)
accommodationsRouter.get('/course/:courseId/my', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const userId = req.userId as number;
  const accommodation = accommodationRepo.get(courseId, userId);
  res.json({ accommodation: accommodation ?? null });
});

// Set or update a student accommodation
accommodationsRouter.post('/course/:courseId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  requireStaff(req, courseId);

  const { user_id, time_multiplier, extra_minutes, notes } = req.body ?? {};
  const targetUserId = Number(user_id);
  if (!targetUserId || isNaN(targetUserId)) {
    throw new AppError(400, 'Valid user_id is required.');
  }

  const multiplier = Number(time_multiplier) || 1.0;
  const extra = Number(extra_minutes) || 0;
  const accommodation = accommodationRepo.upsert(
    courseId,
    targetUserId,
    multiplier,
    extra,
    notes ? String(notes).trim() : '',
  );

  res.json({ accommodation });
});

// Delete a student accommodation
accommodationsRouter.delete('/course/:courseId/user/:userId', (req: AuthedRequest, res) => {
  const courseId = Number(req.params.courseId);
  const targetUserId = Number(req.params.userId);
  requireStaff(req, courseId);

  accommodationRepo.delete(courseId, targetUserId);
  res.json({ ok: true });
});
