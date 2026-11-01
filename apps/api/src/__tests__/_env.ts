import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Imported first by every test file: point the API at a throwaway database so
 * test runs never touch (or depend on) the developer's seeded data.
 */
// Never inherit a developer/production path from the shell or CI environment.
process.env.INTERVAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-test-'));
