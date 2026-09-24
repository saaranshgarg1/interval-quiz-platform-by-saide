import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { db, migrate } from './db.js';
import { attemptRepo } from './repo.js';
import { authRouter } from './routes/auth.js';
import { coursesRouter } from './routes/courses.js';
import { quizzesRouter } from './routes/quizzes.js';
import { attemptsRouter } from './routes/attempts.js';
import { resultsRouter } from './routes/results.js';
import { reviewRouter } from './routes/review.js';
import { banksRouter } from './routes/banks.js';
import { accommodationsRouter } from './routes/accommodations.js';
import { analyticsRouter } from './routes/analytics.js';
import { adminRouter } from './routes/admin.js';
import { errorHandler, assertSecretsConfigured } from './auth.js';

process.on('unhandledRejection', (reason) => {
  console.error('[interval-api][unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[interval-api][uncaughtException]', err);
});

assertSecretsConfigured();
migrate();

// Reconcile expired attempts on startup so a browser that disappears still
// finishes attempts whose deadline has already passed.
const stale = db
  .prepare(
    "SELECT id FROM attempts WHERE status = 'in_progress' AND expires_at IS NOT NULL AND expires_at < datetime('now')",
  )
  .all() as { id: number }[];
for (const row of stale) {
  attemptRepo.updateStatus(Number(row.id), 'expired');
  db.prepare(
    "INSERT INTO policy_events (attempt_id, kind, detail, source) VALUES (?, 'expired', 'Reconciled on API startup.', 'server')",
  ).run(Number(row.id));
}

const app = express();

// Trust the reverse proxy in front of us so rate-limit sees real client IPs.
app.set('trust proxy', 1);

app.use(helmet());

// CORS: explicit allow-list. Origins come from INTERVAL_WEB_ORIGIN (comma-separated);
// defaults cover the local Vite dev server. A same-origin/no-origin request (curl,
// server-to-server) is allowed; a disallowed browser origin is rejected.
const ALLOWED_ORIGINS = (
  process.env.INTERVAL_WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '512kb' }));

// Throttle the credential endpoints (login / register / sso) against brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.INTERVAL_AUTH_RATE_MAX ?? 50),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait and try again.' },
});

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/courses', coursesRouter);
app.use('/api/quizzes', quizzesRouter);
app.use('/api/attempts', attemptsRouter);
app.use('/api/results', resultsRouter);
app.use('/api/review', reviewRouter);
app.use('/api/banks', banksRouter);
app.use('/api/accommodations', accommodationsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'interval-api', time: new Date().toISOString() });
});

app.use(errorHandler);

export { app };

// Only bind a port when run as the entrypoint; test files import `app` directly.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const PORT = Number(process.env.PORT ?? 4000);
  app.listen(PORT, () => {
    console.log(`[interval-api] listening on http://localhost:${PORT}`);
  });
}