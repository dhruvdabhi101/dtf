# Prompt: build the Windows driver

Paste everything below the line into Claude Code, running **on a Windows 10 or
11 machine** with this repository checked out. That machine needs Node 22.18+
(Node 24 recommended), the .NET 8 SDK (`winget install Microsoft.DotNet.SDK.8`),
Git, and an interactive desktop session. An RDP session works, but keep it
connected and do not minimise it, because a disconnected session has no
desktop to automate.

---

You're porting **dtf**, an OS-level end-to-end testing framework for desktop
apps, to Windows. It already works on macOS: it drives tray icons,
notifications, native dialogs, menus and windows through the OS accessibility
layer, records tests from real user input, and has a local web UI (the
Studio). Your job is to give it a Windows driver, so the same tests, the same
recorder and the same Studio work on Windows with no changes to the shared
code.

## Read these first, in this order

1. `README.md`: what the framework does and how tests read.
2. `docs/PROTOCOL.md`: **the contract you are implementing.** Every op, every
   result shape, every error code, and the recorder event format.
3. `docs/WINDOWS.md`: the Windows design: UIA→AX role mapping, tray, toasts,
   dialogs, input, recorder, fixture, and a checklist.
4. `src/drivers/driver.ts` (the interface), `src/drivers/macos.ts` (the
   reference driver, which is mostly one-line calls into the helper), and
   `src/core/rpc.ts` (the client you will reuse unchanged).
5. `native/macos/Sources/*.swift`: the reference helper. `Ops.swift` is the
   op dispatch; `Recorder.swift` is the recorder. Mirror their *behaviour*,
   including the hard-won details in the comments.
6. `fixtures/tray-app/main.swift`: the fixture app you will mirror.
7. `tests/*.spec.ts`: the acceptance suite. `tests/recorder.spec.ts` covers
   the recorder.

## What to build

1. **`native/windows/`**: a .NET 8 C# console helper,
   `dtfd-windows.exe`, that speaks the exact stdio JSON protocol in
   `PROTOCOL.md`. Use the raw UI Automation COM API, not
   `System.Windows.Automation`, for the reasons in `WINDOWS.md`. Include
   `build.ps1`, which publishes a self-contained single-file exe for the
   current architecture to `native/windows/bin/dtfd-windows.exe`.
   `scripts/postinstall.mjs` already calls it.
2. **`src/drivers/windows.ts`**: `export class WindowsDriver implements Driver`,
   shaped like `macos.ts`. `src/drivers/index.ts` already maps `win32` to this
   file and export name. It builds the helper on first use if the exe is
   missing, just as the macOS driver does.
3. **`fixtures/tray-app-win/`**: a WinForms (.NET 8) twin of the macOS fixture,
   with its own `build.ps1` that outputs `fixtures/tray-app-win/bin/DTFFixture.exe`
   (the path `dtf.config.ts` already uses for `win32`). Match `main.swift`
   exactly:
   - every tray menu title, including the submenu and the "Sign in" /
     "Signed in as …" swap
   - the window title `DTF Fixture`
   - every AutomationId (`btn-increment`, `counter-label`, `demo-field`,
     `btn-show-alert`, …)
   - the menu bar (File / Edit / Window with the same items)
   - every stdout line, byte for byte (`fixture-ready`, `count=N`,
     `alert-result=confirm|cancel`, `save-result=…`, `window-shown`,
     `window-hidden`, `deeplink-received url=…`, `auth-success user=…`, …)
   - the close-to-tray behaviour
   - the `dtffixture://` URL scheme (register it under `HKCU\Software\Classes`
     on first launch)
   - notifications posted as real Windows toasts. An unpackaged app needs an
     AppUserModelID and a Start-menu shortcut, or
     `Microsoft.Toolkit.Uwp.Notifications`' desktop compat helpers.

   On Windows, the "sheet" alert becomes a modal MessageBox or form owned by
   the main window.

## How to work

Build bottom-up and prove each layer before moving on. At every checkpoint,
run the listed command and fix what fails before continuing.

1. **Helper skeleton.** Stdio loop, `ready` event, `ping`, `gc`, `shutdown`,
   `app.*`, `tree`, `find`, `exists`, and the `AXNode` serialisation with the
   role mapping. Write a tiny script that spawns the helper through
   `NativeHelper` and dumps `tree` for Notepad. Check that roles come out as
   `AXButton`/`AXTextField`/… and that rects line up with what you see on a
   scaled display.
2. **Driver + doctor.** `windows.ts`, including `preflight()` with Focus Assist.
   Checkpoint: `npx dtf doctor` is all green or amber, with no red.
3. **Fixture.** Build it; `npx dtf inspect tree --name "DTF Fixture"` shows the
   ids above.
4. **Elements, input, windows, menu bar.** Checkpoint:
   `npx dtf run tests --file tests/window-and-menu.spec.ts`.
5. **Tray.** Checkpoint: `tests/tray.spec.ts`. Test with the icon both
   visible and in the overflow flyout.
6. **Dialogs and file dialogs.** Checkpoint: `tests/dialogs.spec.ts`.
7. **Toasts.** Checkpoint: `tests/notifications.spec.ts`.
8. **Browser handoff and deep links** (`openUrl`, `defaultUrlHandler`,
   `appPathForBundleId`, `browserUrlViaScript`: read the URL from the
   browser's address bar through UIA). Checkpoint: `tests/auth.spec.ts`.
9. **Permissions** (ConsentStore). Checkpoint: `tests/permissions.spec.ts`.
10. **Recorder.** Low-level hooks on their own message-loop thread, the
    `surface` rules from `WINDOWS.md`, pick-mode swallowing, and
    injected-event filtering. Checkpoint: `tests/recorder.spec.ts`. Then do it
    by hand: `npx dtf studio`, record a flow against the fixture (tray menu,
    button, typing, a menu-bar item, a dialog button), save it, and run it
    from the Tests tab.
11. **Full suite**, twice in a row, on Windows 11, and on Windows 10 if you can
    get one: `npx dtf run tests`. Then `npm run typecheck` and
    `npm run test:unit`.
12. **CI.** Add a `windows-latest` job to `.github/workflows/ci.yml` for
    typecheck and unit tests. Add a self-hosted Windows GUI job, mirroring
    `desktop-tests.yml`, for the OS suite.

## Rules

- **Do not change the shared layers to suit Windows.** That means
  `src/surfaces`, `src/runner`, `src/recorder`, `src/studio`, `src/core` and
  `src/types.ts`. If the contract is genuinely wrong or missing something,
  make the smallest change, keep macOS behaviour identical, update
  `docs/PROTOCOL.md`, and call it out in your summary. Platform `if`s in
  shared code are a last resort.
- **Keep the AX role vocabulary.** Windows roles are translated in the helper,
  never in tests.
- **Never weaken a test to make it pass.** If a test covers a behaviour that
  does not exist on Windows (macOS sheets, `tccutil`), guard it with an
  explicit `process.platform` check and a comment explaining why. Otherwise
  fix the driver.
- **Never block the input hook callback**, and give UIA calls into other
  processes timeouts. A hung app under test must not hang the helper or the
  user's mouse.
- **Coordinates are logical pixels, top-left origin, virtual-desktop space**,
  in both directions.
- Match the existing code style: comments explain *why* something is done a
  particular way (especially OS quirks you discover), not what the next line
  does. Record any quirks you hit in `WINDOWS.md`, the way the README's
  "two bugs worth knowing about" section does for macOS.
- Leave the macOS side untouched and working.

## When you're done

Update `README.md` (Status, Install, and a Windows note wherever macOS-only
behaviour is described) and tick off the checklist in `docs/WINDOWS.md`. Then
report:
- the exact commands you ran and their results (the pass/fail counts for
  `dtf run tests`, `npm run typecheck` and `npm run test:unit`)
- which Windows versions you verified on
- every change you made outside `native/windows`, `src/drivers/windows.ts` and
  `fixtures/tray-app-win`, with a reason for each
- anything skipped or only partly working, and why
