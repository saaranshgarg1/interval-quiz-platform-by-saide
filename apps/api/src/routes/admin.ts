import { Router } from 'express';
import { requireAuth, requireRoles, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { db } from '../db.js';
import { userRepo, pubUser } from '../repo.js';
import { writeAudit } from '../authz.js';
import type { Role } from '../types.js';

export const adminRouter = Router();

// Platform superuser surface. Global role check only — not course-scoped.
adminRouter.use(requireAuth, requireRoles('admin'));

/** List every account. */
adminRouter.get('/users', (_req: AuthedRequest, res) => {
  const users = db
    .prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC')
    .all();
  res.json({ users });
});

/** Set a user's global role — the only way to mint an instructor or admin. */
adminRouter.patch('/users/:id/role', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { role } = (req.body ?? {}) as { role?: Role };
  if (role !== 'student' && role !== 'instructor' && role !== 'admin') {
    throw new AppError(400, "role must be 'student', 'instructor' or 'admin'.");
  }
  const user = userRepo.findById(id);
  if (!user) throw new AppError(404, 'User not found.');
  if (user.id === req.userId) throw new AppError(400, 'You cannot change your own role.');
  const before = user.role;
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  writeAudit(req, { action: 'user.role.set', target: `user:${id}`, before, after: role });
  res.json({ ok: true, user: { ...pubUser(user), role } });
});

/** Read the append-only audit log (most recent first). */
adminRouter.get('/audit', (req: AuthedRequest, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 1000);
  const rows = db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit);
  res.json({ audit: rows });
});
