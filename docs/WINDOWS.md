# Porting dtf to Windows

The Windows driver is **designed but not implemented**. `createDriver()` looks
for `src/drivers/windows.ts` and reports a clear "no driver for win32" error
until it exists. Nothing crashes.

This document is the design. [`WINDOWS_PROMPT.md`](WINDOWS_PROMPT.md) is a
ready-to-run brief for doing the port with Claude Code on a Windows machine.
[`PROTOCOL.md`](PROTOCOL.md) is the exact contract the native helper
implements.

## What is already platform-neutral

Everything above the `Driver` interface works unchanged on Windows:

- surfaces, locators and assertions (`src/surfaces/`, `src/core/`)
- the runner, reporters (pretty, JSON, JUnit) and `dtf list`
- the **recorder**: step building, selector generation and codegen
  (`src/recorder/`). It consumes the platform-neutral `RecordedEvent` shape.
- the **Studio** UI and server (`src/studio/`)
- `dtf doctor`: generic checks plus whatever the driver's `preflight()` returns
- config: `app.path` can be `{ darwin: '…/My.app', win32: '…\\My.exe' }`
- key combos: `mod+s` means Cmd+S on macOS and Ctrl+S on Windows, and the
  recorder writes `mod` for either

The port is **one TypeScript class plus one native helper**, as it was for
macOS.

```
native/windows/
  DtfHelper.csproj          # .NET 8, self-contained single-file publish
  Program.cs                # stdio JSON loop — same protocol as dtfd-macos
  Uia.cs, Tray.cs, Toasts.cs, Dialogs.cs, Input.cs, Recorder.cs, ...
  build.ps1                 # dotnet publish → native/windows/bin/dtfd-windows.exe
src/drivers/windows.ts      # class WindowsDriver implements Driver
fixtures/tray-app-win/      # the Windows twin of fixtures/tray-app
```

## Helper technology

Use **.NET 8 (C#) and the raw UI Automation COM API** (`IUIAutomation`, via
`Interop.UIAutomationClient` or a hand-written COM import), not the managed
`System.Windows.Automation` wrapper. The wrapper caches aggressively and goes
stale in exactly the ways the README's "two bugs" section describes. Use
`CacheRequest` deliberately where it helps performance, never implicitly.

Process requirements:

- **Per-Monitor V2 DPI aware** (manifest or `SetProcessDpiAwarenessContext`).
  Without it, every rect and click coordinate is wrong on scaled displays.
  The protocol uses logical pixels; convert with each monitor's scale.
- **COM on an MTA thread** for UIA calls, with the stdio loop on its own
  thread. UIA calls into a hung app block, so give them timeouts
  (`IUIAutomation2.ConnectionTimeout` / `TransactionTimeout`).
- **Integrity level at least that of the app under test.** UIPI blocks
  `SendInput` and UIA writes from a medium-integrity process into an elevated
  app. `perm.accessibility` should report `trusted: false`, with a clear
  message, when the target is elevated and the helper is not.
- Publish **self-contained, single-file** for `win-x64` and `win-arm64`, so
  users need no .NET runtime. `build.ps1` builds for the current architecture.

## Mapping the accessibility tree

`AXNode.role` keeps the **macOS AX names on every platform**. The selector DSL
(`button` → `AXButton`), the recorder and every existing test use them, so a
test written on one OS runs on the other.

| UIA ControlType | `role` | Notes |
|---|---|---|
| Button, SplitButton | `AXButton` | |
| CheckBox | `AXCheckBox` | |
| RadioButton, TabItem | `AXRadioButton` | TabItem → subrole `AXTabButton` |
| Edit | `AXTextField` | multi-line (`IsMultiline` via TextPattern) → `AXTextArea` |
| Document | `AXTextArea` | Chromium content areas → `AXWebArea` |
| Text | `AXStaticText` | put `Name` in **`value`** too, as AppKit does |
| Window | `AXWindow` | dialogs: subrole `AXDialog` |
| Menu | `AXMenu` | |
| MenuBar | `AXMenuBar` | |
| MenuItem | `AXMenuItem` | a MenuItem directly in a MenuBar → `AXMenuBarItem` |
| Group, Pane, Custom | `AXGroup` | |
| List / ListItem | `AXList` / `AXRow` | |
| DataGrid, Table / DataItem | `AXTable` / `AXRow` | |
| Tree / TreeItem | `AXOutline` / `AXRow` | |
| ComboBox | `AXPopUpButton` | |
| Slider | `AXSlider` | |
| ScrollBar | `AXScrollBar` | |
| Image | `AXImage` | |
| Hyperlink | `AXLink` | |
| ToolBar | `AXToolbar` | |
| ProgressBar | `AXProgressIndicator` | |
| TitleBar | `AXTitleBar` | |
| anything else | `AX` + ControlType name | still selectable by raw role |

| `AXNode` field | UIA property |
|---|---|
| `title` | `Name` |
| `identifier` | `AutomationId`. The most stable selector on Windows. Drop purely numeric ids (Win32 control ids); the recorder already ignores them. |
| `value` | `ValuePattern.Value`, else `RangeValuePattern.Value`, else toggle state as a boolean |
| `description` | `HelpText`, else `FullDescription` |
| `help` | `ItemStatus` or the tooltip, where available |
| `placeholder` | Edit controls' cue banner (`EM_GETCUEBANNER` for Win32; `PlaceholderText` for XAML) |
| `enabled` / `focused` / `selected` | `IsEnabled` / `HasKeyboardFocus` / `SelectionItemPattern.IsSelected` |
| `rect` | `BoundingRectangle`, converted to logical pixels |
| `actions` | `AXPress` if Invoke, Toggle, SelectionItem or ExpandCollapse is supported; also `AXShowMenu` if ExpandCollapse is supported |

`element.action AXPress` tries, in order: `InvokePattern.Invoke`,
`TogglePattern.Toggle`, `SelectionItemPattern.Select`, then
`ExpandCollapsePattern.Expand`. `Locator.click` falls back to a real
`SendInput` click on its own.

## Tray: the notification area

Tray icons are not part of the owning app's UI tree. They are buttons inside
Explorer.

- **Windows 11:** `Shell_TrayWnd` → the XAML taskbar. Visible icons live under
  the `SystemTrayIcon` elements; hidden ones are in the overflow flyout
  (`TopLevelWindowForOverflowXamlIsland`), which only has a tree while it is
  open. Open it with the chevron ("Show hidden icons") and enumerate again.
- **Windows 10:** `Shell_TrayWnd` → `TrayNotifyWnd` → `SysPager` →
  `ToolbarWindow32` for visible icons, and `NotifyIconOverflowWindow` →
  `ToolbarWindow32` for overflow.

Each icon's UIA `Name` is the tooltip text the app set with
`NOTIFYICONDATA.szTip`. That becomes `label`.

**Owning pid.** `tray.list(pid)` must return only the app under test's icons.
UIA does not say which process owns a tray icon, so:

1. Match by the app's tooltip text (quick and good enough to start with), or
2. **Better:** on Windows 10, read `TBBUTTON.dwData` → `TRAYDATA.hwnd` from
   Explorer with `ReadProcessMemory`, then `GetWindowThreadProcessId`. On
   Windows 11 there is no toolbar, so use `Shell_NotifyIconGetRect` with the
   app's `NOTIFYICONIDENTIFIER` (hwnd + uID, found by enumerating the app's
   top-level message windows) to get each icon's rect, and match by rect.

**Opening.** Send a real click to the icon's centre (`useMouse` is effectively
always on). Then wait for either:

- a **menu**: a `#32768` popup (Win32 `TrackPopupMenu`, owned by the app's
  process) or a WinForms/WPF `ContextMenuStrip`/`ContextMenu` window (UIA
  ControlType `Menu`), or
- a **window**: a new top-level window of the app (a flyout or popover).

Return `{ kind, root }` exactly like `trayOpen` on macOS. Electron's tray menus
[do not respond to the keyboard](https://github.com/electron/electron/issues/11587),
so drive them with clicks or UIA invokes.

## Notifications: toasts

- **Live:** a toast is a top-level window of class
  `Windows.UI.Core.CoreWindow` titled "New notification" and owned by
  `ShellExperienceHost.exe` (Windows 10/11). Windows 11 23H2+ may use the
  `ShellHost` notification host instead, so find it by class name and window
  title rather than by process name. Walk it for the attribution (app name),
  title, body and action buttons.
- **Action Center:** opened with `Win+N`. Useful for `listAll`, but the
  framework asserts on what the user saw, which is the banner.
- **History:** `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`
  (SQLite, locked while WpnUserService runs, so copy it first). Worth a
  fallback for "was it posted at all" when a banner has already expired.

Add a **Focus Assist / Do Not Disturb** check to `preflight()`. Read
`HKCU\Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.notifications.quiethourssettings`,
or, on Windows 11, the `NOC_GLOBAL_SETTING_TOASTS_ENABLED` value under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings`.
It is the Windows equivalent of macOS Do Not Disturb and will silently break
every notification test.

## Dialogs and file pickers

A Win32 dialog is a top-level window of class `#32770`. `MessageBox` is also
`#32770` with a `Static` text child: report it as `kind: 'messageBox'`, or as
`dialog` when you cannot tell. WinForms and WPF modal windows are ordinary
windows that are **owned** by the app's main window (`GetWindow(GW_OWNER)`) and
modal (the owner is disabled). Report those as `dialog` too.

Common file dialogs (`IFileOpenDialog` / `IFileSaveDialog`) are `#32770` with a
`DirectUIHWND` and the file-name `ComboBox`/`Edit` (AutomationId `1148` or
`FileNameControlHost`). Report them as `kind: 'filePanel'`. They live in the
app's own process, unlike a sandboxed macOS app's panels.
`DialogHandle.setFilePath` should type straight into the file-name field; no
equivalent of macOS's Cmd+Shift+G is needed.

There are no sheets on Windows; `kind: 'sheet'` never occurs.

## Permissions

- **Capability access** (camera, microphone, location, etc.) lives under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\<capability>`
  (with a `NonPackaged` subkey for desktop apps). Unlike macOS's
  SIP-protected `TCC.db`, these values are **writable**, so `resetPermission`
  can genuinely reset and even pre-grant. Document this in
  `PermissionSurface`, since it is more capable than on macOS.
- **UAC prompts** run on the secure desktop and cannot be automated. Detect
  them (`consent.exe` running) and fail with `UnsupportedError`; never hang.

## Input and screenshots

- `SendInput` for mouse and keyboard. Use absolute coordinates normalised to
  the virtual desktop (`MOUSEEVENTF_VIRTUALDESK`). Tag every synthesised event
  with a helper-specific `dwExtraInfo` so the recorder can ignore its own
  input.
- Key combos: `mod` → Ctrl, `cmd`/`meta`/`win` → Windows key, `alt`/`option`
  → Alt. `type` uses `KEYEVENTF_UNICODE` so any character works.
- Foreground: `SetForegroundWindow` is refused unless the caller "owns" the
  foreground. `app.activate` should use `AllowSetForegroundWindow`, or the
  known Alt-key-tap workaround, then verify with `GetForegroundWindow`.
- Screenshots: `PrintWindow(hwnd, PW_RENDERFULLCONTENT)` for one window, which
  also works when it is occluded. Use `Graphics.CopyFromScreen` or the
  Graphics Capture API for the full screen. No permission is involved, so
  `perm.screenRecording` returns `granted: true`.

## Recorder

Same contract as macOS (`PROTOCOL.md` → Recording).

- Install `WH_MOUSE_LL` and `WH_KEYBOARD_LL` with `SetWindowsHookEx` on a
  **dedicated thread that runs a message loop**. Low-level hooks are called
  on the installing thread's message loop.
- The hook procedure must return within `LowLevelHooksTimeout` (about 300ms by
  default), or Windows silently removes the hook (Windows 7 and later). Copy
  the event and post it to a worker queue; resolve UIA there. This is the same
  rule as the macOS tap.
- Resolve the element with `IUIAutomation.ElementFromPoint` on mouse-down.
  Decide `surface` by walking ancestors and top-level window classes:

  | surface | Windows signal |
  |---|---|
  | `tray` | the element is inside `Shell_TrayWnd`'s notification area / overflow flyout and is one of the app's icons |
  | `trayMenu` | inside a `#32768` or ControlType `Menu` popup that opened after a tray click |
  | `menuBar` | an ancestor has ControlType `MenuBar` (a MenuItem under it, or a `#32768` dropped down from it) |
  | `contextMenu` | any other `Menu` popup |
  | `notification` | inside the toast window described above |
  | `dialog` | the top-level window is `#32770`, or a modal owned window |
  | `window` | anything else |

- **Pick mode:** return non-zero from the mouse hook for the armed
  `WM_LBUTTONDOWN` and its matching `WM_LBUTTONUP` to swallow them.
- **Keys:** `ToUnicodeEx` with the foreground thread's keyboard layout gives
  `text`. Do not call it on dead keys in a way that disturbs the user's
  composition state: pass `wFlags = 0x4` on Windows 10 1607+. `pid` is the
  foreground window's process, and `focus` comes from
  `IUIAutomation.GetFocusedElement`.
- Ignore injected events that carry the helper's own `dwExtraInfo` marker.

## The fixture

`fixtures/tray-app-win/` is a small **WinForms (.NET 8)** app that mirrors
`fixtures/tray-app/main.swift` exactly: the same tray menu titles and submenu,
the same window title (`DTF Fixture`), the same control AutomationIds
(`btn-increment`, `counter-label`, `demo-field`, …), the same menu bar, the
same stdout log lines (`fixture-ready`, `count=N`, `alert-result=…`), and the
same `dtffixture://` deep link scheme registered per user.

The shared specs in `tests/` are the acceptance test. They should pass on
Windows unchanged. The exceptions are behaviours that genuinely do not exist
on Windows (sheets, `tccutil`); guard those with an explicit
`process.platform` check and a comment saying why. Never weaken an assertion
to make it pass.

## Checklist

- [ ] `native/windows/`: stdio JSON loop implementing every op in `PROTOCOL.md`
- [ ] Tree / find / element actions via raw UIA COM, roles mapped to AX names
- [ ] Tray enumeration (Windows 10 and 11), pid scoping, open → `{kind, root}`
- [ ] Toast reading and actions; Focus Assist in `preflight()`
- [ ] Dialog / file dialog detection by class, ownership and AutomationId
- [ ] `SendInput` mouse and keyboard with `mod` → Ctrl; foreground handling
- [ ] Screenshots (`PrintWindow` + full screen)
- [ ] ConsentStore read / reset for permissions; UAC detection
- [ ] Recorder: low-level hooks, surfaces, pick mode, injected-event filtering
- [ ] `src/drivers/windows.ts` implementing `Driver` (the factory in `src/drivers/index.ts` already points at it)
- [ ] `native/windows/build.ps1` (the postinstall script already calls it)
- [ ] `fixtures/tray-app-win/` mirroring the macOS fixture
- [ ] `npm run typecheck`, `npm run test:unit`, `dtf doctor`, then `dtf run tests` green on Windows 10 and 11
- [ ] A `windows-latest` job in `.github/workflows/ci.yml` running typecheck and unit tests, plus a self-hosted Windows job running `dtf run tests`
