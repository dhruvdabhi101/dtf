import { defineConfig } from './src/index.ts';

/**
 * Config for the framework's own suite, which runs against the bundled fixture
 * app. Point `app.path` at your own bundle to test a real application.
 */
export default defineConfig({
  app: {
    path: 'fixtures/tray-app/DTFFixture.app',
  },
  lifecycle: 'per-file',
  testMatch: ['tests/**/*.spec.ts'],
  retries: 1,
  screenshotOnFailure: true,
  cleanSlate: true,
});
