import crypto from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO UTC timestamp usable in SQLite datetime comparisons when lexically ordered. */
export function nowUtc(): string {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

export function addMinutes(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

export function dateToUtc(d: string): string {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toISOString().slice(0, 23).replace('T', ' ');
}

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomSeed(): number {
  return crypto.randomInt(0, 1_000_000_000);
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]] as [T, T];
  }
  return a;
}

export function jsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Deterministic idempotency key for a save batch. */
export function revisionDigest(attemptId: number, position: number, revision: number): string {
  return crypto
    .createHash('sha256')
    .update(`${attemptId}:${position}:${revision}`)
    .digest('hex')
    .slice(0, 12);
}

/** Opaque server-confirmed receipt: <attemptId>-<hex>. */
export function makeReceipt(attemptId: number): string {
  return `${attemptId}-${crypto.randomBytes(12).toString('hex')}`;
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}