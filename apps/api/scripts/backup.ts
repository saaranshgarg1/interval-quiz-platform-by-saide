/**
 * Back up the Interval database (safe while the API is running).
 *
 *   pnpm --filter @interval/api backup            # → data/backups/interval-<time>.db
 *   pnpm --filter @interval/api backup -- D:\backups
 *
 * Restore: stop the API, copy the backup over data/interval.db, start the API.
 */
const { backupDatabase } = await import('../src/db.js');
const target = process.argv[2];
const file = await backupDatabase(target || undefined);
console.log(`[backup] wrote ${file}`);
