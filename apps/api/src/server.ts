import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { db, migrate, backupDatabase } from './db.js';
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
import { proctorRouter } from './routes/proctor.js';
import { insightsRouter } from './routes/insights.js';
import { errorHandler, assertSecretsConfigured, verifyToken } from './auth.js';
import { startSweeper, stopSweeper, sweepDueAttempts } from './services/attempts.js';

process.on('unhandledRejection', (reason) => {
  console.error('[interval-api][unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[interval-api][uncaughtException]', err);
});

assertSecretsConfigured();
migrate();

// Reconcile on startup: attempts whose timers ran out while the API was down are
// graded and closed now (not merely marked expired), so nothing is left ungraded.
for (let batch = 0; batch < 1000 && sweepDueAttempts(500) === 500; batch++);

const app = express();

/**
 * Which proxies to trust for the client IP (rate limits, exam-network
 * allow-lists, IP-change detection). Default: loopback only — correct for a
 * same-host reverse proxy and safe when exposed directly (a client cannot spoof
 * X-Forwarded-For). Set INTERVAL_TRUST_PROXY to a hop count, a subnet list or
 * "true" when a load balancer on another host terminates TLS.
 */
function trustProxySetting(raw: string | undefined): boolean | number | string {
  if (!raw) return 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}
app.set('trust proxy', trustProxySetting(process.env.INTERVAL_TRUST_PROXY));

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
        'frame-src': ["'self'", 'https://accounts.google.com/gsi/'],
        'connect-src': ["'self'", 'https://accounts.google.com/gsi/'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'https:'],
      },
    },
    // Google sign-in opens a popup that must be able to message this window.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }),
);

// CORS: same-origin requests (the built site served by this process) and
// requests without an Origin (curl, server-to-server) are always allowed; other
// browser origins must be listed in INTERVAL_WEB_ORIGIN (comma-separated; the
// default covers the Vite dev server). Anything else gets 403.
const ALLOWED_ORIGINS = (
  process.env.INTERVAL_WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
/** The page this API serves itself (production: one process, one origin) is always allowed. */
function isSameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin) && !isSameOrigin(origin, req.headers.host)) {
    res.status(403).json({ error: `Origin ${origin} is not allowed.` });
    return;
  }
  next();
});
app.use('/api', cors({ origin: true, credentials: true }));

app.use(express.json({ limit: '512kb' }));

// Credential endpoints: generous per-IP ceiling (a whole campus can share one
// NAT address); real brute-force protection is the per-account guard in auth.ts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.INTERVAL_AUTH_RATE_MAX ?? 2000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait and try again.' },
});

// Everything else: per signed-in user (falls back to IP), sized far above what
// a student needs (autosave + heartbeat + events ≈ 30/min) to stop runaway clients.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.INTERVAL_API_RATE_MAX ?? 600),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const header = req.headers.authorization ?? '';
    const payload = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
    return payload ? `user:${payload.uid}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
  message: { error: 'Too many requests. Slow down and try again in a minute.' },
});

app.use('/api/auth', authLimiter, authRouter);
app.use('/api', apiLimiter);
app.use('/api/courses', coursesRouter);
app.use('/api/quizzes', quizzesRouter);
app.use('/api/attempts', attemptsRouter);
app.use('/api/results', resultsRouter);
app.use('/api/review', reviewRouter);
app.use('/api/banks', banksRouter);
app.use('/api/accommodations', accommodationsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/proctor', proctorRouter);
app.use('/api/insights', insightsRouter);

// The histogram measures timer intervals, so readings include the sampling
// interval itself; report only the delay on top of it.
const LOOP_RESOLUTION_MS = 10;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();
const loopMs = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10);

app.get('/api/health', (_req, res) => {
  let dbOk = true;
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    service: 'interval-api',
    time: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    event_loop_delay_ms: {
      p50: loopMs(loopDelay.percentile(50)),
      p99: loopMs(loopDelay.percentile(99)),
      max: loopMs(loopDelay.max),
    },
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    // Total CPU time used by this process (one core = 1000 ms per second).
    cpu_ms: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
  });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Serve the built web app from the same origin (one process, one port).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.INTERVAL_WEB_DIST ?? path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  app.use(
    '/assets',
    express.static(path.join(WEB_DIST, 'assets'), { immutable: true, maxAge: '365d', index: false }),
  );
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

app.use(errorHandler);

export { app };

// Only bind a port when run as the entrypoint; test files import `app` directly.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const PORT = Number(process.env.PORT ?? 4000);
  // A large accept backlog absorbs connection bursts (a whole class pressing
  // Start together) while the event loop is busy, instead of refusing them.
  const server = app.listen({ port: PORT, backlog: Number(process.env.INTERVAL_LISTEN_BACKLOG ?? 4096) }, () => {
    console.log(`[interval-api] listening on http://localhost:${PORT}`);
  });
  // Many students behind one proxy keep connections alive; outlive the proxy's idle timeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  startSweeper();

  // Automatic online backups (default every 30 min in production; 0 disables).
  const backupEvery = Number(process.env.INTERVAL_BACKUP_EVERY_MINUTES ?? (process.env.NODE_ENV === 'production' ? 30 : 0));
  if (backupEvery > 0) {
    setInterval(() => {
      backupDatabase().then(
        (file) => console.log(`[interval-api][backup] ${file}`),
        (e) => console.error('[interval-api][backup] failed', e),
      );
    }, backupEvery * 60_000).unref();
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[interval-api] ${signal} received, draining connections…`);
    stopSweeper();
    server.close(() => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        db.close();
      } catch (e) {
        console.error('[interval-api] error while closing the database', e);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
