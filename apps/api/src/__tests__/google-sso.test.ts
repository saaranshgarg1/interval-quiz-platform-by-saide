import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyGoogleIdToken } from '../services/google-sso.js';
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
