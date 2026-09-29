# Worktrace example suite

An OS-level suite for `com.worktrace.app`, written against the shipped build:
`/Applications/Worktrace.app` on macOS, and the per-user install at
`%LOCALAPPDATA%\Programs\Worktrace\Worktrace.exe` on Windows.

From the framework root, on either platform:

```bash
npm run example:worktrace
```

That is `node src/cli.ts run examples/worktrace`. On Windows, run `npm install`
first so the native helper builds (it needs the .NET 8 SDK; `npm run doctor`
checks everything), and make sure Worktrace is installed but **not already
running** — the suite launches its own instance.

On Windows the application-menu-bar test is skipped: an Electron menu lives
inside a window there, and this app opens none on boot.

## Why this exists alongside the Playwright suite

The Worktrace repo already has `e2e/launch-and-tray.spec.ts`. Its second test is
named **"tray icon is created and not destroyed after boot"** and asserts:

```ts
expect(appInfo.isReady).toBe(true);
expect(appInfo.appName).toBeTruthy();
expect(electronApp.process()?.killed).toBe(false);
```

All three still pass if `TrayService.create()` throws and no icon ever appears.
Playwright drives the renderer; the tray is not in the renderer. The same is true
of the notification banner, the permissions window's real on-screen text, and the
"app has no windows on boot" behaviour that defines this product.

This suite tests those from outside the process. The two suites are
complementary — keep both.

## Moving it into the Worktrace repo

Copy this directory to `~/work/screenpipe/dtf/` and change the imports in
`dtf.config.ts` and the specs from `'../../src/index.ts'` to `'@dhruvdabhi101/dtf'`. Paths in
the config resolve relative to the config file, so nothing else changes.

## Safety

These tests run against your **real signed-in profile**, because the interesting
menu states (signed in, discovery on, paused) are only reachable there. Nothing
in the default run signs out, toggles discovery, or quits.

The genuinely destructive cases — Sign Out, Quit — are `test.skip` with the
assertions written out. To run them, set `isolatedUserData: true` in the config
for a throwaway profile, and expect the unauthenticated menu
(`"Not logged in"` / `"Sign in"`) instead.

## Expected failures

Two tests fail against the current build. Both are real, both were found by
running this suite, and both are left failing on purpose rather than being
weakened into passing.

**1. `does not log an error during boot`**

```
[WARN] [SessionEncryption] Failed to decrypt session value {
  error: 'Error: safeStorage cannot be used before app is ready'
}
[INFO] [App] Electron app ready
```

Session decryption runs *before* `app.whenReady()`, so `safeStorage` is
unavailable and the stored session silently fails to decrypt on every launch.
Fix by deferring `SessionEncryption` until after the ready event.

**2. `the status item carries an accessibility label`**

The status item exposes no label at all:

```
AXTitle           ""
AXDescription     undefined
AXHelp            null
AXRoleDescription "status menu"
```

`tray.service.ts` calls `setToolTip("Worktrace - Recording" / "- Idle" /
"- Paused")`, but none of it reaches the accessibility layer in the shipped
build. VoiceOver announces an unlabelled button, and automation has to target the
icon positionally. Setting the tooltip after the image, or setting
`accessibilityLabel` on the status item, fixes it.

## A note on labels

The shipped `2.0.0-alpha.5` build renders different menu labels than
`main/helpers/menu-builders.ts` in the current source tree — for example
`"About Worktrace AI"` and `"Permissions"` where the source has `"Settings"`, and
`"Turn off AI discovery"` where the source has
`"Turn off AI Workflow Discovery"`. These tests pin what users actually get.
Point `app.path` at `dist/mac-arm64/Worktrace.app` to test a local build instead.
