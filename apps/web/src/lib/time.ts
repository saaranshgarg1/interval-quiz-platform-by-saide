/**
 * One place for time in the web app.
 *
 * - Every time shown to people is in IST (Asia/Kolkata), whatever timezone the
 *   viewer's device is set to, and is labelled "IST".
 * - "Now" comes from the server clock (every API response sends X-Server-Time),
 *   so a student whose laptop clock is wrong still sees the right open/close state.
 * - The API stores UTC as 'YYYY-MM-DD HH:MM:SS[.sss]' with no zone marker;
 *   `serverDate` reads that correctly (plain `new Date()` would treat it as local).
 */

export const IST_ZONE = 'Asia/Kolkata';
/** India has no daylight saving, so IST is always UTC+05:30. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// ------------------------------------------------------------- server clock

let offsetMs = 0;
let bestRttMs = Number.POSITIVE_INFINITY;
let samples = 0;

/**
 * Record the server clock from a response. The fastest round trip gives the
 * most accurate estimate; older samples are allowed to be replaced every so
 * often so a device clock change (sleep, manual change) is picked up.
 */
export function noteServerTime(serverMs: number, sentAt: number, receivedAt: number): void {
  if (!Number.isFinite(serverMs)) return;
  const rtt = Math.max(0, receivedAt - sentAt);
  samples++;
  if (rtt <= bestRttMs || samples % 20 === 0) {
    bestRttMs = rtt;
    offsetMs = serverMs - (sentAt + rtt / 2);
  }
}

/** Server-clock milliseconds since epoch. Use this instead of Date.now() for deadlines. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Convert a device-clock timestamp (e.g. React Query's dataUpdatedAt) to server time. */
export function deviceToServerMs(deviceMs: number): number {
  return deviceMs + offsetMs;
}

// ------------------------------------------------------------------ parsing

/** Parse a server timestamp (stored UTC without a zone marker, or full ISO). */
export function serverDate(ts: string): Date {
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  return new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
}

/** Server timestamp → epoch ms (NaN if unparseable). */
export function serverMs(ts: string): number {
  return serverDate(ts).getTime();
}

// --------------------------------------------------------------- formatting

type Style = 'datetime' | 'date' | 'time' | 'timeShort';

const FORMATS: Record<Style, Intl.DateTimeFormatOptions> = {
  datetime: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true },
  timeShort: { hour: '2-digit', minute: '2-digit', hour12: true },
};
const formatters = new Map<Style, Intl.DateTimeFormat>();

/**
 * Format a time in IST, e.g. "4 Nov 2026, 10:00 am IST". Accepts a server
 * timestamp string, epoch ms or a Date. Returns '—' for empty input.
 */
export function formatIST(value: string | number | Date | null | undefined, style: Style = 'datetime'): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = typeof value === 'string' ? serverDate(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : '—';
  let f = formatters.get(style);
  if (!f) {
    f = new Intl.DateTimeFormat('en-IN', { ...FORMATS[style], timeZone: IST_ZONE });
    formatters.set(style, f);
  }
  return style === 'date' ? f.format(d) : `${f.format(d)} IST`;
}

// ------------------------------------------------------ scheduled windows

export interface WindowStatus {
  state: 'upcoming' | 'open' | 'closed';
  opensMs: number;
  closesMs: number;
  /** e.g. "Opens 4 Nov 2026, 10:00 am IST · 30 min" / "Open now · closes 10:30 am IST" / "Closed at …". */
  label: string;
}

/**
 * Where a scheduled window stands right now (by the server clock). `closesTs`
 * is the server's close time when known (it includes extensions); otherwise
 * opening time + duration.
 */
export function windowStatus(
  opensTs: string,
  durationMinutes: number | null | undefined,
  closesTs?: string | null,
): WindowStatus | null {
  const opensMs = serverMs(opensTs);
  if (Number.isNaN(opensMs)) return null;
  const closesMs = closesTs ? serverMs(closesTs) : opensMs + (durationMinutes ?? 0) * 60_000;
  const now = serverNow();
  if (now < opensMs) {
    return {
      state: 'upcoming',
      opensMs,
      closesMs,
      label: `Opens ${formatIST(opensMs)}${durationMinutes ? ` · ${durationMinutes} min` : ''}`,
    };
  }
  if (now < closesMs) {
    return {
      state: 'open',
      opensMs,
      closesMs,
      label: `Open now · closes ${formatIST(closesMs, 'timeShort')}`,
    };
  }
  return { state: 'closed', opensMs, closesMs, label: `Window closed ${formatIST(closesMs)}` };
}

// ------------------------------------------- <input type="datetime-local">

/** Server UTC timestamp → 'YYYY-MM-DDTHH:MM' showing the IST wall clock. */
export function utcToIstInput(ts: string): string {
  const ms = serverMs(ts);
  if (Number.isNaN(ms)) return '';
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** 'YYYY-MM-DDTHH:MM' typed as IST (whatever the device timezone) → UTC ISO string. */
export function istInputToUtcIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return new Date(wall - IST_OFFSET_MS).toISOString();
}

/** Current server time as an IST 'YYYY-MM-DDTHH:MM' (for input min= / defaults). */
export function nowIstInput(): string {
  return new Date(serverNow() + IST_OFFSET_MS).toISOString().slice(0, 16);
}
