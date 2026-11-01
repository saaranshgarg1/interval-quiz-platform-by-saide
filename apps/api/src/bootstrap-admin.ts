import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Role } from './types.js';

/**
 * Controlled first-administrator bootstrap for a fresh production database.
 *
 * This is an operator CLI, not an HTTP endpoint. It promotes exactly one
 * already-registered local account and refuses once any administrator exists.
 * It never creates accounts, never accepts a password, and never seeds demo
 * data. The database module is imported only after the email argument and the
 * production secrets have been validated, because importing db.ts opens (and
 * migrates) the database as a side effect.
 */

const USAGE = 'Usage: node apps/api/dist/bootstrap-admin.js --email <registered-email>';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUDIT_ACTION = 'bootstrap.admin.promote';

// Keep in sync with auth.ts. Bootstrap is a privileged operator action, so it
// requires strong secrets even when NODE_ENV is not production.
const DEV_JWT_SECRET = 'interval-dev-jwt-secret-change-me';
const DEV_PASSWORD_SECRET = 'interval-dev-pepper-change-me';

export class BootstrapRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapRefusal';
  }
}

/**
 * Refuse to touch the database unless both signing and password secrets are
 * independently configured. Values are never included in errors.
 */
export function assertBootstrapSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const insecure: string[] = [];
  for (const [key, fallback] of [
    ['INTERVAL_JWT_SECRET', DEV_JWT_SECRET],
    ['INTERVAL_PASSWORD_PEPPER', DEV_PASSWORD_SECRET],
  ] as const) {
    const value = env[key]?.trim();
    if (!value || value === fallback || value.length < 32) insecure.push(key);
  }
  if (insecure.length) {
    throw new BootstrapRefusal(
      `Refusing: set ${insecure.join(' and ')} to independently generated random secrets of at least 32 characters before bootstrapping an administrator.`,
    );
  }
}

/**
 * Only `--email <value>` is accepted. Anything else (including password flags,
 * duplicate emails, extra arguments or `--email=value`) is refused.
 */
export function parseBootstrapArgs(argv: string[]): string {
  if (argv.length === 0) {
    throw new BootstrapRefusal(`Refusing: --email is required. ${USAGE}`);
  }
  let email: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--email') {
      if (email !== undefined) {
        throw new BootstrapRefusal('Refusing: --email may be provided only once.');
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new BootstrapRefusal(`Refusing: --email requires a value. ${USAGE}`);
      }
      email = value;
      i++;
    } else {
      throw new BootstrapRefusal(
        'Refusing: unsupported argument. Only --email is accepted; this command never accepts passwords.',
      );
    }
  }
  if (email === undefined) {
    throw new BootstrapRefusal(`Refusing: --email requires a value. ${USAGE}`);
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new BootstrapRefusal('Refusing: enter a valid email address.');
  }
  return email;
}

export interface BootstrapResult {
  userId: number;
  email: string;
  previousRole: Role;
  tokenVersion: number;
  auditAction: string;
}

/**
 * Promote one registered account to admin. The first-admin invariant is
 * checked inside the transaction (BEGIN IMMEDIATE), so a concurrent bootstrap
 * cannot slip a second administrator in after the check.
 */
export async function bootstrapAdmin(
  argv: string[],
): Promise<BootstrapResult> {
  const email = parseBootstrapArgs(argv);
  assertBootstrapSecrets();
  const dataDir = process.env.INTERVAL_DATA_DIR;
  if (!dataDir?.trim() || !path.isAbsolute(dataDir)) {
    throw new BootstrapRefusal('Refusing: INTERVAL_DATA_DIR must explicitly name an absolute directory.');
  }
  let databaseExists = false;
  try {
    databaseExists = statSync(path.join(dataDir, 'interval.db')).isFile();
  } catch {
    // Missing or inaccessible targets must not fall back to a default database.
  }
  if (!databaseExists) {
    throw new BootstrapRefusal('Refusing: INTERVAL_DATA_DIR must contain an existing interval.db. Register your account first.');
  }

  // Only import these after validation: db.ts opens and migrates the database
  // at module load. This keeps refusals from touching the database at all.
  const { db, transaction } = await import('./db.js');
  const { userRepo } = await import('./repo.js');

  return transaction(() => {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
      n: number;
    };
    if (Number(admins.n) > 0) {
      throw new BootstrapRefusal(
        'Refusing: an administrator already exists. Sign in as that administrator and use the admin UI to change roles; this bootstrap runs only once.',
      );
    }

    const target = userRepo.findByEmail(email);
    if (!target) {
      throw new BootstrapRefusal(
        `Refusing: no registered account exists for ${email}. Register that exact account through the normal sign-up page first; this command never creates users.`,
      );
    }
    if (target.role === 'admin') {
      throw new BootstrapRefusal('Refusing: that account is already an administrator.');
    }

    const update = db
      .prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role <> 'admin'")
      .run(target.id);
    if (Number(update.changes) !== 1) {
      throw new BootstrapRefusal('Refusing: the account changed during bootstrap; no promotion was applied.');
    }

    // Sessions minted while the account was a student must not inherit admin.
    const tokenVersion = userRepo.bumpTokenVersion(target.id);

    // No authenticated actor exists for a CLI bootstrap. Record that truthfully:
    // null actor, explicit action, and the origin is stored in the after JSON.
    db.prepare(
      `INSERT INTO audit_log (actor_id, actor_role, course_id, action, target, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      null,
      null,
      null,
      AUDIT_ACTION,
      `user:${target.id}`,
      JSON.stringify({ role: target.role }),
      JSON.stringify({
        role: 'admin',
        origin: 'cli-bootstrap',
        email_ownership_verified: false,
      }),
    );

    return {
      userId: target.id,
      email: target.email,
      previousRole: target.role,
      tokenVersion,
      auditAction: AUDIT_ACTION,
    };
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  bootstrapAdmin(process.argv.slice(2))
    .then((result) => {
      console.log(
        `[bootstrap-admin] promoted ${result.email} (user ${result.userId}) from ${result.previousRole} to admin.`,
      );
      console.log('[bootstrap-admin] existing sessions revoked; sign out and sign in again.');
      console.log(`[bootstrap-admin] audit action: ${result.auditAction}`);
    })
    .catch((error: unknown) => {
      console.error(`[bootstrap-admin] ${error instanceof Error ? error.message : 'Unexpected failure.'}`);
      process.exitCode = 1;
    });
}
