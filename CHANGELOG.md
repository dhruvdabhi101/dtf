# Changelog

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
