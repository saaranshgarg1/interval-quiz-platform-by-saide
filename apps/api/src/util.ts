import crypto from 'node:crypto';
import net from 'node:net';

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

/** Add minutes to a given UTC timestamp (SQLite 'YYYY-MM-DD HH:MM:SS.sss' or ISO). */
export function addMinutesTo(timestamp: string, minutes: number): string {
  return fromMs(toMs(timestamp) + minutes * 60_000);
}

/** Add seconds to a stored UTC timestamp. */
export function addSecondsTo(timestamp: string, seconds: number): string {
  return fromMs(toMs(timestamp) + seconds * 1000);
}

/** Parse a stored UTC timestamp ('YYYY-MM-DD HH:MM:SS[.sss]' or ISO) to epoch ms. */
export function toMs(timestamp: string): number {
  const iso = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T');
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso);
  return Date.parse(zoned ? iso : `${iso}Z`);
}

/** Format epoch ms as the canonical stored UTC timestamp. */
export function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
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

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
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

// ---------------------------------------------------------------- networks

/** Strip the IPv4-mapped IPv6 prefix Express reports for v4 clients. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) return v.slice(7);
  return v;
}

/** Validate one allow-list entry: a bare IP or an IPv4/IPv6 CIDR. */
export function isValidNetwork(entry: string): boolean {
  const [addr, bits, extra] = entry.trim().split('/');
  if (extra !== undefined || !addr) return false;
  const family = net.isIPv4(addr) ? 4 : net.isIPv6(addr) ? 6 : 0;
  if (!family) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  return n >= 0 && n <= (family === 4 ? 32 : 128);
}

/** True when `ip` falls inside any of the CIDR/IP entries. Empty list = no restriction. */
export function ipAllowed(ip: string | null, networks: string[]): boolean {
  if (networks.length === 0) return true;
  const addr = normalizeIp(ip);
  if (!addr) return false;
  const family = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
  if (!family) return false;
  const list = new net.BlockList();
  for (const entry of networks) {
    const [base, bits] = entry.trim().split('/');
    if (!base) continue;
    const entryFamily = net.isIPv4(base) ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(base, entryFamily);
    else list.addSubnet(base, Number(bits), entryFamily);
  }
  return list.check(addr, family);
}

// ---------------------------------------------------------------- identities

const ENTRY_FROM_EMAIL = new RegExp(
  process.env.INTERVAL_ENTRY_NUMBER_PATTERN ?? '^\\d{4}[a-z]{3}\\d{4}$',
  'i',
);

/**
 * Institute emails embed the entry number (2022csb1234@iitrpr.ac.in → 2022CSB1234).
 * Returns null when the local part does not look like an entry number.
 */
export function entryNumberFromEmail(email: string): string | null {
  const local = email.trim().split('@')[0] ?? '';
  return ENTRY_FROM_EMAIL.test(local) ? local.toUpperCase() : null;
}

/** Canonical entry number (upper-case, trimmed) or null; throws on malformed input. */
export function normalizeEntryNumber(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === '') return null;
  if (!/^[A-Za-z0-9._/-]{2,32}$/.test(v)) {
    throw new Error('Entry number may only contain letters, digits, ".", "_", "/" or "-" (2–32 characters).');
  }
  return v.toUpperCase();
}
