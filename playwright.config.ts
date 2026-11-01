import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Lab 8 end-to-end regression harness.
 *
 * Confirms the two P0 defects documented in the Lab 7 usability report are fixed:
 *   1. Students can see published quizzes on their dashboard (authz regression).
 *   2. Adding a question in the editor does not detach the form (state regression).
 *
 * Uses the system Chromium (Ubuntu 24.04) rather than a downloaded browser so the
 * suite runs offline. Point PW_WEB / PW_API at the dev servers before running.
 */
const WEB = process.env.PW_WEB ?? 'http://localhost:5173';
// System Chromium on Linux; elsewhere (Windows/macOS) use Playwright's bundled browser.
const CHROMIUM = process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: CHROMIUM ? { executablePath: CHROMIUM } : {},
      },
    },
  ],
});
