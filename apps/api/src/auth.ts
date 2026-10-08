import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.js';
import type { CourseRole } from './types.js';

const PASSWORD_SECRET =
  process.env.INTERVAL_PASSWORD_PEPPER ?? 'interval-dev-pepper-change-me';
const JWT_SECRET =
  process.env.INTERVAL_JWT_SECRET ?? 'interval-dev-jwt-secret-change-me';

/**
 * Refuse to boot in production with the built-in dev secrets. Call once at startup.
 */
export function assertSecretsConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing: string[] = [];
  if (!process.env.INTERVAL_JWT_SECRET) missing.push('INTERVAL_JWT_SECRET');
  if (!process.env.INTERVAL_PASSWORD_PEPPER) missing.push('INTERVAL_PASSWORD_PEPPER');
  if (missing.length) {
    throw new Error(
      `Refusing to boot: set ${missing.join(' and ')} in production (dev defaults are insecure).`,
    );
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(`${PASSWORD_SECRET}::${password}`, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

const scryptAsync = promisify(crypto.scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

/**
 * Async variants for request paths. scrypt costs ~30 ms of CPU; the sync form
 * blocks the event loop, so 500 students signing in together would stall every
 * autosave for ~15 s. These run on the libuv threadpool instead.
 */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(`${PASSWORD_SECRET}::${password}`, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const derived = await scryptAsync(`${PASSWORD_SECRET}::${password}`, salt, 64);
  const b = Buffer.from(hex, 'hex');
  return derived.length === b.length && crypto.timingSafeEqual(derived, b);
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const derived = crypto.scryptSync(`${PASSWORD_SECRET}::${password}`, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface TokenPayload {
  uid: number;
  role: 'student' | 'instructor' | 'admin';
  v: number;
  /** Per-user token version; bumping users.token_version revokes every older token. */
  tv?: number;
}

const TOKEN_VERSION = 1;

export function signToken(user: { id: number; role: TokenPayload['role']; token_version?: number }): string {
  const payload: TokenPayload = { uid: user.id, role: user.role, v: TOKEN_VERSION, tv: user.token_version ?? 0 };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    if (payload.v !== TOKEN_VERSION) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface AuthedRequest extends Request {
  userId?: number;
  userRole?: TokenPayload['role'];
  courseRole?: CourseRole;
}

/**
 * Verify the bearer token, then confirm it against the account: deleted users,
 * revoked tokens (token_version bumped) and stale roles are rejected. The role
 * comes from the database, so a demotion takes effect on the next request.
 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  const account = payload
    ? (db.prepare('SELECT role, token_version FROM users WHERE id = ?').get(payload.uid) as
        | { role: TokenPayload['role']; token_version: number }
        | undefined)
    : undefined;
  if (!payload || !account || Number(account.token_version) !== (payload.tv ?? 0)) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  req.userId = payload.uid;
  req.userRole = account.role;
  next();
}

export function requireRoles(...roles: TokenPayload['role'][]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      res.status(403).json({ error: 'You do not have permission for this action.' });
      return;
    }
    next();
  };
}

export class AppError extends Error {
  status: number;
  /** Stable machine-readable reason the client can branch on (e.g. 'session_required'). */
  code?: string;
  details?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ ...err.details, error: err.message, ...(err.code ? { code: err.code } : {}) });
    return;
  }
  // body-parser: malformed JSON / oversized payloads are client errors, not 500s.
  const status = (err as { status?: unknown; type?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? 'Request body too large.' : 'Malformed request body.' });
    return;
  }
  console.error('[api][error]', err);
  res.status(500).json({ error: 'Internal server error.' });
}