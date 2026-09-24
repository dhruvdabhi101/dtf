# Porting dtf to Windows

The Windows driver is **designed but not implemented**. `createDriver()` throws a
clear error on `win32` today rather than shipping code that has never been run.

This document is the specification for filling it in. Everything above the
`Driver` interface — surfaces, locators, runner, assertions, reporting, the AI
checker — is already platform-agnostic and needs no changes.

## Shape of the work

Mirror `src/drivers/macos.ts` and `native/macos/`:

```
native/windows/
  build.ps1                 # dotnet publish, or csc for a single file
  Program.cs                # same newline-delimited JSON protocol over stdio
src/drivers/windows.ts      # implements Driver, spawns the helper
```

The helper speaks the **identical protocol** the macOS one does — one JSON
request per line, one JSON response per line. Keeping it identical means
`src/core/rpc.ts` is reused verbatim.

Use **.NET with UIAutomation** (`System.Windows.Automation`, or the newer
`Microsoft.UI.UIAutomation`). Prefer the raw UIA COM interfaces over the managed
`AutomationElement` wrapper: the wrapper's caching behaviour causes exactly the
class of staleness bug documented in the README.

## Mapping the surfaces

### Accessibility tree

UIA is the direct analogue of the macOS accessibility API. Map the properties the
framework's `AXNode` already expects:

| `AXNode` field | UIA property |
|---|---|
| `role` | `ControlType` (`Button`, `Edit`, `MenuItem`, `Window`, …) |
| `title` | `Name` |
| `identifier` | `AutomationId` — the most stable selector on Windows |
| `value` | `ValuePattern.Value` |
| `description` | `HelpText` / `FullDescription` |
| `enabled` | `IsEnabled` |
| `rect` | `BoundingRectangle` |
| `actions` | derived from supported patterns (`Invoke`, `Toggle`, `ExpandCollapse`) |

Normalise control types to the same `AX*` role names the selector DSL already
aliases (`button` → `AXButton`), so tests are portable across platforms.

For actions, prefer the UIA pattern (`InvokePattern.Invoke()`) and fall back to a
synthetic click via `SendInput`, matching what `Locator.click` already does.

### Tray — the notification area

The hard one, and structurally different from macOS. Tray icons do **not** belong
to the owning app: they are buttons inside Explorer's toolbar.

- Visible icons: `Shell_TrayWnd` → `TrayNotifyWnd` → `SysPager` →
  `ToolbarWindow32`
- Overflow ("show hidden icons"): `NotifyIconOverflowWindow` → `ToolbarWindow32`
  On Windows 11 this moved; enumerate both and merge.

Two viable approaches:

1. **UIA over Explorer.** Walk the `Shell_TrayWnd` element tree and read each
   button's `Name` (which is the tooltip text the app set). Simplest, and enough
   for most tests.
2. **`TB_GETBUTTON` via `SendMessage`.** Read `TBBUTTON` structs out of Explorer's
   address space with `ReadProcessMemory` to get the owning `hWnd` and therefore
   the owning **process id**. More work, but it is the only way to reliably answer
   "is this tray icon *mine*?" — which `TraySurface.list()` needs, since it is
   scoped to the app under test.

Implement (1) first and match on the tooltip; add (2) when you need pid scoping.

Opening the menu: send a synthetic right-click (or left, per the app) to the
icon's rect, then find the resulting `#32768` context-menu window. Note the
Electron caveat — a tray context menu on Windows [is not keyboard
navigable](https://github.com/electron/electron/issues/11587) — so drive it with
clicks or UIA invokes rather than arrow keys.

Return the same `{ kind: 'menu' | 'window', root }` shape `trayOpen` produces on
macOS and `TrayPopup` works unchanged.

### Notifications — toasts

Two complementary sources:

- **Live, on screen:** the toast is a UIA element under
  `Windows.UI.Core.CoreWindow` owned by `ShellExperienceHost.exe` (Windows 10) or
  `ShellHost.exe` / the notification host (Windows 11). Walk it for the title,
  body and action buttons — the direct equivalent of the macOS approach, and it
  needs no special privileges.
- **History:** `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`, a
  SQLite database. Richer, but the payload is XML inside the `Notification` table
  and the file is locked while `WpnUserService` is running — copy it first.

Prefer the UIA route for the same reason macOS does: it reflects what the user
actually saw, and Focus Assist suppression is visible rather than silent.

**Add a Focus Assist check to `dtf doctor`** — it is the Windows equivalent of Do
Not Disturb and will silently break every notification test.

### Dialogs and file pickers

Simpler than macOS. A native dialog is a top-level window with class `#32770`,
normally in the app's own process. Detect it by window class and report it as
`kind: 'dialog'`.

Modern file pickers (`IFileDialog`) are also `#32770` and identifiable by their
`AutomationId` (`FileNameControlHost`, `DUIViewWndClassName` in the tree). Map
those to `kind: 'filePanel'` so `DialogHandle.setFilePath` can type into the
filename field directly — no Windows equivalent of the Cmd+Shift+G trick is
needed.

There is no macOS-style sheet; `kind: 'sheet'` simply never occurs.

### Permissions

Windows has no unified TCC. The pieces map roughly:

- **Capability access** (camera, microphone, location) lives in the registry
  under `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\<capability>`.
  Unlike macOS's SIP-protected `TCC.db`, these values are **writable**, so
  `resetPermission` can genuinely reset *and* pre-grant. Say so in the
  `PermissionSurface` docs when you implement it, since it is strictly more
  capable than the macOS behaviour.
- **UAC elevation prompts** are on the secure desktop and cannot be automated at
  all. Have `answerPrompt` throw a clear `UnsupportedError` for those rather than
  hanging.

### Input and screenshots

- Input: `SendInput` for mouse and keyboard. Reuse the same `"cmd+shift+n"` combo
  syntax, mapping `cmd` → `ctrl` so shared tests stay readable.
- Screenshots: `PrintWindow` for a single window (works for occluded windows,
  unlike BitBlt), or the Graphics Capture API for full-screen. No permission
  prompt is involved, so `checkScreenRecordingPermission` returns `granted: true`.

## Checklist

- [ ] `native/windows/Program.cs` — stdio JSON loop, same op names
- [ ] Tree, find, element actions via UIA
- [ ] Tray enumeration + open (Explorer toolbar)
- [ ] Toast reading via UIA; Focus Assist check in `doctor`
- [ ] Dialog / file picker detection by window class + AutomationId
- [ ] `SendInput` mouse and keyboard; `PrintWindow` screenshots
- [ ] ConsentStore read/write for permissions
- [ ] `src/drivers/windows.ts` implementing `Driver`
- [ ] Register it in `createDriver()` in `src/runner/run.ts`
- [ ] Port `fixtures/tray-app` to a WinForms/WPF equivalent and run the same suite

The last item is the real acceptance test: the specs in `tests/` should pass
unchanged apart from platform-specific labels.
