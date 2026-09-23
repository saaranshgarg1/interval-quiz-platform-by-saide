import { Router } from 'express';
import { requireAuth, AppError, type AuthedRequest } from '../auth.js';
import { courseRepo, quizVersionRepo, analyticsRepo } from '../repo.js';

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

// Get detailed analytics for a quiz version
analyticsRouter.get('/version/:versionId', (req: AuthedRequest, res) => {
  const versionId = Number(req.params.versionId);
  const version = quizVersionRepo.get(versionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');

  const userId = req.userId as number;
  if (req.userRole !== 'admin') {
    const role = courseRepo.courseRole(version.course_id, userId);
    if (role !== 'instructor' && role !== 'ta') {
      throw new AppError(403, 'Only instructors and TAs can view quiz analytics.');
    }
  }

  const analytics = analyticsRepo.getQuizAnalytics(versionId);
  res.json({ analytics });
});
