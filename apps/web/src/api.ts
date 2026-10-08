const TOKEN_KEY = 'interval.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  /** Stable machine-readable reason from the server (e.g. 'session_required'). */
  code?: string;
  /** The full error body, for extra fields such as `can_takeover`. */
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = typeof data.code === 'string' ? data.code : undefined;
    this.data = data;
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Survive page unload (used for the final "page closed" signal). */
  keepalive?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers,
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...init, headers, keepalive: opts.keepalive, signal: opts.signal });
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    let data: Record<string, unknown> = {};
    try {
      data = await res.json();
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message, data);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const body = (value: unknown) => (value === undefined ? undefined : JSON.stringify(value));

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>(path, {}, opts),
  post: <T>(path: string, value?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'POST', body: body(value) }, opts),
  put: <T>(path: string, value?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'PUT', body: body(value) }, opts),
  patch: <T>(path: string, value?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'PATCH', body: body(value) }, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>(path, { method: 'DELETE' }, opts),
};

/** True when the request never got an HTTP answer (offline, refused, reset). */
export function isNetworkError(err: unknown): boolean {
  return !(err instanceof ApiError) && !(err instanceof DOMException && err.name === 'AbortError');
}

/**
 * Retry a request that failed before reaching the server. Only for calls the
 * server treats idempotently (start/resume, revisioned saves, submit, heartbeat).
 */
export async function withNetworkRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isNetworkError(err) || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i + Math.random() * 300));
    }
  }
}

/** Download an authenticated file (e.g. the gradebook CSV) without exposing the token in a URL. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = `Download failed (${res.status}).`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
