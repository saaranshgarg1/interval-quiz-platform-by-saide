import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('demo seed refuses production without creating demo users or courses', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-seed-safety-'));
  try {
    const result = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../seed.ts', import.meta.url)),
    ], {
      env: { ...process.env, NODE_ENV: 'production', INTERVAL_DATA_DIR: directory },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to seed demo accounts in production/);
    const restored = new DatabaseSync(path.join(directory, 'interval.db'), { readOnly: true });
    try {
      for (const table of ['users', 'courses']) {
        const row = restored.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        assert.equal(row.n, 0);
      }
    } finally {
      restored.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
