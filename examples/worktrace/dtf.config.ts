import { defineConfig } from '../../src/index.ts';

/**
 * dtf config for Worktrace (com.worktrace.app).
 *
 * To move this suite into the Worktrace repo, copy this directory to
 * `~/work/screenpipe/dtf/` and change the import above to `'@dhruvdabhi101/dtf'`. Paths below
 * resolve relative to this file, so nothing else needs editing.
 */
export default defineConfig({
  app: {
    // The shipped build: the macOS bundle, and the per-user NSIS install on
    // Windows. Point at `dist/mac-arm64/Worktrace.app` or
    // `dist/win-unpacked/Worktrace.exe` to test a local build instead.
    path: {
      darwin: '/Applications/Worktrace.app',
      win32: '%LOCALAPPDATA%\\Programs\\Worktrace\\Worktrace.exe',
    },

    // Worktrace is a tray app that signs you in and records. These tests run
    // against your REAL profile so the signed-in states are reachable at all.
    // For a true first-run suite, switch this on to get a throwaway profile —
    // and expect the unauthenticated menu instead.
    isolatedUserData: false,
    // userDataArg: '--user-data-dir=',

    // Electron apps with a bootstrap phase take a moment to register.
    timeoutMs: 30_000,
  },

  // One launch per file. Worktrace takes several seconds to boot, and these
  // tests do not mutate state, so per-test isolation is not worth the cost.
  lifecycle: 'per-file',

  testMatch: ['*.spec.ts'],
  retries: 1,
  screenshotOnFailure: true,
  artifactsDir: 'dtf-artifacts',
});
