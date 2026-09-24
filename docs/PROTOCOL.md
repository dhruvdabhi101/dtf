# Native helper protocol

Every platform driver is a thin TypeScript class (`src/drivers/<platform>.ts`)
in front of a long-lived native helper process. This document is the contract
between the two. The macOS helper (`native/macos/`, Swift) implements it today.
A Windows helper must implement the same thing, and nothing above the driver
has to change.

`src/core/rpc.ts` (`NativeHelper`) is the client for this protocol. It is
platform-neutral, and every driver reuses it as-is.

## Transport

- The helper is spawned with no arguments. It reads **stdin** and writes
  **stdout** as UTF-8, **one JSON object per line** (`\n`-terminated).
- **stderr** is for human diagnostics only. It is forwarded to the driver's
  `onStderr` hook and never parsed.
- The helper stays alive for the whole run. Element refs (below) live in its
  memory, so restarting it invalidates every handle a test holds.
- Every write to stdout must be atomic per line. Recorder events come from a
  second thread and are interleaved with responses; the macOS helper
  serialises writes on a lock (`emitLock` in `main.swift`). A Windows helper
  must do the same, or a half-written line will corrupt the stream.

### Startup

As soon as it is ready, the helper emits one line:

```json
{"event":"ready","version":"1.1.0","platform":"darwin","protocol":1,"trusted":true}
```

| Field | Meaning |
|---|---|
| `platform` | `darwin` or `win32` |
| `protocol` | Integer. Bump it only for breaking changes to this document. |
| `trusted` | Whether the helper is allowed to drive the OS. On macOS this is the Accessibility permission. On Windows it is `true` unless UI Automation cannot be initialised, or the helper runs below the integrity level of the app under test (see UIPI in `docs/WINDOWS.md`). |

### Requests and responses

```json
{"id": 7, "op": "find", "args": {"pid": 123, "selector": [{"role": "AXButton", "title": "OK"}]}}
{"id": 7, "ok": true, "result": { ... }}
{"id": 7, "ok": false, "error": {"code": "notFound", "message": "no element matched selector"}}
```

- `id` is echoed back exactly. Requests are handled **in order, one at a
  time**, so a slow op delays the ones queued behind it. The client applies a
  per-call timeout (30s by default).
- `op` names are fixed strings; unknown ops return `unknownOp`.
- An unhandled failure returns `internal` rather than crashing the helper.

### Unsolicited events

Lines with an `event` field and **no `id`** are pushed by the helper on its own
schedule. Two exist today: `ready` (above) and `record` (see Recording).

## Shared shapes

These are the TypeScript types in `src/types.ts`. Field names are identical
on every platform.

### `AXNode`: one element of the accessibility tree

```ts
{ ref, role, subrole?, title?, description?, help?, identifier?, placeholder?,
  value?, enabled?, focused?, selected?, rect?, actions?, childCount?, children?, truncated? }
```

- `ref` is an opaque string handle (`"e123"`), valid until `gc` is called or
  the element goes away. Handing back an unknown ref returns `staleRef`.
- **`role` uses the macOS `AX*` role names on every platform** (`AXButton`,
  `AXTextField`, `AXWindow`, `AXMenuItem`, …). The selector DSL, the recorder
  and every test are written against these names. A Windows helper maps UIA
  control types onto them; the table is in `docs/WINDOWS.md`.
- `rect` is `{x, y, width, height}` in **screen coordinates, top-left origin,
  logical pixels** (points on macOS, DIPs on Windows). Every coordinate that
  crosses the protocol, in either direction, is in this one space.
- `actions` lists what `element.action` accepts. `AXPress` is the one the
  framework relies on; Windows maps it to `InvokePattern.Invoke()`.

### `Selector`: a predicate over one element

```ts
{ role?, subrole?, title?, titleContains?, titleMatch?, description?, descriptionContains?,
  value?, valueContains?, identifier?, help?, helpContains?, text?, enabled?, focused?, nth?, maxDepth? }
```

Fields are ANDed together.
- `*Contains` fields and `text` match case- and diacritic-insensitively.
- `titleMatch` is a regular expression.
- `text` matches if title, value, description, help **or** placeholder
  contains the substring.
- `nth` is a **0-based** index into the matches, in depth-first document order.
- A **path** is an array of selectors; each step searches inside the previous
  match (the first step may match the root itself).

## Operations

`Root` means either `{"pid": n}` (the application element) or `{"ref": "e1"}`.

### Health and permissions

| op | args | result |
|---|---|---|
| `ping` | none | `{ok, pid}` |
| `gc` | none | `{ok}`: drops every ref. Called between tests. |
| `shutdown` | none | `{ok}`, then the helper exits |
| `perm.accessibility` | `prompt?: bool` | `{trusted}` |
| `perm.screenRecording` | none | `{granted}` (Windows: always `true`) |

### Applications

| op | args | result |
|---|---|---|
| `app.list` | none | `[{pid, name, bundleId, active, hidden, policy}]`. `bundleId` is the AppUserModelID on Windows, or the exe name if there is none. `policy` is `regular` or `accessory` (no taskbar button). |
| `app.find` | `bundleId?, name?` | `[{pid, name, bundleId}]` |
| `app.info` | `pid` | `{pid, name, bundleId, active, hidden, terminated, windowCount, hasMenuBarExtra}`. Throws `noApp` for an unknown pid. |
| `app.activate` | `pid` | `{ok}`: bring to front |
| `app.hide` | `pid` | `{ok}` (Windows: minimise all windows) |
| `app.terminate` | `pid, force?` | `{ok}`. Polite close first (`WM_CLOSE` on Windows); `force` kills. |
| `app.enableElectronAccessibility` | `pid` | `{manualAccessibility, enhancedUserInterface}`. Windows: return both `true`, since Chromium turns on UIA as soon as a client queries it. |

### Tree and query

| op | args | result |
|---|---|---|
| `tree` | `Root, maxDepth?, maxNodes?` | `AXNode` with `children` |
| `find` | `Root, selector: Selector[], all?, timeoutMs?, maxDepth?` | `AXNode`, or `AXNode[]` when `all`. `all` applies to the last step only. `maxDepth` limits how deep each *result* is serialised; `0` means no children. Throws `notFound`. |
| `exists` | `Root, selector` | `{exists}` |

### Elements

| op | args | result |
|---|---|---|
| `element.get` | `ref` | `AXNode` |
| `element.attributes` | `ref` | `{attributes: {name: value}, actions: []}`: every raw property, for debugging |
| `element.action` | `ref, action, nonBlocking?` | `{ok}`. `nonBlocking` fires the action on a background thread and returns at once. Needed for anything that opens a menu, because on macOS the call blocks until the menu closes. Throws `noAction` if unsupported. |
| `element.setValue` | `ref, value: string\|number\|bool` | `{ok}` |
| `element.click` | `ref, button?, count?, modifiers?` | `{ok}`: a real mouse click at the element's centre |
| `element.hover` | `ref` | `{ok}` |
| `element.focus` | `ref` | `{ok}` |
| `element.rect` | `ref` | `Rect`. Throws `noGeometry`. |
| `element.atPoint` | `x, y` | `ElementContext & {ref}` (see Recording) |

### Tray

| op | args | result |
|---|---|---|
| `tray.list` | `pid?` | `[TrayItem]`: `{ref, index, pid, app, bundleId, role, label, title?, description?, help?, identifier?, actions, rect?}`. `label` is the best human-readable name: title, then description, then tooltip. With `pid`, only that app's icons. |
| `tray.open` | `ref, button?, useMouse?, timeoutMs?, maxDepth?` | `{kind: 'menu'\|'window', root: AXNode}`: waits for the menu or popup the icon produced. Throws `trayNoContent`. |
| `tray.close` | none | `{ok}`: close whatever tray menu is open |

### Menu bar

| op | args | result |
|---|---|---|
| `menu.tree` | `pid, maxDepth?` | `AXNode` rooted at the menu bar. Windows: the window's `MenuBar` control. |
| `menu.click` | `pid, path: string[]` | `{ok, clicked}`. Throws `menuItemNotFound` (listing what *is* available) or `menuItemDisabled`. |

### Windows

| op | args | result |
|---|---|---|
| `window.list` | `pid` | `[{index, ref, title, subrole, minimized, main, focused, rect?, windowId?, sheetCount?}]`. `windowId` is whatever `screenshot` accepts to capture one window (an HWND on Windows). |
| `window.setBounds` | `ref, x?, y?, width?, height?` | `{ok}` |
| `window.setMinimized` | `ref, minimized` | `{ok}` |

### Notifications

| op | args | result |
|---|---|---|
| `notification.list` | none | `[{ref, index, app, title, subtitle, body, texts, raw, buttons: [{ref, title}], actions}]` for banners/toasts currently on screen |
| `notification.act` | `index, action` | `{ok}`. `action` is `press` (click the banner), `close`, or the title of an action button. |

### Dialogs

| op | args | result |
|---|---|---|
| `dialog.list` | `pid?` | `[{kind, ref, pid, app, bundleId, title, subrole, buttons: [{ref, title, enabled}], texts, root}]`. `kind` is `sheet`, `dialog`, `filePanel` or `messageBox`. With `pid`, returns that app's dialogs **plus** any file panel hosted for it by another process. |

### Input

| op | args | result |
|---|---|---|
| `key` | `combo` | `{ok}`. Combos are `mod+shift+s`, `escape`, `enter`, `f5` and so on. **`mod` is the platform's primary modifier**: Cmd on macOS, Ctrl on Windows. `cmd`/`meta` on Windows means the Windows key. Throws `badKey`. |
| `type` | `text, delayMs?` | `{ok}`: any Unicode text, without needing keycodes |
| `click` | `x, y, button?, count?, modifiers?` | `{ok}` |
| `move` | `x, y` | `{ok}` |
| `drag` | `fromX, fromY, toX, toY` | `{ok}` |
| `scroll` | `x, y, dx, dy` | `{ok}` |
| `mouse.location` | none | `{x, y}` |
| `screen.info` | none | `[{frame: Rect, scale, main}]` |

### Recording

| op | args | result |
|---|---|---|
| `record.start` | none | `{ok}`. Starts a global input hook. Throws `tapFailed` when the OS refuses. |
| `record.stop` | none | `{ok}` |
| `record.pick` | `armed?: bool` | `{ok, armed}`. While armed, the next left click is **swallowed**: the app never receives it. It is reported as `type: 'pick'` instead of `click`. |

While recording, the helper pushes one line per user action:

```json
{"event":"record","data":{ ...RecordedClick or RecordedKey... }}
```

#### `RecordedClick` (types `click` and `pick`)

```ts
{
  seq, type: 'click' | 'pick', button: 'left'|'right'|'middle', count, modifiers: string[], x, y, at,
  // ElementContext for the element under the pointer:
  pid, app, bundleId,
  surface: 'window'|'dialog'|'tray'|'trayMenu'|'menuBar'|'contextMenu'|'notification'|'unknown',
  element?: ElementSummary,          // role, subrole, title, description, help, identifier, placeholder, value, enabled, rect
  ancestors?: ElementSummary[],      // closest first, application node excluded
  window?: ElementSummary,           // containing top-level window
  menuPath?: string[],               // for menu surfaces: titles from the top down to the clicked item
  trayItem?: ElementSummary,         // for tray / trayMenu: the owning tray icon
  dialog?: {kind, title, texts},     // for dialog
  notification?: {raw, texts},       // for notification
}
```

`surface` is **decided natively**, because only the platform knows where its
tray menus and dialogs live:

| surface | means | How macOS decides |
|---|---|---|
| `tray` | the tray icon itself | an ancestor is the app's `AXExtrasMenuBar` |
| `trayMenu` | an item in the tray icon's menu | as `tray`, plus an `AXMenu` in the chain |
| `menuBar` | an item in the app's menu bar | an `AXMenuBar` plus menu items in the chain |
| `contextMenu` | any other menu | an `AXMenu` in the chain |
| `notification` | a banner | owner is `com.apple.notificationcenterui` |
| `dialog` | alert, sheet or file panel | `AXSheet` in the chain, dialog subrole, or a save/open panel |
| `window` | anything else in a window | there is an `AXWindow` ancestor |

The helper **reports every event from every app**. Deciding what belongs to the
app under test is `isRelevant()` in `src/recorder/session.ts`, not the helper's
job.

#### `RecordedKey`

```ts
{ seq, type: 'key', key, text, modifiers, repeat, pid, app?, bundleId?, focus?: ElementContext, at }
```

- `key` is the normalised name (`a`, `enter`, `backspace`, `left`, `f5`,
  `escape`, `tab`, `space`).
- `text` is the character produced, respecting the keyboard layout and shift.
- `modifiers` uses `cmd`, `ctrl`, `alt`, `shift`. The recorder, not the
  helper, turns the primary one into `mod`.
- `pid` is the process the key went to. `focus` describes the focused element,
  which is what typed text lands in.

#### Recorder rules a helper must follow

1. **Never do slow work in the hook callback.** Copy the event's scalars, hand
   them to a worker, and return. An accessibility query into a hung app can
   take seconds, and inside the callback that freezes the user's mouse and
   keyboard across the whole system. macOS additionally disables a slow tap,
   and Windows silently drops a low-level hook that takes longer than
   `LowLevelHooksTimeout`.
2. **Resolve the element on mouse-down**, before the app reacts: once the
   click lands, a menu item is gone.
3. **Emit events in input order.** Use one serial worker.
4. **Ignore input the helper synthesised itself.** On Windows, drop events
   flagged `LLMHF_INJECTED` / `LLKHF_INJECTED` whose `dwExtraInfo` carries the
   helper's own marker; otherwise replaying a test while recording records the
   replay. The macOS helper does not need this because the Studio refuses to
   run tests while recording.
5. Never record the contents of password fields. Both platforms' OS APIs
   already hide secure input from global hooks. Do not work around that.

## Error codes

| code | meaning | transient? |
|---|---|---|
| `notFound` | selector matched nothing | yes, so callers poll |
| `staleRef` | ref unknown or its element is gone | yes |
| `noGeometry` | element has no on-screen rect | yes |
| `trayNoContent` | tray icon produced no menu/window in time | yes |
| `noNotification` | no banner at that index | yes |
| `badArgs`, `badRequest`, `badKey` | caller error | no |
| `noApp`, `noMenuBar`, `menuItemNotFound`, `menuItemDisabled`, `noAction`, `actionFailed`, `setValueFailed` | real failures | no |
| `tapFailed` | could not install the input hook | no |
| `notRecording` | `record.pick` without `record.start` | no |
| `unknownOp` | op not implemented | no |
| `internal` | anything else | no |

"Transient" codes are the ones `DriverError.transient` treats as "not there
*yet*", so the framework retries them until the deadline.

## Screenshots, URLs and permissions

These are handled in the TypeScript driver rather than the helper, using OS
tools:

| Driver method | macOS | Windows |
|---|---|---|
| `screenshot` | `screencapture` | a `screenshot` helper op (`PrintWindow` / Graphics Capture) |
| `openUrl` | `open [-a app]` | `ShellExecuteEx` / `start` |
| `resetPermission` / `readPermission` | `tccutil` / `TCC.db` | the ConsentStore registry keys |

A Windows helper may add ops for these. Anything a helper adds beyond this
document should be namespaced (`win.*`) and documented here.
