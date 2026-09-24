import { defineConfig } from './src/index.ts';

/**
 * Config for the framework's own suite, which runs against the bundled fixture
 * app. Point `app.path` at your own bundle to test a real application.
 *
 * The fixture exists once per platform with identical labels, identifiers and
 * log lines, which is what lets `tests/` run unchanged on macOS and Windows.
 */
export default defineConfig({
  app: {
    // One path per platform: the Swift bundle on macOS, the WinForms twin on Windows.
    path: {
      darwin: 'fixtures/tray-app/DTFFixture.app',
      win32: 'fixtures/tray-app-win/bin/DTFFixture.exe',
    },
  },
  lifecycle: 'per-file',
  testMatch: ['tests/**/*.spec.ts'],
  retries: 1,
  screenshotOnFailure: true,
  cleanSlate: true,
});
