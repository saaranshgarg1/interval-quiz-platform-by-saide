import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('test bootstrap ignores an inherited database directory', () => {
  const inherited = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-isolation-sentinel-'));
  const sentinel = path.join(inherited, 'interval.db');
  const contents = 'Do not open or replace this inherited database.';
  fs.writeFileSync(sentinel, contents);
  let isolated: string | undefined;
  try {
    const bootstrap = new URL('./_env.ts', import.meta.url).href;
    const database = new URL('../db.ts', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
      await import(${JSON.stringify(bootstrap)});
      await import(${JSON.stringify(database)});
      console.log(JSON.stringify(process.env.INTERVAL_DATA_DIR));
    `], {
      env: { ...process.env, INTERVAL_DATA_DIR: inherited },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    isolated = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as string;
    assert.notEqual(isolated, inherited);
    assert.equal(path.dirname(isolated), os.tmpdir());
    assert.ok(path.basename(isolated).startsWith('interval-test-'));
    assert.ok(fs.existsSync(path.join(isolated, 'interval.db')));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), contents);
    assert.deepEqual(fs.readdirSync(inherited), ['interval.db']);
  } finally {
    fs.rmSync(inherited, { recursive: true, force: true });
    if (isolated && isolated !== inherited && path.dirname(isolated) === os.tmpdir()
        && path.basename(isolated).startsWith('interval-test-')) {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  }
});
