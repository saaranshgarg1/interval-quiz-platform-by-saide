import { Router } from 'express';
import { requireAuth, AppError, type AuthedRequest } from '../auth.js';
import { courseRepo, quizVersionRepo, analyticsRepo } from '../repo.js';
import { assertStaff } from '../authz.js';

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

// Get detailed analytics for a quiz version
analyticsRouter.get('/version/:versionId', (req: AuthedRequest, res) => {
  const versionId = Number(req.params.versionId);
  const version = quizVersionRepo.get(versionId);
  if (!version) throw new AppError(404, 'Quiz version not found.');

  assertStaff(req, version.course_id);

  const analytics = analyticsRepo.getQuizAnalytics(versionId);
  res.json({ analytics });
});
