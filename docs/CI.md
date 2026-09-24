# Running dtf in CI

Short version:

- **Use a self-hosted Mac with a real logged-in desktop session.** GitHub-hosted
  macOS runners cannot grant Accessibility, and that permission is mandatory.
- **Pre-grant permissions. Never try to click through a consent dialog** — macOS
  rejects synthetic clicks on TCC prompts by design.
- **Do not automate the identity provider.** Assert the OAuth handoff, then fire
  the callback deep link yourself with a CI service-account token.

`scripts/ci-setup-macos.sh` provisions a runner. `.github/workflows/desktop-tests.yml`
is a working workflow.

---

## 1. Why not a hosted runner

Two hard blockers, in order of severity.

**Accessibility cannot be granted.** It lives in the SIP-protected *system* TCC
database, which only `tccd` may write to. Granting it needs either SIP disabled
or an MDM-pushed PPPC profile, and you control neither on a hosted runner. This
has been [open on actions/runner-images since 2020](https://github.com/actions/runner-images/issues/1567).

**Consent dialogs reject synthetic input.** You cannot script your way past the
first blocker either: macOS specifically hardened TCC prompts against
`CGEvent`-synthesised clicks, precisely so that automation cannot approve
permissions on the user's behalf ([Jamf's write-up](https://www.jamf.com/blog/synthetic-reality/)
is the readable account). `AXPress` on the Allow button is refused the same way.

So: pre-grant, on a machine you control.

> Hosted images have shipped with SIP in [varying states](https://github.com/actions/runner-images/issues/8162)
> across versions. Don't build on that — it is not a supported guarantee and has
> changed between images before.

## 2. The runner must be a LaunchAgent

The single most common cause of a mysteriously broken desktop suite.

A runner installed the usual way (`svc.sh install`, a LaunchDaemon) has **no
window server connection**. There is no accessibility tree to read, screenshots
come back black, and every test fails in a way that looks like a bug in your app.

The runner has to be a **LaunchAgent**, running as a user who is **logged in**:

1. Enable auto-login for a dedicated CI user (System Settings → Users & Groups).
2. Install the runner as a LaunchAgent in that user's session, not as a daemon.
3. Disable the screen saver and screen lock. A locked screen detaches the session
   and produces exactly the same symptoms.
4. Keep the machine awake — `caffeinate -dimsu`.

The setup script checks this first and refuses to continue without it:

```bash
launchctl managername   # must print "Aqua"
```

On AWS EC2 Mac instances this is the usual stumbling block; the LaunchAgent
approach is what fixes it.

## 3. Pre-granting permissions

Two supported routes.

### Route A — SIP off (dedicated VM or Mac mini)

Simplest for a single runner. Boot to recovery, `csrutil disable`, reboot, then:

```bash
sudo ./scripts/ci-setup-macos.sh --app-bundle-id com.example.app
```

The script writes grants straight into the system TCC database. It builds the row
from the live schema rather than hardcoding a column list, because Apple has
added columns to that table in most releases and hardcoded SQL breaks on the next
OS upgrade. It restarts `tccd` afterwards — without that the grants only take
effect at next boot.

### Route B — MDM + PPPC profile (fleet, SIP stays on)

The supported-by-Apple route, and the only one if SIP must stay on. Push a
Privacy Preferences Policy Control profile granting your runner binary the
services below. It needs MDM enrolment — a locally installed profile will not be
honoured for PPPC.

### What to grant, and what each one buys

| Service | Granted to | Needed for |
|---|---|---|
| `kTCCServiceAccessibility` | test runner binary | **Mandatory.** Reading the AX tree, synthesising input. Nothing works without it. |
| `kTCCServiceScreenCapture` | test runner binary | Screenshots on failure. Without it they are blank. |
| `kTCCServiceAppleEvents` | test runner binary | Reading browser URLs for OAuth handoff assertions. |
| `kTCCServiceSystemPolicyAllFiles` | test runner binary | `app.permissions.status()` reading TCC.db. Returns `'unknown'` without it. |
| whatever your app asks for | **app bundle id** | So the app never blocks on a prompt nothing can click. |

That last row matters. For a screen-recording app, pre-grant
`kTCCServiceScreenCapture` to the *app's* bundle id too, or it sits waiting on a
consent dialog forever.

## 4. Authentication

This is the part people get stuck on, so here it is concretely. The flow:

```
click Sign In → app opens system browser → user authenticates at the IdP
              → IdP redirects to myapp://auth?code=… → app exchanges token
```

That crosses two process boundaries. Split it, and automate only the halves you
own.

### Tier 1 — assert the handoff (fast, deterministic, every commit)

Your app is responsible for constructing the authorize URL correctly. A wrong
`redirect_uri` or a dropped PKCE challenge breaks sign-in for every user, and
nothing inside the app's window can see it.

If the app logs the URL it opens, assert on that — no permissions, no browser:

```ts
await app.tray.click('Sign in');

const line = await app.waitForLog(/signin-opening-browser url=/);
const params = new URL(line.line.split('url=')[1]).searchParams;

if (params.get('redirect_uri') !== 'myapp://auth') throw new Error('wrong redirect_uri');
if (params.get('code_challenge_method') !== 'S256') throw new Error('PKCE missing');
```

If it doesn't log, read the real browser:

```ts
const page = await app.browser.shouldOpenUrl(/auth\.example\.com\/authorize/);
const params = new URL(page.url).searchParams;
```

`app.browser` resolves the *actual* default browser from LaunchServices rather
than guessing — worth knowing that Chromium-based browsers refuse
`AXManualAccessibility`, so their URL is read through AppleScript, which is why
`kTCCServiceAppleEvents` is on the grant list. Calls are timeout-guarded so a
missing grant fails in seconds instead of hanging on a consent dialog.

### Tier 2 — assert the return (the important one)

Skip the IdP entirely. Mint a token for a CI service account and deliver the
callback yourself:

```ts
test('a callback deep link signs the app in', async ({ app }) => {
  await app.openDeepLink(`myapp://auth?token=${process.env.DTF_AUTH_TOKEN}&email=ci@example.com`);

  await app.waitForLog(/auth-success/);
  const menu = await app.tray.open();
  await menu.shouldHaveItem('Signed in as ci@example.com');
});
```

This exercises everything you actually own: protocol handling, token exchange,
session persistence, and the UI transition. Test the failure paths too — a
callback with no token, an expired token, a token for the wrong audience.

`openDeepLink` routes to *your* bundle explicitly rather than letting
LaunchServices choose. That matters more than it sounds: a machine with several
builds of the same app installed (a release build, `dist/mac-arm64`, an old
worktree) has several claimants on the same scheme, and LaunchServices will
cheerfully deliver your callback to the wrong one. It is a genuinely horrible
failure to debug.

Also cover the **cold-launch** path, which is a different code path and a common
source of bugs — the URL arrives in `argv`, not through `open-url`:

```ts
const app = await DesktopApp.launch(driver, {
  path: '/Applications/YourApp.app',
  args: [`myapp://auth?token=${process.env.DTF_AUTH_TOKEN}`],
});
```

### Tier 3 — pre-seeded session (for everything else)

Most tests want to *start* signed in, not test signing in. Keep a fixture user-data
directory with a valid session and copy it in, or run Tier 2 once in `beforeAll`.

### Tier 4 — the real email-and-password login

If the identity provider is **your own**, with no CAPTCHA and no 2FA on the test
account, there is nothing un-automatable here and one test covering the real
round trip is worth having:

```ts
const browser = await app.browser.launchIsolated(authorizeUrl);

await browser.find('textfield[title=Email]').fill(process.env.DTF_TEST_EMAIL);
await browser.find('textfield[title=Password]').fill(process.env.DTF_TEST_PASSWORD);
await browser.find('button[title="Sign in"]').click();

await app.browser.confirmProtocolLaunch(browser);   // the "Open <App>?" prompt
await app.waitForLog(/auth-success/);
```

`launchIsolated` runs the browser on a throwaway profile with
`--force-renderer-accessibility`. That second flag is the whole trick: Chromium
builds no accessibility tree unless an assistive client asks, and unlike Electron
it refuses `AXManualAccessibility` — so without it a login form is an empty
rectangle from outside the process. With it, every field and button is
addressable, and the throwaway profile means each run starts logged out.

Three things about this are worth knowing, because each one cost a debugging
session:

- **Chromium's Views controls label themselves in `AXDescription`, not
  `AXTitle`.** Matching on title alone silently finds nothing.
- **Press the confirmation with `AXPress`, never a synthetic click.** A click at
  the button's reported coordinates *dismisses* the bubble without launching
  anything: Chromium mirrors the widget in its accessibility tree, so several
  candidates report identical rects and the coordinates do not reliably land on
  the live one. `confirmProtocolLaunch` handles this.
- **Let the bubble settle before pressing it.** Caught mid-animation it accepts
  the press and closes without launching — indistinguishable from success unless
  you assert on the app afterwards, which is why the example ends with
  `waitForLog`.

Keep it to **one or two tests**. It is an order of magnitude slower than the
deep-link path and depends on a service you do not control, so let Tier 2 carry
the bulk of the coverage.

### What not to do

Driving a **third-party** IdP's login page (Google, Microsoft, Okta) with real
credentials. There you get 2FA prompts, bot detection, CAPTCHAs, rate limits and
provider credentials in your pipeline, in exchange for testing someone else's
login form. Run that nightly at most, against a dedicated test tenant, and treat
failures as advisory.

Use a dedicated CI service account either way — never a real user's credentials —
and keep them in CI secrets, not in the repo.

## 5. Permission flows in CI

You can test that the app *asks* correctly, and that it degrades when denied:

```ts
await app.permissions.reset('ScreenCapture');   // re-arms the first-run prompt
// relaunch, trigger the feature
await app.permissions.shouldPrompt();
```

You cannot grant from a test — that is the same hardening described in §1. So:

- **Pre-grant in CI** and test the happy path.
- **Reset and assert the prompt appears** to test the first-run flow.
- **Test the denied path** by resetting and leaving it denied.

A separate, valuable test: assert the app prompts *once*, not on every launch.
Repeated prompts are a top support complaint for recording apps.

```ts
await app.permissions.shouldNotPrompt({ withinMs: 5000 });
```

## 6. Hygiene

- **`concurrency` with `cancel-in-progress: false`.** These tests own the shared
  desktop. Two jobs on one machine move the mouse out from under each other.
- **Kill strays in an `always()` step.** A cancelled job leaves the app running,
  and it holds a tray slot for the next run.
- **Upload `dtf-artifacts/` on failure.** Screenshot, full AX tree JSON, and the
  app's stdout/stderr. Those three are what let you tell "wrong state" from
  "wrong selector" after the fact, on a machine you cannot see.
- **`retries: 1`.** Desktop UI has genuine timing variance. More than one retry
  hides real flakiness.
- **Run `dtf doctor` as a step.** Environment problems cause most red suites; this
  turns them into one legible line.

## Sources

- [actions/runner-images#1567 — Accessibility permissions on hosted runners](https://github.com/actions/runner-images/issues/1567)
- [actions/runner-images#8162 — SIP state across images](https://github.com/actions/runner-images/issues/8162)
- [Jamf — Synthetic Reality: breaking macOS one click at a time](https://www.jamf.com/blog/synthetic-reality/)
- [Electron — Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)
