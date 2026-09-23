import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

const PASSWORD_SECRET =
  process.env.INTERVAL_PASSWORD_PEPPER ?? 'interval-dev-pepper-change-me';
const JWT_SECRET =
  process.env.INTERVAL_JWT_SECRET ?? 'interval-dev-jwt-secret-change-me';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(`${PASSWORD_SECRET}::${password}`, salt, 64).toString('hex');
  return `${salt}:${derived}`;
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
}

const TOKEN_VERSION = 1;

export function signToken(user: { id: number; role: TokenPayload['role'] }): string {
  const payload: TokenPayload = { uid: user.id, role: user.role, v: TOKEN_VERSION };
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
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  req.userId = payload.uid;
  req.userRole = payload.role;
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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[api][error]', err);
  res.status(500).json({ error: 'Internal server error.' });
}