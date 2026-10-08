import { Router } from 'express';
import { requireAuth, requireRoles, AppError } from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { db, backupDatabase } from '../db.js';
import { asyncHandler } from '../auth.js';
import { userRepo, pubUser } from '../repo.js';
import { writeAudit } from '../authz.js';
import type { Role } from '../types.js';
import { normalizeEntryNumber } from '../util.js';
import { adminUpdateProfile, readPrefs } from '../services/accessibility.js';

export const adminRouter = Router();

// Platform superuser surface. Global role check only — not course-scoped.
adminRouter.use(requireAuth, requireRoles('admin'));

/** List every account. */
adminRouter.get('/users', (_req: AuthedRequest, res) => {
  const users = (db
    .prepare('SELECT id, name, email, role, entry_number, created_at, a11y, time_multiplier FROM users ORDER BY created_at DESC')
    .all() as { a11y: string; time_multiplier: number }[]).map(({ a11y, ...u }) => ({
    ...u,
    time_multiplier: Number(u.time_multiplier ?? 1),
    accessibility: readPrefs({ a11y }),
  }));
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
  // Sessions minted under the old role must not outlive the change.
  userRepo.bumpTokenVersion(id);
  writeAudit(req, { action: 'user.role.set', target: `user:${id}`, before, after: role });
  res.json({ ok: true, user: { ...pubUser(user), role } });
});

/** Correct a user's entry number (institute roll number). Empty clears it. */
adminRouter.patch('/users/:id/entry-number', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const user = userRepo.findById(id);
  if (!user) throw new AppError(404, 'User not found.');
  let entry: string | null;
  try {
    entry = normalizeEntryNumber(req.body?.entry_number);
  } catch (e) {
    throw new AppError(400, (e as Error).message);
  }
  const holder = entry ? userRepo.findByEntryNumber(entry) : undefined;
  if (holder && holder.id !== id) throw new AppError(409, `Entry number ${entry} belongs to ${holder.email}.`);
  userRepo.setEntryNumber(id, entry);
  writeAudit(req, { action: 'user.entry_number.set', target: `user:${id}`, before: user.entry_number, after: entry });
  res.json({ ok: true, user: { ...pubUser(user), entry_number: entry } });
});

/**
 * Accessibility profile for a user: display preferences (the user can also
 * change these) and an account-wide extra-time multiplier applied to every
 * timed quiz they start (only admins can grant time).
 */
adminRouter.put('/users/:id/accessibility', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const user = userRepo.findById(id);
  if (!user) throw new AppError(404, 'User not found.');
  const before = { prefs: readPrefs(user), time_multiplier: user.time_multiplier ?? 1 };
  const profile = adminUpdateProfile(user, { prefs: req.body?.prefs, time_multiplier: req.body?.time_multiplier });
  writeAudit(req, {
    action: 'user.accessibility.set',
    target: `user:${id}`,
    before,
    after: { prefs: profile.prefs, time_multiplier: profile.time_multiplier },
  });
  res.json({ accessibility: profile });
});

/** Sign a user out everywhere (compromised password, shared lab machine). */
adminRouter.post('/users/:id/revoke-sessions', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!userRepo.findById(id)) throw new AppError(404, 'User not found.');
  userRepo.bumpTokenVersion(id);
  writeAudit(req, { action: 'user.sessions.revoke', target: `user:${id}` });
  res.json({ ok: true });
});

/** Read the append-only audit log (most recent first). */
adminRouter.get('/audit', (req: AuthedRequest, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 1000);
  const rows = db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit);
  res.json({ audit: rows });
});

/** Take an online backup now (e.g. right before an exam starts). */
adminRouter.post('/backup', asyncHandler(async (req, res) => {
  const file = await backupDatabase();
  writeAudit(req, { action: 'db.backup', after: { file } });
  res.json({ ok: true, file });
}));
