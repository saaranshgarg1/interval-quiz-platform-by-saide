import { Router } from 'express';
import { userRepo, pubUser, pendingEnrollmentRepo } from '../repo.js';
import {
  requireAuth,
  AppError,
  hashPasswordAsync,
  verifyPasswordAsync,
  signToken,
  asyncHandler,
} from '../auth.js';
import type { AuthedRequest } from '../auth.js';
import { verifyGoogleIdToken } from '../services/google-sso.js';
import { profileFor, updateOwnPrefs } from '../services/accessibility.js';
import { entryNumberFromEmail, normalizeEntryNumber } from '../util.js';
import type { User } from '../types.js';
import crypto from 'node:crypto';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Optional self-registration domain allow-list, e.g. "iitrpr.ac.in". */
const ALLOWED_DOMAINS = (process.env.INTERVAL_ALLOWED_EMAIL_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/**
 * Per-account brute-force guard. Keyed by email rather than IP: a whole campus
 * can sit behind one NAT address, so per-IP limits would lock out a class.
 */
const failedLogins = new Map<string, { count: number; first: number }>();
const LOGIN_MAX_FAILURES = Number(process.env.INTERVAL_LOGIN_MAX_FAILURES ?? 10);
const LOGIN_WINDOW_MS = 15 * 60_000;

function loginBlocked(key: string): boolean {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordFailure(key: string): void {
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) failedLogins.set(key, { count: 1, first: Date.now() });
  else entry.count++;
  if (failedLogins.size > 50_000) failedLogins.clear(); // bounded memory under a spraying attack
}

/** Join every course the person was invited to before the account existed. */
function onAccountReady(user: User): User {
  const claimed = pendingEnrollmentRepo.claim(user);
  return claimed.courses > 0 ? (userRepo.findById(user.id) as User) : user;
}

authRouter.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password, entry_number } = req.body ?? {};
  if (!name || !email || !password) {
    throw new AppError(400, 'Name, email and password are required.');
  }
  const cleanEmail = String(email).trim();
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) throw new AppError(400, 'Enter a valid email address.');
  if (String(name).trim().length < 2 || String(name).length > 100) {
    throw new AppError(400, 'Name must be 2–100 characters.');
  }
  if (String(password).length < 8 || String(password).length > 200) {
    throw new AppError(400, 'Password must be at least 8 characters.');
  }
  const domain = cleanEmail.split('@')[1]?.toLowerCase() ?? '';
  if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(domain)) {
    throw new AppError(400, `Use your institute email (${ALLOWED_DOMAINS.join(', ')}).`);
  }
  if (userRepo.findByEmail(cleanEmail)) {
    throw new AppError(409, 'An account with this email already exists.');
  }
  let entry: string | null;
  try {
    entry = normalizeEntryNumber(entry_number) ?? entryNumberFromEmail(cleanEmail);
  } catch (e) {
    throw new AppError(400, (e as Error).message);
  }
  if (entry && userRepo.findByEntryNumber(entry)) {
    throw new AppError(409, 'That entry number is already registered to another account.');
  }
  const hash = await hashPasswordAsync(String(password));
  // Re-check after the await: another request may have registered meanwhile.
  if (userRepo.findByEmail(cleanEmail)) throw new AppError(409, 'An account with this email already exists.');
  const user = onAccountReady(userRepo.create(String(name), cleanEmail, hash, 'student', entry));
  res.status(201).json({ token: signToken(user), user: pubUser(user) });
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};
  const key = String(email ?? '').trim().toLowerCase();
  if (key && loginBlocked(key)) {
    throw new AppError(429, 'Too many failed sign-in attempts for this account. Try again in 15 minutes.', 'too_many_attempts');
  }
  const user = key ? userRepo.findByEmail(key) : undefined;
  // Always pay the hashing cost so response time does not reveal which emails exist.
  const ok = await verifyPasswordAsync(String(password ?? ''), user?.password_hash ?? 'x:00');
  if (!user || !ok) {
    if (key) recordFailure(key);
    throw new AppError(401, 'Invalid email or password.');
  }
  failedLogins.delete(key);
  res.json({ token: signToken(user), user: pubUser(user) });
}));

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  const user = userRepo.findById(req.userId as number);
  if (!user) throw new AppError(404, 'User not found.');
  res.json({ user: pubUser(user) });
});

/** The caller's accessibility profile (display preferences + any extra-time accommodation). */
authRouter.get('/accessibility', requireAuth, (req: AuthedRequest, res) => {
  const user = userRepo.findById(req.userId as number);
  if (!user) throw new AppError(404, 'User not found.');
  res.json({ accessibility: profileFor(user) });
});

/** Change one's own display preferences — any time except during an exam. */
authRouter.put('/accessibility', requireAuth, (req: AuthedRequest, res) => {
  const user = userRepo.findById(req.userId as number);
  if (!user) throw new AppError(404, 'User not found.');
  res.json({ accessibility: updateOwnPrefs(user, req.body?.prefs ?? req.body) });
});

/** Revoke every token issued to the caller (e.g. after signing in on a shared lab PC). */
authRouter.post('/logout-all', requireAuth, (req: AuthedRequest, res) => {
  userRepo.bumpTokenVersion(req.userId as number);
  res.json({ ok: true });
});

// sAIDE SSO / CAS integration handler
authRouter.post('/sso', asyncHandler(async (req, res) => {
  const { id_token, credential } = req.body ?? {};
  const idToken = (id_token ?? credential) as string | undefined;
  if (!idToken || typeof idToken !== 'string') {
    throw new AppError(400, 'A Google ID token is required.');
  }

  const { email, name } = await verifyGoogleIdToken(idToken);

  let user = userRepo.findByEmail(email);
  if (!user) {
    const userName = (name && typeof name === 'string' ? name : email.split('@')[0]) || 'User';
    const entry = entryNumberFromEmail(email);
    user = userRepo.create(
      userName,
      email,
      await hashPasswordAsync('sso-managed-auth-' + crypto.randomBytes(24).toString('hex')),
      'student',
      entry && !userRepo.findByEntryNumber(entry) ? entry : null,
    );
  }
  user = onAccountReady(user);

  res.json({
    token: signToken(user),
    user: pubUser(user),
    sso_authenticated: true,
  });
}));
