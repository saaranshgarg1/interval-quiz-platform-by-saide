import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { googleSignInConfig, verifyGoogleIdToken } from '../services/google-sso.js';
import { AppError } from '../auth.js';

// A bad Google credential must be a clean client error, never a 500.

function rejectsWith(status: number, message: string) {
  return (err: unknown) => err instanceof AppError && err.status === status && err.message === message;
}

test('google sso: unconfigured client ID reports 503', async () => {
  const saved = process.env.INTERVAL_GOOGLE_CLIENT_ID;
  delete process.env.INTERVAL_GOOGLE_CLIENT_ID;
  try {
    await assert.rejects(verifyGoogleIdToken('anything'), rejectsWith(503, 'Google sign-in is not configured.'));
  } finally {
    if (saved !== undefined) process.env.INTERVAL_GOOGLE_CLIENT_ID = saved;
  }
});

test('google sso: malformed token reports 401, not a server error', async () => {
  const saved = process.env.INTERVAL_GOOGLE_CLIENT_ID;
  process.env.INTERVAL_GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  try {
    await assert.rejects(verifyGoogleIdToken('not-a-real-token'), rejectsWith(401, 'Invalid Google ID token.'));
  } finally {
    if (saved === undefined) delete process.env.INTERVAL_GOOGLE_CLIENT_ID;
    else process.env.INTERVAL_GOOGLE_CLIENT_ID = saved;
  }
});

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('google config: off with a reason when no client ID is set', () => {
  withEnv({ INTERVAL_GOOGLE_CLIENT_ID: undefined, INTERVAL_GOOGLE_ORIGINS: undefined }, () => {
    const c = googleSignInConfig('https://example.test');
    assert.equal(c.enabled, false);
    assert.equal(c.client_id, null);
    assert.ok(c.reason);
  });
});

test('google config: only enabled for listed origins when an origin list is set', () => {
  withEnv(
    { INTERVAL_GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', INTERVAL_GOOGLE_ORIGINS: 'http://localhost:4000, https://Quiz.Example.test/' },
    () => {
      assert.equal(googleSignInConfig('https://quiz.example.test').enabled, true);
      assert.equal(googleSignInConfig('http://localhost:4000').enabled, true);
      const other = googleSignInConfig('https://new-tunnel.trycloudflare.com');
      assert.equal(other.enabled, false);
      assert.match(other.reason ?? '', /not enabled for this web address/);
      assert.equal(googleSignInConfig(undefined).enabled, false);
    },
  );
});

test('google config: any origin allowed when no origin list is set', () => {
  withEnv({ INTERVAL_GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', INTERVAL_GOOGLE_ORIGINS: undefined }, () => {
    const c = googleSignInConfig('https://anything.test');
    assert.equal(c.enabled, true);
    assert.equal(c.client_id, 'cid.apps.googleusercontent.com');
    assert.equal(c.allowed_domain, 'iitrpr.ac.in');
  });
});
