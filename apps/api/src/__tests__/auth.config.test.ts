import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSecretsConfigured } from '../auth.js';

function withSecrets(env: Record<string, string | undefined>, check: () => void): void {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    check();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const strong = {
  NODE_ENV: 'production',
  INTERVAL_JWT_SECRET: 'synthetic-jwt-secret-for-configuration-test-only-123456',
  INTERVAL_PASSWORD_PEPPER: 'synthetic-pepper-for-configuration-test-only-654321',
};

test('production rejects missing, built-in, blank and short secrets', () => {
  for (const key of ['INTERVAL_JWT_SECRET', 'INTERVAL_PASSWORD_PEPPER']) {
    const fallback = key === 'INTERVAL_JWT_SECRET'
      ? 'interval-dev-jwt-secret-change-me'
      : 'interval-dev-pepper-change-me';
    for (const value of [undefined, '', ' '.repeat(40), fallback, `  ${fallback}  `, 'short-secret']) {
      withSecrets({ ...strong, [key]: value }, () => {
        assert.throws(assertSecretsConfigured, (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Refusing to boot/);
          assert.ok(err.message.includes(key));
          if (value?.trim()) assert.ok(!err.message.includes(value), 'Never print secret values');
          return true;
        }, `${key} must reject an insecure configuration`);
      });
    }
  }
});

test('production accepts independently configured long secrets', () => {
  withSecrets(strong, () => assert.doesNotThrow(assertSecretsConfigured));
});

test('development retains local secret defaults', () => {
  withSecrets({ NODE_ENV: 'development', INTERVAL_JWT_SECRET: undefined, INTERVAL_PASSWORD_PEPPER: undefined },
    () => assert.doesNotThrow(assertSecretsConfigured));
});
