---
name: dtf-desktop-testing
description: Write, run and debug OS-level end-to-end tests for a desktop app (Electron, native macOS/Windows, tray-first apps) with the `dtf` framework — tray icons and menus, notification banners, native dialogs and file panels, permission prompts, menu bars, windows, logs, deep links and browser sign-in hand-offs. Use when asked to automate a manual QA checklist for a desktop app, add desktop/E2E/tray/notification tests, decide which manual test cases can be automated, or debug a failing dtf spec.
---

# dtf — OS-level testing for desktop apps

`dtf` tests a desktop app from **outside its process**, through the operating
system's accessibility and input layers (AXUIElement on macOS, UI Automation on
Windows). That is the only place where tray icons, notification banners, native
dialogs, file panels and permission prompts can be observed at all. Playwright's
`_electron` and similar harnesses stop at the renderer; `dtf` starts where they stop.

Use this skill to:

1. Triage a manual test checklist into *automatable*, *partially automatable* and *manual*.
2. Write specs for the automatable rows.
3. Run them, read failure artifacts, and fix selectors.

---

## 1. Ground rules (read these first)

- **Not headless.** Tests need a logged-in graphical session. The mouse and keyboard
  really move. Don't run the suite on a machine someone is typing on.
- **The test process needs Accessibility permission** (macOS: System Settings →
  Privacy & Security → Accessibility, granted to the terminal/IDE/CI agent that runs
  `node`). Screen Recording is optional; it only affects screenshots.
- **Run `dtf doctor` first.** Most red runs come from the environment, not the code.
  Doctor checks the permissions, Do Not Disturb/Focus (which suppresses banners), displays
  and tray enumeration.
- **Node ≥ 22.18, TypeScript with no build step.** Node strips types natively, so specs
  must use *erasable* TypeScript only: no `enum`, no `namespace`, no constructor
  parameter properties, and `import type` for type-only imports.
- **Everything polls.** Every `should*` assertion and every locator retries until a
  deadline. Never add a `sleep()` before an assertion. Use `sleep()` only when the
  test is *about* elapsed time, e.g. "the countdown moved after a minute".
- **Refs are short-lived.** Element handles die when the UI rebuilds, and menus rebuild
  every time they open. Locators re-resolve on every action, so hold a locator rather
  than a node.
- **Some things are impossible by design.** On macOS you cannot grant a TCC permission
  from a script, answer a UAC prompt, unlock a locked screen, or read the
  accessibility tree while the screen is locked. See §7.

---

## 2. Setting it up in an app's repository

`dtf` is not on npm. Consume it from a local checkout through a `file:` dependency,
kept in its own folder so the app's own `package.json` and lockfile stay untouched:

```
<app-repo>/dtf/
  package.json          { "type": "module", "devDependencies": { "dtf": "file:../../DesktopTestingFramework" } }
  tsconfig.json         editor type-checking only (nodenext, allowImportingTsExtensions, noEmit)
  lib/<app>.ts          shared helpers for this app: status strings, menu readers, gates
  <suite>/dtf.config.ts one folder per *app state/profile* (see §3)
  <suite>/*.spec.ts
```

```jsonc
// dtf/package.json
{
  "name": "<app>-dtf",
  "private": true,
  "type": "module",
  "scripts": {
    "doctor": "dtf doctor",
    "test": "dtf run first-run && dtf run signed-in"
  },
  "devDependencies": { "dtf": "file:../../DesktopTestingFramework", "@types/node": "^24", "typescript": "5.9" }
}
```

Then `cd dtf && npm install && npx dtf doctor`. Specs import from `'dtf'`.

`npm install` symlinks the framework, and Node resolves the symlink to its real path.
That matters: Node refuses to strip types from `.ts` files under `node_modules`.

Exclude the folder from the app's own tooling. Add `"dtf"` to the root `tsconfig.json`
`exclude` list and `"dtf/**"` to the ESLint ignores. Otherwise the app's `tsc` tries to
compile the specs.

### Config — `dtf.config.ts`

```ts
import { defineConfig } from 'dtf';

export default defineConfig({
  app: {
    path: {                                  // one entry per platform, or a plain string
      darwin: '/Applications/MyApp.app',
      win32: '%LOCALAPPDATA%\\Programs\\MyApp\\MyApp.exe',   // ~, %VAR%, $VAR expand
    },
    isolatedUserData: true,                  // fresh throwaway profile per launch
    userDataArg: '--user-data-dir=',         // how to pass it (Electron flag)
    timeoutMs: 30_000,                       // time for the app to register with the OS
    args: [], env: {},                       // extra argv / environment
    // chromiumAccessibility: true (default) — makes Electron windows readable
    // args: ['--force-renderer-accessibility'] — for Electron apps that open a
    //   window DURING launch: builds the accessibility tree from the first frame
  },
  lifecycle: 'per-file',     // 'per-file' (one launch per spec file) | 'per-test' | 'manual'
  testMatch: ['*.spec.ts'],  // globbed relative to the config's folder
  timeoutMs: 60_000,         // per test, overridable per test
  retries: 0,
  screenshotOnFailure: true,
  cleanSlate: true,          // before each test: close menus, dismiss banners and the app's dialogs
  slowMoMs: 400,             // pause after every click/key/tray/menu action (default off)
  reporter: ['pretty', 'junit'],
  artifactsDir: 'dtf-artifacts',
  // attach: { bundleId: 'com.example.app' }   // attach to a running app instead of launching
  // resetPermissions: ['Camera']              // tccutil reset before launch (first-run flows)
});
```

A config next to the specs wins over one in the working directory. That is what lets
you keep **one folder per starting state**, each with its own config.

---

## 3. Structuring a suite: organise by starting state

Desktop tests depend on state far more than web tests do: signed in or not, permissions
granted or not, recording or paused. Put each state in its own folder, with a config
that produces it:

| Folder | Profile | Covers |
|---|---|---|
| `first-run/` | `isolatedUserData: true` | install/first launch, signed-out tray, onboarding windows, sign-in hand-off |
| `signed-in/` | real profile (`isolatedUserData: false`), user already signed in and permissions granted | tray states, pause/resume, recording health, quit/relaunch, crash recovery |

Inside a folder:

- **One spec file per checklist section.** Name each test after its checklist ID, as in
  `'G-03 extending a pause adds an hour'`. `--grep G-03` then runs exactly that row, and
  the report maps straight back to the checklist.
- **Tests that quit or kill the app go in their own file**, or relaunch it themselves
  (see §6.6). With `per-file` lifecycle, every later test in the file shares the same
  `app`.
- **Leave the app in the state you found it.** If a test pauses, an `afterEach` resumes.
  If a test signs out on a real profile, it must be gated (see §6.7).

---

## 4. API reference

Everything is exported from `'dtf'`.

### 4.1 Test registration

```ts
import { describe, test, it, beforeAll, afterAll, beforeEach, afterEach } from 'dtf';

describe('Tray', () => {
  beforeAll(async ({ app }) => { await app.tray.shouldExist({}, { timeoutMs: 30_000 }); });

  test('A-02 an icon appears', async ({ app, driver, screenshot, attach }) => {
    // app: DesktopApp  driver: Driver  screenshot(name) → path  attach(name, text) → report
  }, { timeoutMs: 90_000, retries: 1 });

  test.skip('not yet', async () => {});
  test.only('focus', async () => {});
});
```

`attach(name, body)` puts text into the report. Use it for measurements a checklist asks
you to "write in Notes": timings, CPU, memory, file sizes.

### 4.2 `DesktopApp` (`ctx.app`)

| Member | Notes |
|---|---|
| `pid`, `bundleId`, `name`, `driver`, `attached` | |
| `DesktopApp.launch(driver, LaunchOptions)` | Launch another instance yourself (relaunch tests). The executable is spawned directly, so stdout/stderr are captured. |
| `DesktopApp.attach(driver, { bundleId?, name?, pid? })` | Attach to a running instance. An attached app is left running on `close()`. |
| `isRunning()`, `info()`, `activate()`, `hide()` | |
| `close({ timeoutMs?, force? })` | Polite quit, then escalates to a kill. Tray apps often ignore a polite quit. |
| `find(selector)` → `Locator` | Rooted at the app, so it spans every window. |
| `tree(maxDepth = 8)` | The full accessibility tree. Print it when a selector will not match. |
| `logs`, `logText()`, `logCursor()` | Captured stdout/stderr, as `{stream, line, at}[]`. |
| `waitForLog(re, { timeoutMs?, since? })` | Returns the matching `LogLine`. |
| `shouldNotLog(re, { since? })` | Pass `since: app.logCursor()` taken at the start of the test, otherwise you assert against earlier tests' output. |
| `openDeepLink(url)` | Routed to *this* bundle explicitly, not whatever LaunchServices picks. |
| `key('mod+s')`, `type(text)`, `click(x, y, {button, count})`, `screenshot(path?)` | Raw input. `mod` is ⌘ on macOS and Ctrl on Windows. |

### 4.3 Tray — `app.tray`

```ts
await app.tray.shouldExist({}, { timeoutMs: 30_000 });   // TrayItem
const items = await app.tray.list();                      // this app's icons: {label, rect, ...}
const menu  = await app.tray.open();                      // TrayPopup; AXPress by default
const menu2 = await app.tray.open({}, { useMouse: true }); // a real click: use it to test "opens on the first click"
menu.kind;                        // 'menu' (NSMenu/context menu) | 'window' (popover panel)
menu.items();                     // TOP-LEVEL item titles in order; separators skipped; disabled items included
menu.items({ nested: true });     // …plus every submenu's items, flattened
menu.submenu('Turn off');         // one submenu's items, when the tree already has them (Electron does)
menu.texts();                     // every readable string (for popover-style trays)
await menu.shouldHaveItem('Quit');
await menu.click('Settings', 'Advanced');   // nested path; opens submenus as it goes
await menu.close();               // sends Escape. With a submenu open, call it twice
await app.tray.click('Sign In');  // open + click in one call
```

- The **first line of a status-style tray menu** is usually a disabled item holding the
  state. `menu.items()[0]` reads it.
- **Labels that tick (countdowns, timers): find and click them in ONE opening of the
  menu.** `const m = await app.tray.open(); await m.click(m.items().find(re)!, 'Extend')`.
  Reading the label, closing, and reopening to click races the clock ("1h 00m" → "59 min").
- **Native AppKit submenus are empty in the tree until they open** (Electron's are not; use `menu.submenu()`). To read one
  without clicking a leaf, press the parent non-blockingly and read its `AXMenu` child:

```ts
const menu = await app.tray.open();
const parent = await menu.find({ role: 'AXMenuItem', titleMatch: '^Paused' }).resolve();
await app.driver.elementAction(parent.ref, 'AXPress', { nonBlocking: true });
const sub = await waitFor(async () =>
  (await app.driver.tree({ ref: parent.ref }, { maxDepth: 2 })).children?.find((c) => c.role === 'AXMenu'),
  { timeoutMs: 3000, description: 'submenu' });
const titles = (sub.children ?? []).map((c) => c.title ?? '').filter(Boolean);
await app.tray.close(); await app.tray.close();
```

- **Never `await` a raw `AXPress` on a status item.** AppKit runs the menu's modal
  tracking loop inside the action, so the call blocks. The tray API already handles this.
- The status item's accessibility label is `TrayItem.label`. An empty label is a real
  accessibility bug worth a test.

### 4.4 Windows — `app.windows`

```ts
await app.windows.shouldHaveNone({ timeoutMs: 8000 });   // tray-first apps boot with no window
const w = await app.windows.waitFor({ title: /Permissions/ }, { timeoutMs: 15_000 });
await app.windows.waitForCount(1);
const count = await app.windows.count();
const list = await app.windows.list();                   // WindowInfo[] with title, rect, focused…
w.find('"Close"'); await w.rect(); await w.title();
await w.setBounds({ width: 480, height: 420 });          // resize tests
await w.minimize(); await w.restore(); await w.close();  // close = the traffic-light button, else ⌘W
await w.screenshot('dtf-artifacts/x.png');               // needs Screen Recording
```

`app.windows.get(q)` and `main()` return a handle that re-resolves on every use.

### 4.5 Locators and selectors

Selector DSL (a string), or a `Selector` object:

```ts
'button[title="Save"]'          // role alias + exact title
'#save-button'                  // accessibility identifier (DOM id in Electron)
'"Welcome back"'                // free text: substring of title|value|description|help|placeholder
'window >> button[title=OK]'    // scoped chain
'menuitem[title=Quit]:nth(1)'   // nth match
{ role: 'AXButton', titleMatch: '^Save', enabled: true }
```

Role aliases include `button checkbox radio text textfield textarea window menu menuitem
group image link list row cell table toolbar slider popup sheet scrollarea webarea`.

Selector object fields: `role subrole title titleContains titleMatch description
descriptionContains value valueContains identifier help helpContains text enabled
focused nth maxDepth`.

**Electron window opened at launch looks empty** (the tree is nested `AXGroup`s with no
text, and `"…"` selectors never match)? The window was created before the
framework switched Chromium accessibility on. Launch with
`args: ['--force-renderer-accessibility']`, or re-call
`app.driver.setElectronAccessibility(app.pid)` and retry.

**Timing.** Don't sprinkle `sleep()`s: assertions already poll. When an app really
does need breathing room between steps (animations, route loads), set `slowMoMs` in
the config. It pauses after every input action and leaves queries fast.

**Electron specifics.** The framework turns on Chromium's accessibility tree at launch.
Without it an Electron window is an empty box from the outside. A DOM `id` is published as `AXDOMIdentifier`, which `#signInBtn` matches as a fallback to
AXIdentifier, `aria-label` becomes the description, and a heading or
button's text becomes its title or value. The free-text form `'"…"'` is the most robust
choice for Electron content.

| Locator method | |
|---|---|
| `click({button, count, modifiers, force})`, `doubleClick()`, `rightClick()`, `hover()`, `focus()` | `click` prefers AXPress and falls back to a real click. `force: true` always uses the mouse. |
| `fill(text, {clear})`, `setValue(v)`, `press('enter')`, `performAction('AXShowMenu')` | `fill` types key by key, so input handlers fire. `setValue` is instant. |
| `text()`, `value()`, `isEnabled()`, `isFocused()`, `rect()`, `attributes()`, `exists()`, `count()`, `all()`, `resolve()`, `snapshot()` | Reads. |
| `shouldExist()`, `shouldNotExist()`, `shouldHaveText(str\|re)`, `shouldBeEnabled()`, `shouldBeDisabled()`, `waitUntilGone()` | Poll. The default timeout is 5 s; pass `{ timeoutMs }` to change it. |

### 4.6 Notifications — `app.notifications`

```ts
const n = await app.notifications.shouldHave({ body: /paused for 60 minutes/i }, { timeoutMs: 15_000 });
n.title; n.body; n.subtitle; n.app; n.buttons;
await app.notifications.shouldNotHave({ title: /error/i }, { withinMs: 5000 });
await app.notifications.clickAction('Open'); await app.notifications.dismissAll();
const mine = await app.notifications.list();   // banners on screen now, from the app under test
```

Banners are matched to the app by name, so pass `anyApp: true` for system-wide. Banners
disappear after a few seconds. To *count* them over a long window, poll `list()` every
second or two and de-duplicate by `title + body`. A Focus mode suppresses all of them.

### 4.7 Dialogs — `app.dialogs`

```ts
const d = await app.dialogs.shouldAppear({ text: /permission turned off/i }, { timeoutMs: 90_000 });
d.title; d.texts; d.buttons; d.kind;   // 'sheet' | 'dialog' | 'filePanel' | 'messageBox'
await d.shouldHaveButtons('Open System Settings', 'Later');
await d.click('Later'); await d.dismiss();
await app.dialogs.shouldNotAppear({}, { withinMs: 3000 });     // "no error dialog on launch"
const panel = await app.dialogs.shouldAppear({ kind: 'filePanel', anyApp: true });
await panel.setFilePath('/tmp/out.csv');
```

`dismiss()` presses the dialog's own Cancel/Later/Close control when it has one. Escape
goes to whatever has focus, so it is a last resort.

### 4.8 Menu bar — `app.menu` (macOS app menu, or an in-window menu on Windows)

`topLevel()`, `items('File')`, `click('File', 'Export…')`, `has(...)`, `shouldHave(...)`, `tree()`.

### 4.9 Permissions — `app.permissions`

| Call | macOS | Windows |
|---|---|---|
| `reset('ScreenCapture' \| 'Accessibility' \| 'Camera' \| …)` | ✅ `tccutil reset`. This **revokes** the grant, and the app sees it on its next permission check. | ✅ |
| `status(svc)` | ⚠️ Needs Full Disk Access for the test process, otherwise `'unknown'` | ✅ |
| `grant(svc)` / `deny(svc)` | ❌ `UnsupportedError`: TCC.db is SIP-protected | ✅ consent store is writable |
| `answerPrompt('allow' \| 'deny')`, `shouldPrompt()`, `shouldNotPrompt({withinMs})` | ✅ | ✅, except UAC |

`reset` gives you *automatable revocation*: permission-pulled-mid-session tests can
run unattended. Restoring the grant still takes a human, or an MDM PPPC profile on CI.

### 4.10 Browser hand-off — `app.browser`

```ts
await app.tray.click('Sign In');
const page = await app.browser.shouldOpenUrl(/example\.com\/auth/, { timeoutMs: 25_000 });
const p = new URL(page.url).searchParams;    // assert state, redirect/callback, PKCE…
await app.browser.closeMatching(/example\.com\/auth/);
const pages = await app.browser.pages();     // {browser, url, title, pid}[]: one per browser WINDOW (front tab)
// Full real login on a throwaway Chromium profile:
const b = await app.browser.launchIsolated(authUrl);
await b.find('textfield[title=Email]').fill(process.env.E2E_EMAIL!);
await app.browser.confirmProtocolLaunch(b);   // the "Open <App>?" bubble
```

Chromium browsers hide their URL from accessibility, so the framework falls back to
AppleScript. That needs the **Automation** permission for the test process
(System Settings → Privacy & Security → Automation). Firefox is not supported by
`launchIsolated`.

### 4.11 Utilities

```ts
import { waitFor, sleep, AssertionError, TimeoutError, UnsupportedError, aiAssert } from 'dtf';
const v = await waitFor(async () => (await read()) || undefined, { timeoutMs, intervalMs, description });
throw new AssertionError('message', expected, actual);
await aiAssert(app, 'the onboarding window text is readable in dark mode', { vision: true }); // needs ANTHROPIC_API_KEY
```

Raw driver calls for cases nothing else covers: `driver.scroll(x, y, dx, dy)`,
`driver.drag(from, to)`, `driver.move(x, y)`, `driver.screenInfo()`,
`driver.elementAction(ref, action, {nonBlocking})`, `driver.tree(root, {maxDepth})`.

---

## 5. Triage: can this checklist row be automated?

Go row by row and put each one in exactly one bucket. Write the table into the suite's
README, because the humans who own the manual pass need it.

| Bucket | Meaning | Typical examples |
|---|---|---|
| ✅ **Automated** | Runs unattended on every run, with a deterministic assertion. | Tray icon appears; exact menu items per state; the window opens and closes; close-to-tray keeps the app alive; a notification after an action; version in About matches the bundle; pause/extend/resume; the app restarts a killed child process; quit leaves no processes; data dir grows; CPU/RSS sampling; resize keeps content inside the window; single-instance lock. |
| 🟡 **Partial / gated** | Automatable, but destructive, slow, needing extra permissions, or only a proxy of what the human judges. **Gate these behind an env var** (skipped by default) or split them into an assisted test. | Toggle Wi‑Fi (`networksetup`); revoke a permission (`tccutil reset`); sign out of a real profile; sleep/wake (`pmset`, needs sudo); soak tests of 15–30 minutes; browser URL checks (need the Automation permission); "sharp icon" or "no clipped text", where the geometry is automated and the pixels are a vision/AI check. |
| 👤 **Assisted** | A human does one physical step and the test verifies the outcome with timestamps. The test prints `ACTION NEEDED: …` and polls. | Re-granting a macOS permission; completing an IdP login with 2FA; plugging in a monitor; locking and unlocking the screen. |
| ❌ **Manual** | Needs a judgement or hardware the OS cannot give a test. | Installer UX and antivirus wording; "no lag / fans"; call quality; battery drain; full machine restart; subjective visual polish. |

Rules of thumb:

- **If the OS forbids it, the test can't do it.** That covers granting TCC, answering
  UAC, unlocking the screen, and reading AX while locked.
- **If a check is on screen but not in the accessibility tree** (icon crispness, colour,
  overlap), automate the geometry and leave pixels to `aiAssert(..., {vision: true})` or a human.
- **Never automate typing real credentials into a third-party IdP in CI.** Assert the
  hand-off URL instead. For the return, use a deep link with a CI token if the app
  supports one; otherwise make the login an assisted step.
- **Anything that disrupts the machine** (network, sleep, sign-out, permission reset)
  is gated with `DTF_ALLOW_<THING>=1` and states what to restore.
- Every "write the number in Notes" becomes `attach(...)` plus a generous threshold assertion.

---

## 6. Patterns

### 6.1 Read a state-machine tray reliably

```ts
export async function readTrayMenu(app: DesktopApp): Promise<string[]> {
  const menu = await app.tray.open();
  try { return menu.items(); } finally { await menu.close(); }
}
export async function waitForTrayStatus(app: DesktopApp, want: string | string[], timeoutMs = 60_000) {
  const wanted = ([] as string[]).concat(want);
  let last: string[] = [];
  return waitFor(async () => { last = await readTrayMenu(app); return wanted.includes(last[0]) ? last[0] : undefined; },
    { timeoutMs, intervalMs: 2000, description: `tray status ${wanted.join(' | ')}` })
    .catch(() => { throw new AssertionError(`tray status never became ${wanted.join(' | ')}; menu: ${JSON.stringify(last)}`); });
}
```

Opening the menu is visible on screen. When polling for minutes, poll every 15–60 s.

### 6.2 Assert an exact menu per state

Compare the whole list, not just "contains". A duplicated or extra item is a bug too:

```ts
const items = await readTrayMenu(app);
assertSameList(items, ['AI discovery is off', 'Not signed in', 'Sign In', 'About', 'Quit']);
```

### 6.3 Electron window content

```ts
await app.tray.click('Permissions');
const w = await app.windows.waitFor({}, { timeoutMs: 15_000 });
await w.find('"Close"').shouldExist({ timeoutMs: 10_000 });   // wait for Chromium to paint, not just for the frame
await w.find('"Grant permissions to enable AI discovery"').shouldExist();
```

### 6.4 Child processes (helpers, sidecars)

Read the process table (`ps -axo pid=,ppid=,pcpu=,rss=,comm=` on macOS, `Get-Process` on
Windows), filter by executable name, and match `ppid` to `app.pid` to find *this*
instance's children. Kill one with `process.kill(pid, 'SIGKILL')` to test supervision.
After `app.close()`, poll until neither process exists.

### 6.5 Measurements

Sample CPU and RSS every few seconds over a window. `attach()` the min, average and max,
and assert against a generous ceiling taken from an env var, so a slow CI box can raise it.

### 6.6 Quit / relaunch / force-kill inside one test

```ts
const path = appPath();                       // same value the config uses
await quitFromTray(app);                      // or process.kill(app.pid, 'SIGKILL')
await waitFor(async () => !(await app.isRunning()), { timeoutMs: 30_000 });
const again = await DesktopApp.launch(driver, { path, timeoutMs: 30_000 });
try { /* assert on `again` */ } finally { await again.close(); }
```

Put this in its own spec file, because the runner's `app` is dead afterwards. If the app
uses a single-instance lock, make sure no other copy is running, and relaunch with the
same user-data dir.

### 6.7 Gating and assisted steps

```ts
export const gated = (flag: string) => (process.env[flag] === '1' ? test : test.skip);
export async function humanStep(what: string) { process.stderr.write(`\n  👤 ACTION NEEDED: ${what}\n\n`); }

gated('DTF_ALLOW_SIGN_OUT')('L-01 sign out stops recording', async ({ app }) => { … });
```

In the suite README, document every flag, what it disrupts, and how to undo it.

### 6.8 Launch-time negatives

```ts
await app.dialogs.shouldNotAppear({}, { withinMs: 5000 });      // no error box on boot
await app.permissions.shouldNotPrompt({ withinMs: 3000 });      // no consent prompt on every launch
await app.shouldNotLog(/Uncaught|FATAL/);
```

---

## 7. Hard limits

- **macOS TCC.** Reset/revoke works. Grant does not. Reading status needs Full Disk Access.
- **Locked screen / screensaver.** The AX tree is unavailable and input is blocked, so
  lock tests are assisted: the human locks and unlocks, the test checks before and after.
- **System sleep.** `pmset sleepnow` works, but waking on a schedule needs
  `sudo pmset schedule wake …` or `sudo pmset relative wake N`, so it needs a NOPASSWD
  sudoers entry. The test process is also suspended, so measure with wall-clock timestamps.
- **Machine restart / log out.** This kills the runner. It's manual, or a separate
  post-login job.
- **Pixels.** Crispness, colours, overlap and invisible text are not in the AX tree. Use
  `aiAssert` with `vision: true`, or keep them manual.
- **Browser tabs.** `browser.pages()` reports one URL per browser *window* (its front tab).

---

## 8. Workflow for turning a checklist into specs

1. `npx dtf doctor`. Fix anything red.
2. Read the app's source for **what each control actually does**, not just what it is
   called. A tray item called "Sign In" may only show a window whose own button starts
   the flow. Write the test to click where a user would click.
3. Read the app's source for the **exact strings**: tray labels, notification bodies,
   dialog titles, window titles, DOM ids. Put them in `lib/<app>.ts` as constants and
   cite the source file.
4. Triage every row into ✅ / 🟡 / 👤 / ❌ using §5. Write the table into `dtf/README.md`.
5. Scaffold `first-run/` and `signed-in/` (§3). Add helpers (§6).
6. Write one test per ✅/🟡 row, named `'<ID> <expected behaviour>'`.
7. Check types with `npx tsc -p dtf/tsconfig.json`. That catches non-erasable syntax.
8. Run one row: `npx dtf run first-run --grep A-04`. On failure, open `dtf-artifacts/`,
   which has the screenshot, the full AX tree JSON and the app's log. Find the node in the
   tree and fix the selector. `npx dtf inspect tree --bundle <id> --depth 10` and
   `npx dtf inspect tray` do the same live, and the Studio (`npx dtf studio`) can pick an
   element off the screen.
9. Keep assertions strict. If the app is wrong, leave the test red and write down why.
   Don't weaken it until it passes.

## 9. CLI

```
dtf run [dir] [--grep txt] [--file f.spec.ts [--line n]] [--reporter pretty,junit,json] [--retries n] [--lifecycle per-test]
dtf list [dir]                       dtf doctor                    dtf studio
dtf inspect tray|tree|notifications|dialogs|menu [--bundle id] [--depth n]
dtf record tests/x.spec.ts --launch  dtf ask "<claim>" --bundle id [--act] [--vision]
```

Exit code 1 on any failure. `dtf-artifacts/junit.xml` is produced when the `junit`
reporter is on.
