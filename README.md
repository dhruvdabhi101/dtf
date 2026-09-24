# dtf — OS-level testing for desktop apps

Point it at a `.app` (or, once the Windows driver lands, an `.exe`) and write tests
against the parts of a desktop app that no in-process test harness can see:
**tray icons, notification banners, native dialogs and file panels, permission
prompts, menu bars, and window lifecycle.**

```ts
test('closing the window keeps the app in the tray', async ({ app }) => {
  await app.tray.click('Show Window');
  await app.windows.main().close();

  await app.windows.shouldHaveNone();
  await app.tray.shouldExist();                    // still resident
});

test('the tray menu can send a notification', async ({ app }) => {
  await app.tray.click('Send Notification');
  await app.notifications.shouldHave({ title: 'My App' });
});
```

---

## Why this exists

Testing an Electron or native desktop app usually stops at the renderer.
Playwright's `_electron`, Spectron's descendants, and WebdriverIO's electron
service all drive the *web view*. That covers most of the UI and none of the
operating system.

But the OS surfaces are where desktop apps actually break, and where the bugs are
most embarrassing: the tray icon that stops appearing after a refactor, the
"close to tray" that starts quitting the app, the notification that silently
stops being delivered, the save dialog that never opens on a sandboxed build, the
permission prompt that fires on every launch instead of once.

None of these live inside a window. The only vantage point from which they are
observable is *outside the process*, through the operating system's own
accessibility and input layers. That is what this framework is.

### What the research turned up

| Surface | How it is actually observable | What most tools do wrong |
|---|---|---|
| **Tray / menu bar extra** | A status item lives in its **owning app's** accessibility tree, under the undocumented-but-stable `AXExtrasMenuBar` attribute — *not* in any shared system process. | Try to find it by screenshotting the menu bar, or give up entirely ([electron#5026](https://github.com/electron/electron/issues/5026) has been open since 2016). |
| **Notifications** | Readable from the `com.apple.notificationcenterui` accessibility tree: source app, title, subtitle, body, and action buttons. | Read the `usernoted` SQLite database, which needs **Full Disk Access** on the test machine. This framework does not, and reads exactly what a user would see. |
| **Native dialogs** | Three different places depending on how the app is built: an `AXSheet` **child node** of a window, a standalone `AXDialog` window, or a window on a **completely different process** — a sandboxed app's save panel is served by `com.apple.appkit.xpc.openAndSavePanelService`. | Look only at the app's own windows, and miss sandboxed file panels entirely. |
| **File panels** | Identified by `AXIdentifier` of `save-panel` / `open-panel`. A non-sandboxed app hosts its own panel as an ordinary `AXStandardWindow`, so subrole is not a reliable signal. | Match on window title, which breaks under localisation. |
| **Permissions** | `tccutil reset` re-arms a first-run consent flow. Granting from a script is **impossible by design** — `TCC.db` is SIP-protected. | Promise permission automation that cannot exist. See [Permissions](#permissions) for what is genuinely testable. |

---

## Install

Requires **macOS**, **Node ≥ 22.18**, and the **Xcode Command Line Tools**
(`xcode-select --install`) to compile the native driver.

```bash
npm install
npm run build:native
npx dtf doctor
```

`dtf doctor` is a preflight worth running first. Desktop test runs fail for
environmental reasons far more often than for code reasons, and it turns a
confusing red suite into one clear line:

```
  ✓ platform                     macOS, node v24.16.0
  ✓ native driver                dtfd-macos is built and responding
  ✓ Accessibility permission     granted
  ✓ Screen Recording permission  granted — screenshots will capture window content
  ✓ Do Not Disturb               off — notification banners will be delivered
  ✓ displays                     1920x1080 @1x (main), 1512x982 @2x
  ✓ tray enumeration             17 menu bar item(s) visible
```

The **Accessibility** permission must be granted to whatever process runs the
tests (your terminal, or the CI agent binary) — System Settings → Privacy &
Security → Accessibility. Screen Recording is optional and only affects
screenshots.

## Quick start

```bash
npx dtf init      # writes dtf.config.ts and tests/os.spec.ts
npx dtf run
```

```ts
// dtf.config.ts
import { defineConfig } from 'dtf';

export default defineConfig({
  app: {
    path: '/Applications/YourApp.app',
    isolatedUserData: true,          // throwaway profile per run
    userDataArg: '--user-data-dir=', // Electron's flag
  },
  lifecycle: 'per-file',             // or 'per-test' for full isolation
  retries: 1,
  screenshotOnFailure: true,
});
```

Test files are plain TypeScript. Node runs them directly via native type
stripping, so there is **no build step and no transpiler config**.

## Writing tests

### Selectors

A small string DSL, or a plain object when you want to be explicit.

```ts
app.find('button[title="Save"]')       // role + exact title
app.find('#save-button')               // accessibility identifier
app.find('"Welcome back"')             // free text across every label attribute
app.find('window >> button[title=OK]') // scoped chain
app.find('menuitem[title=Quit]:nth(1)')
app.find({ role: 'AXButton', titleMatch: '^Save' })
```

`text` is the pragmatic escape hatch: it matches title, value, description, help,
*or* placeholder, which covers the very common case of a control labelling itself
in an attribute you did not expect.

Locators are lazy and self-retrying. Nothing is queried until you act, and every
action re-resolves first — which matters more on the desktop than on the web,
because menus are rebuilt from scratch each time they open.

### Tray

```ts
await app.tray.shouldExist({ label: 'My App' });

const menu = await app.tray.open();
await menu.shouldHaveItem('Preferences…');
await menu.click('Advanced', 'Reset Cache');   // nested submenus
await menu.close();

await app.tray.click('Quit');                  // open + click in one call
```

Menu-style and popover-style trays are unified: `menu.items()` for a classic
`NSMenu`, `menu.texts()` and `menu.find(...)` for the popover panels that most
Electron and SwiftUI menu-bar apps actually show. Tests do not need to know which
they got.

### Notifications

```ts
const n = await app.notifications.shouldHave({ title: 'Export complete' });
expect(n.body).toContain('12 files');

await app.notifications.clickAction('Open Folder');
await app.notifications.dismissAll();
await app.notifications.shouldNotHave({ title: 'Error' }, { withinMs: 3000 });
```

Banners are scoped to the app under test by default; pass `anyApp: true` to search
system-wide.

### Dialogs and file panels

```ts
const alert = await app.dialogs.shouldAppear({ text: 'Unsaved changes' });
await alert.shouldHaveButtons('Save', "Don't Save", 'Cancel');
await alert.click('Save');

const panel = await app.dialogs.shouldAppear({ kind: 'filePanel', anyApp: true });
await panel.setFilePath('/tmp/export.csv');
```

`dismiss()` prefers the dialog's own cancel control and only falls back to
Escape — Escape goes to whatever has keyboard focus, which is an easy way to
write a test that passes locally and hangs in CI.

### Windows, menus, logs

```ts
await app.windows.waitForCount(2);
await app.windows.get({ title: 'Settings' }).find('#api-key').fill('sk-...');
await app.windows.main().screenshot('artifacts/main.png');

await app.menu.shouldHave('File', 'Export…');
await app.menu.click('File', 'Export…');

await app.waitForLog(/export finished/);   // the app's stdout/stderr
await app.shouldNotLog(/DeprecationWarning/);
```

Apps are launched by executing the binary inside the bundle directly rather than
via `open`. That costs a little bundle parsing and buys three things worth having:
a real child pid, control over the environment, and **the app's stdout/stderr
captured as a test artifact**.

## AI-driven checks

For exploratory testing and UI too dynamic to pin with selectors:

```ts
await aiAssert(app, 'the tray menu offers a way to sign out');
await aiAssert(app, 'the empty state explains what to do next', { vision: true });
```

```bash
export ANTHROPIC_API_KEY=...
npx dtf ask "the settings window has a working dark mode toggle" --bundle com.example.app
```

The important design choice: the model's **primary sense is the accessibility
tree, not screenshots**. Conventional "computer use" hands a model pixels and
coordinates — slow, expensive, non-deterministic about where things are, and
literally unable to see a tray menu's structure. Here the model gets the same
exact labels, roles, and states the deterministic API uses, with screenshots
available as a secondary sense for genuinely visual questions.

Read-only by default; pass `allowActions: true` to let it drive the app. UI text
is treated as untrusted data, never as instructions.

Use it for exploration and for checks you cannot express as selectors. Prefer
deterministic selectors for anything running on every commit — a model in the
loop is a source of flakiness and cost.

## Permissions

Worth being blunt, because it shapes every test you can write:

| Operation | Supported | Notes |
|---|---|---|
| Reset a grant | ✅ | `app.permissions.reset('Camera')` — re-arms the first-run consent flow. Takes effect on next launch. |
| Answer a consent prompt | ✅ | `app.permissions.answerPrompt('deny')` — the prompt is a window on a *system* process, so it is matched across pids. |
| Assert a prompt did/didn't appear | ✅ | `shouldPrompt()` / `shouldNotPrompt()` |
| Read the current grant | ⚠️ | Needs Full Disk Access for the test process; returns `'unknown'` otherwise rather than failing. |
| **Grant** a permission from a script | ❌ | Impossible by design. `TCC.db` is SIP-protected and only the system consent UI may write to it. |

To pre-grant permissions on a CI runner, install a **PPPC configuration profile**
via MDM. That is the only supported route, and it requires enrolment.

## Browser handoff and sign-in

Apps hand off to the system browser for OAuth. That leaves the app entirely, so
nothing inside it can observe the handoff — but the browser is just another
accessible app:

```ts
await app.tray.click('Sign in');
const page = await app.browser.shouldOpenUrl(/auth\.example\.com\/authorize/);
const params = new URL(page.url).searchParams;   // assert client_id, redirect_uri, PKCE
```

And the return trip, without automating the identity provider:

```ts
await app.openDeepLink(`myapp://auth?token=${process.env.CI_TOKEN}&email=ci@example.com`);
await app.waitForLog(/auth-success/);
```

`openDeepLink` routes to *your* bundle explicitly — a machine with several builds
of the same app installed has several claimants on the scheme, and LaunchServices
will happily deliver the callback to the wrong one. Full treatment in
[docs/CI.md](docs/CI.md#4-authentication).

## CI

These are real GUI tests: they need a logged-in graphical session, not a headless
container. **[docs/CI.md](docs/CI.md)** is the full guide;
`scripts/ci-setup-macos.sh` provisions a runner and
`.github/workflows/desktop-tests.yml` is a working workflow. The essentials, on a
self-hosted macOS runner:

1. Log the runner user in and disable the screen lock and screen saver — a locked
   screen makes the accessibility tree unavailable.
2. Grant **Accessibility** to the CI agent binary (or install a PPPC profile).
3. Turn off Focus modes. A Focus mode silently suppresses notification banners,
   which makes every notification assertion fail for an invisible reason.
   `dtf doctor` warns about this.
4. Run `dtf doctor` as a pipeline step before the suite.

Artifacts on failure land in `dtf-artifacts/`: a screenshot, a JSON dump of the
full accessibility tree, and the app's log. Those three together are what let you
tell "wrong state" apart from "wrong selector" after the fact.

## Debugging

```bash
dtf inspect tray                              # every tray icon on the system
dtf inspect tree --bundle com.example.app     # the app's accessibility tree
dtf inspect notifications                     # banners currently on screen
dtf inspect dialogs                           # open dialogs, sheets, file panels
dtf inspect menu --bundle com.example.app
```

`dtf inspect tree` is the fastest way to write a selector: dump the tree, find the
node, use its `identifier` or `title`.

## Architecture

```
your tests  ─┐
             ├─ surfaces (tray, notifications, dialogs, menu, windows, permissions)
runner       ─┤     platform-agnostic; assertions poll until a deadline
             ├─ Driver interface
             └─ macOS driver ──JSON-lines over stdio──> dtfd-macos (Swift)
                                                          AXUIElement + CGEvent
```

Everything above the `Driver` interface is platform-agnostic. A new platform is
one class plus one native helper, with no changes to surfaces, runner, or
assertions.

The native helper is a single Swift binary speaking newline-delimited JSON over
stdin/stdout. It is long-lived on purpose: element handles are only meaningful
inside its memory, so restarting it invalidates every handle a test holds.

Process lifecycle, log capture, screenshots, TCC, orchestration and reporting all
live in Node; the Swift side does only what needs the native APIs.

### Two bugs worth knowing about

Both were found by running this framework against a real app, and both would have
made any similar tool mysteriously flaky:

**`AXPress` on a status item blocks.** AppKit runs a modal menu-tracking loop
*inside* the accessibility action, so the call does not return until the menu
closes — and eventually fails with `kAXErrorCannotComplete` (-25204) even though
the menu opened perfectly. Anything that opens a menu must be dispatched and then
polled for, never awaited. This alone accounted for a 4.5× slowdown and
intermittent failures before it was fixed.

**`NSWorkspace.runningApplications` is a cached snapshot.** It is kept current by
notifications delivered on the run loop, and the helper is a blocking
read-a-line-and-respond process with no run loop of its own. Without explicitly
pumping it, the list freezes at whatever it was on first access and **every app
launched afterwards is invisible** — which shows up as a tray icon that "does not
exist" on the second and later launches of the same app. Exactly the shape of a
long test run, and exactly the kind of bug that gets misdiagnosed as flake.

## Status

**macOS: complete and verified.** The bundled fixture app
(`fixtures/tray-app/`) exercises every surface, and the suite in `tests/` runs
green with zero retries in ~21s.

**Windows: designed, not implemented.** `docs/WINDOWS.md` specifies the port —
UI Automation, the `Shell_TrayWnd` notification area, `wpndatabase.db` for toasts,
and the `Driver` methods to fill in. `createDriver()` throws a clear error there
today rather than pretending.

**Linux:** not started. AT-SPI2 is the equivalent layer, but tray behaviour
varies so much across desktop environments that it needs its own design pass.

## Limitations

- **Not headless.** Requires a real logged-in graphical session.
- **The mouse really moves.** Notification action buttons only render on hover,
  and some controls only respond to hardware-level events. Run on a dedicated
  machine or VM rather than the one you are working on.
- **Apps that expose no accessibility tree** — a game, or a fully custom-drawn
  canvas — degrade to screenshots and coordinates. The AI checker with
  `vision: true` is the intended fallback there.
- **The bundled fixture cannot post notifications through
  `UNUserNotificationCenter`**, because macOS refuses to register an ad-hoc-signed
  app. It falls back to the scripting bridge, which produces a real banner
  attributed to the script host. Properly signed apps are matched to the app
  under test automatically; see the comment in `tests/notifications.spec.ts`.
