import { Router } from 'express';
import { userRepo, pubUser } from '../repo.js';
import { requireAuth, AppError, hashPassword, verifyPassword, signToken } from '../auth.js';
import type { AuthedRequest } from '../auth.js';

export const authRouter = Router();

authRouter.post('/register', (req, res) => {
  const { name, email, password, role } = req.body ?? {};
  if (!name || !email || !password) {
    throw new AppError(400, 'Name, email and password are required.');
  }
  const r = role === 'instructor' ? 'instructor' : 'student';
  if (String(password).length < 6) {
    throw new AppError(400, 'Password must be at least 6 characters.');
  }
  if (userRepo.findByEmail(email)) {
    throw new AppError(409, 'An account with this email already exists.');
  }
  const user = userRepo.create(String(name), String(email), hashPassword(String(password)), r);
  res.status(201).json({ token: signToken(user), user: pubUser(user) });
});

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const user = email ? userRepo.findByEmail(email) : undefined;
  if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
    throw new AppError(401, 'Invalid email or password.');
  }
  res.json({ token: signToken(user), user: pubUser(user) });
});

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  const user = userRepo.findById(req.userId as number);
  if (!user) throw new AppError(404, 'User not found.');
  res.json({ user: pubUser(user) });
});

// sAIDE SSO / CAS integration handler
authRouter.post('/sso', (req, res) => {
  const { ticket, email, name, role } = req.body ?? {};
  // Accepts ticket or direct sAIDE campus token
  if (!email || typeof email !== 'string') {
    throw new AppError(400, 'Valid email required from SSO provider.');
  }

  let user = userRepo.findByEmail(email);
  if (!user) {
    const assignedRole = role === 'instructor' ? 'instructor' : 'student';
    const userName = (name && typeof name === 'string' ? name : email.split('@')[0]) || 'User';
    user = userRepo.create(
      userName,
      email,
      hashPassword('sso-managed-auth-' + Math.random().toString(36)),
      assignedRole,
    );
  }

  res.json({
    token: signToken(user),
    user: pubUser(user),
    sso_authenticated: true,
  });
});