import express from 'express';
import cors from 'cors';
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
import { errorHandler } from './auth.js';

process.on('unhandledRejection', (reason) => {
  console.error('[interval-api][unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[interval-api][uncaughtException]', err);
});

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
app.use(cors());
app.use(express.json({ limit: '512kb' }));

app.use('/api/auth', authRouter);
app.use('/api/courses', coursesRouter);
app.use('/api/quizzes', quizzesRouter);
app.use('/api/attempts', attemptsRouter);
app.use('/api/results', resultsRouter);
app.use('/api/review', reviewRouter);
app.use('/api/banks', banksRouter);
app.use('/api/accommodations', accommodationsRouter);
app.use('/api/analytics', analyticsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'interval-api', time: new Date().toISOString() });
});

app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`[interval-api] listening on http://localhost:${PORT}`);
});