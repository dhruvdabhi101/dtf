# Changelog

## Unreleased

### Added
- `dtf permissions status|grant|deny|reset <service…>`: change an app's privacy
  grants before it launches, for CI.
- `grantPermissions` / `denyPermissions` config, applied before every launch.
- macOS `permissions.grant()` / `deny()` where TCC.db is writable (SIP off and
  root). Elsewhere they fail with an explanation instead of "not implemented".
- `dtf doctor` reports whether this machine can grant permissions.
- `desktop-tests-macos-hosted.yml`: the OS suite on GitHub-hosted Macs, plus an
  opt-in Worktrace permissions job.

### Fixed
- Permission reads for Screen Recording, Accessibility, Input Monitoring and
  Full Disk Access used the per-user TCC.db; those grants are in the system
  one, so they always read 'unset'.
- `resetPermissions` launched the app to learn its bundle id, which could
  trigger the very prompt under test, and swallowed reset errors.
- `ci-setup-macos.sh` wrote Microphone grants to the system TCC.db, where macOS
  ignores them.
- The Worktrace permission test accepted any status. It now checks the app's
  window against the OS grants.

## 0.2.0

### Added
- **Studio** (`dtf studio`): a local web UI with a test explorer and live runs,
  a recorder, an accessibility inspector with on-screen picking, run history
  with failure artifacts, and environment checks.
- **Recorder**: turns real mouse and keyboard input into readable specs.
  Selectors are checked against the live UI, shortcuts are recorded as
  portable `mod+…` combos, and assertions come from a pick mode that swallows
  the click. It also suggests checks for notifications, dialogs and windows
  that appear while you record. Available in the Studio and as `dtf record`.
- `dtf list`: lists every declared test with its line number, without running
  anything.
- `dtf run --file … --line …`: runs exactly one test.
- Reporters: JUnit XML (`junit`), a JSON event stream (`stream`), and several
  reporters combined (`--reporter pretty,junit`).
- `attach` config and `--attach-pid`: run tests against an already-running
  app, which is left running afterwards.
- Per-platform app paths: `app.path: { darwin, win32 }`. Paths expand `~`,
  `%VAR%` and `$VAR`, so a config can target a per-user install such as
  `%LOCALAPPDATA%\Programs\…` without hard-coding a user name.
- The Worktrace example runs on Windows too: `npm run example:worktrace`.
- The `mod` key modifier: Cmd on macOS, Ctrl on Windows.
- Graceful cancellation: Ctrl+C, or cancelling from the Studio (over IPC, which
  works on every platform), finishes the current test and closes the app.
- `docs/PROTOCOL.md`: the complete native helper contract, including the
  recorder's event format.
- `docs/WINDOWS_PROMPT.md`: a brief for building the Windows driver.
- Unit tests for the platform-neutral core, and a cross-platform CI workflow.

### Changed
- Drivers are loaded through a platform registry (`src/drivers/index.ts`), so
  a new platform needs no changes to the shared code.
- `dtf doctor` combines generic checks with each driver's own `preflight()`.
- Runner results carry the test's line number, the number of attempts, and a
  serialisable error.

### Fixed
- The clean-slate step between tests pressed Escape at *other apps'* dialogs.
  On a machine with an updater or a dictation overlay open, that took about
  20 seconds per test and interfered with those apps. It now dismisses only
  the app under test's own dialogs, using each dialog's cancel button.
- `permissions.shouldNotPrompt()` treated any dialog on screen from any app as
  a permission prompt. Prompts must now be new, and must either belong to the
  app or carry real consent buttons.
- The native helper respawns if it dies, instead of failing every later call.
