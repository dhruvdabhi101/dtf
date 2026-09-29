import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Driver } from '../drivers/driver.ts';
import { waitFor } from '../core/wait.ts';
import { AssertionError } from '../core/errors.ts';
import { managedChrome } from '../browsers/managed.ts';
import { CdpPage } from '../browsers/cdp.ts';

/** What dtf keeps for a browser it launched: its debugging connection and the custom-scheme URLs it tried to open. */
type Isolated = { cdp: CdpPage | null; schemeUrls: string[]; waiters: Set<() => void> };
const isolated = new WeakMap<object, Isolated>();

/**
 * The browser, as a testable surface.
 *
 * Desktop apps hand off to the system browser for OAuth, for "open docs", for
 * billing portals. That handoff leaves the app entirely, so nothing inside the
 * app can observe it — but the browser is just another accessible application,
 * so from out here it is perfectly visible.
 *
 * The useful thing this enables is asserting the *handoff* without automating
 * the identity provider: that clicking Sign In opened the right authorize URL,
 * with the right client_id, redirect_uri, scopes and PKCE challenge. That is the
 * part your app is responsible for. What the IdP does with the credentials is
 * the IdP's problem, and driving it in CI buys flakiness, 2FA prompts and bot
 * detection in exchange for very little signal.
 */

/**
 * Well-known browsers, used as a hint rather than as a filter.
 *
 * Hardcoding this list alone is a trap: the machine this was first run on
 * defaults to a browser that is on nobody's list, and the handoff test failed
 * with "no browser is open" while a browser sat there with the page loaded. The
 * default handler is resolved from LaunchServices instead, and this list only
 * catches the non-default browsers that might also be running.
 */
const KNOWN_BROWSERS = [
  'com.apple.Safari',
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'com.microsoft.edgemac',
  'org.mozilla.firefox',
  'company.thebrowser.Browser', // Arc
  'com.brave.Browser',
  'net.imput.helium',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi',
];

/**
 * Turns an address-bar value into a URL. Chromium hides the scheme when the
 * field is not focused ("app.example.com/login?…"), so a bare host+path is
 * read as https. Anything that is not URL-shaped (a search query) is rejected.
 */
export function toUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v || /\s/.test(v)) return undefined;
  // A scheme is `x://…`, or one of the few that have no slashes. `host:port`
  // looks like a scheme too, so it is not treated as one.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^(about|data|mailto|file|blob|javascript):/i.test(v)) return v;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]|$)/i.test(v)) return `https://${v}`;
  return undefined;
}

/** Chromium-family browsers `launchIsolated` can drive, most common first. */
const CHROMIUM_BROWSERS = [
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'company.thebrowser.Browser', // Arc
  'org.chromium.Chromium',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
  'com.google.Chrome.canary',
  'net.imput.helium',
];

/** Browsers that ignore Chromium's switches, so can never be the isolated browser. */
const NOT_CHROMIUM = ['com.apple.Safari', 'com.apple.SafariTechnologyPreview', 'org.mozilla.firefox'];

const BROWSERISH =/browser|chrome|chromium|safari|firefox|webkit|arc|brave|edge|opera|vivaldi|helium|orion|zen/i;

const labelOf = (n: { title?: string; description?: string }) => n.title || n.description || '';

/**
 * The "open the app" button(s) of a browser's external-protocol prompt.
 *
 * Chrome labels the button "Open <App>" (the name is unknown and localised);
 * Edge says "This site is trying to open <App>." over a bare "Open". A bare
 * "Open" only counts beside a "Cancel", so no other "Open" in the browser's
 * chrome is mistaken for it. Chromium's Views controls put their label in
 * AXDescription rather than AXTitle, so matching on title alone finds nothing.
 */
function openButtons<T extends { title?: string; description?: string }>(buttons: T[]): T[] {
  const named = buttons.filter((b) => /^open\s+\S/i.test(labelOf(b)));
  if (named.length) return named;
  return buttons.some((b) => /^cancel$/i.test(labelOf(b))) ? buttons.filter((b) => /^open$/i.test(labelOf(b))) : [];
}

export type OpenPage = {
  browser: string;
  bundleId: string;
  pid: number;
  url: string;
  title: string;
};

export class BrowserSurface {
  #driver: Driver;
  #defaultBundleId: string | null | undefined;
  #axEnabled = new Set<number>();

  constructor(driver: Driver) {
    this.#driver = driver;
  }

  /**
   * The bundle id macOS will actually hand an https URL to.
   *
   * Read from LaunchServices rather than assumed, because "the browser" is
   * whatever the user set, not whatever is famous.
   */
  async defaultBrowser(): Promise<string | undefined> {
    if (this.#defaultBundleId !== undefined) return this.#defaultBundleId ?? undefined;
    this.#defaultBundleId = await this.#driver.defaultUrlHandler('https').catch(() => null);
    return this.#defaultBundleId ?? undefined;
  }

  /** Every page currently open in every running browser. */
  async pages(): Promise<OpenPage[]> {
    const running = await this.#driver.listApps();
    const preferred = await this.defaultBrowser();

    const browsers = running.filter(
      (a) =>
        a.bundleId === preferred ||
        KNOWN_BROWSERS.includes(a.bundleId) ||
        (a.policy !== 'accessory' && BROWSERISH.test(`${a.bundleId} ${a.name}`)),
    );

    const out: OpenPage[] = [];
    for (const browser of browsers) {
      // Chromium browsers hide their render tree from accessibility clients
      // exactly like Electron apps do, and for the same reason. Without this,
      // the omnibox and the document URL are both invisible.
      if (!this.#axEnabled.has(browser.pid)) {
        await this.#driver.setElectronAccessibility(browser.pid).catch(() => {});
        this.#axEnabled.add(browser.pid);
      }

      const windows = await this.#driver.windowList(browser.pid).catch(() => []);
      if (windows.length === 0) continue;

      // Try accessibility per window first; if the whole browser is opaque
      // (every Chromium-based one is), ask it directly via AppleScript.
      let scripted: string | undefined;
      for (const window of windows) {
        let url = await this.#urlOf(window.ref);
        if (!url) {
          scripted ??= await this.#driver.browserUrlViaScript(browser.bundleId).catch(() => undefined);
          url = scripted;
        }
        if (url && /^[a-z][a-z0-9+.-]*:/i.test(url)) {
          out.push({
            browser: browser.name,
            bundleId: browser.bundleId,
            pid: browser.pid,
            url,
            title: window.title,
          });
        }
      }
    }
    return out;
  }

  /**
   * Reads the URL of one browser window.
   *
   * Two sources, because browsers disagree. The rendered document's AXURL is
   * authoritative but only exists once something has loaded; the address bar is
   * always present but shows what the user sees, which during a redirect chain
   * may lag or be prettified. Document first, address bar as fallback.
   */
  async #urlOf(windowRef: string): Promise<string | undefined> {
    const web = await this.#driver
      .find({ ref: windowRef }, [{ role: 'AXWebArea', maxDepth: 14 }], { maxDepth: 0 })
      .catch(() => undefined);

    if (web) {
      const { attributes } = await this.#driver
        .elementAttributes(web.ref)
        .catch(() => ({ attributes: {} as Record<string, unknown> }));
      const url = attributes.AXURL;
      if (typeof url === 'string' && url) return url;
    }

    // The address bar. Chromium browsers (Chrome, Edge, Brave, Helium, …) label
    // it "Address and search bar" rather than giving it an identifier.
    const omnibox = [
      { identifier: 'WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD' },
      { identifier: 'address-bar' },
      { identifier: 'omnibox' },
      { text: 'Address and search bar' },
    ];
    for (const sel of omnibox) {
      const field = await this.#driver
        .find({ ref: windowRef }, [{ role: 'AXTextField', ...sel, maxDepth: 20 }], { maxDepth: 0 })
        .catch(() => undefined);
      const url = toUrl(field?.value);
      if (url) return url;
    }

    const anyField = await this.#driver
      .find({ ref: windowRef }, [{ role: 'AXTextField', maxDepth: 10 }], { maxDepth: 0 })
      .catch(() => undefined);
    return toUrl(anyField?.value);
  }

  /** Waits for any browser to be showing a URL matching `pattern`. */
  async waitForUrl(pattern: string | RegExp, opts: { timeoutMs?: number } = {}): Promise<OpenPage> {
    return waitFor(async () => {
      const pages = await this.pages();
      return pages.find((p) =>
        pattern instanceof RegExp ? pattern.test(p.url) : p.url.includes(pattern),
      );
    }, {
      timeoutMs: opts.timeoutMs ?? 20_000,
      intervalMs: 400,
      description: `a browser page matching ${pattern}`,
    });
  }

  async shouldOpenUrl(pattern: string | RegExp, opts: { timeoutMs?: number } = {}): Promise<OpenPage> {
    try {
      return await this.waitForUrl(pattern, opts);
    } catch {
      const pages = await this.pages();
      const hint = pages.length === 0
        ? '\nNo browser page was found at all. Usually that means none opened: check the app\n' +
          'actually started the hand-off (its log), and that the browser window is on the current\n' +
          'Space and not minimised (hidden windows are invisible to accessibility). If a page IS\n' +
          'open, its URL could not be read: the address bar is used first, then AppleScript, which\n' +
          'needs the Automation permission for the process running the tests (System Settings >\n' +
          'Privacy & Security > Automation; in CI pre-grant kTCCServiceAppleEvents, see docs/CI.md).'
        : '';
      throw new AssertionError(
        `expected a browser page matching ${pattern}.\n` +
          `Open pages: ${JSON.stringify(pages.map((p) => ({ browser: p.browser, url: p.url })), null, 2)}${hint}`,
      );
    }
  }

  /**
   * Parsed query parameters of a matched page.
   *
   * This is what makes an OAuth handoff assertion concrete: check `client_id`,
   * `redirect_uri`, `scope`, `code_challenge_method` rather than just "a browser
   * opened something".
   */
  async urlParams(pattern: string | RegExp, opts: { timeoutMs?: number } = {}): Promise<URLSearchParams> {
    const page = await this.waitForUrl(pattern, opts);
    return new URL(page.url).searchParams;
  }

  /**
   * Launches a browser on a throwaway profile, with its page content readable.
   *
   * This is what makes a real email-and-password login testable. Two flags do
   * the work:
   *
   *   --user-data-dir  a scratch profile, so the test never touches (or is
   *                    influenced by) the developer's real browser, and every
   *                    run starts logged out.
   *   --force-renderer-accessibility
   *                    Chromium builds no accessibility tree unless an assistive
   *                    client asks, and unlike Electron it refuses the
   *                    AXManualAccessibility attribute. Without this flag a login
   *                    form is an empty rectangle from the outside; with it,
   *                    every field and button is addressable.
   *
   * Returns a normal `DesktopApp`, so the whole locator API works against the
   * page: `session.find('"Email"')`, `.fill(...)`, `.click()`.
   *
   * Firefox is not Chromium and ignores both flags; use a Chromium-family
   * browser for this, which is also what your users' OAuth flow will hit.
   */
  async launchIsolated(
    url: string,
    opts: { bundleId?: string; extraArgs?: string[]; timeoutMs?: number } = {},
  ): Promise<import('../app.ts').DesktopApp> {
    const { bundleId, appPath } = await this.#chromiumBrowser(opts.bundleId);

    const { DesktopApp } = await import('../app.ts');
    const profile = await mkdtemp(join(tmpdir(), 'dtf-browser-'));

    const session = await DesktopApp.launch(this.#driver, {
      path: appPath,
      timeoutMs: opts.timeoutMs ?? 30_000,
      args: [
        `--user-data-dir=${profile}`,
        '--force-renderer-accessibility',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,OptimizationGuideModelDownloading',
        // A debugging connection: see below.
        '--remote-debugging-port=0',
        // Edge on Windows signs a new profile into the machine's Microsoft
        // account on its own and then covers the page with its sync prompt.
        // InPrivate has no account, no sync and still starts logged out.
        ...(/msedge/i.test(appPath) ? ['--inprivate'] : []),
        ...(opts.extraArgs ?? []),
        url,
      ],
    });
    // A browser started from a background process opens behind whatever is in
    // front (Windows' foreground lock), so bring its window up: typing into
    // the page and the Open prompt's keyboard fallback both need it in front.
    await waitFor(async () => (await this.#driver.windowList(session.pid).catch(() => [])).length > 0 || undefined, {
      timeoutMs: 15_000, intervalMs: 250, description: 'the browser window',
    }).catch(() => {});
    await this.#driver.activate(session.pid).catch(() => {});

    // Over the debugging connection: (1) make sure the page actually loads. A
    // URL passed on the command line sometimes leaves the first tab on
    // about:blank ("Untitled"), and a login form never appears. (2) record
    // every custom-scheme navigation (myapp://callback?…) the page makes, so
    // `waitForProtocolUrl` can hand it to the app directly. Without it the
    // only route is the OS protocol handler, which on Windows starts a new
    // app process that knows nothing of a test's --user-data-dir.
    const state: Isolated = { cdp: null, schemeUrls: [], waiters: new Set() };
    isolated.set(session, state);
    try {
      const cdp = await CdpPage.connect(profile);
      state.cdp = cdp;
      cdp.on('Page.frameRequestedNavigation', ({ url: to }: { url: string }) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(to) && !/^(https?|about|data|blob|javascript|chrome|edge|file):/i.test(to)) {
          state.schemeUrls.push(to);
          for (const w of state.waiters) w();
        }
      });
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await new Promise((r) => setTimeout(r, 1500));
      const at = await cdp.evaluate<string>('location.href').catch(() => '');
      if (!at || at === 'about:blank') await cdp.send('Page.navigate', { url });
    } catch {
      // No debugging connection (a browser that refuses the switch): the
      // command-line URL is all there is, as before.
    }
    return session;
  }

  /**
   * The next custom-scheme URL (`scheme://…`) a browser from `launchIsolated`
   * navigated to, such as an OAuth redirect back into the app. Resolves with
   * one already seen. The browser's own "Open <App>?" prompt is left alone:
   * hand the URL to the app yourself, e.g. with `app.openDeepLink(url)`.
   */
  async waitForProtocolUrl(session: object, scheme: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    const state = isolated.get(session);
    if (!state?.cdp) throw new Error('waitForProtocolUrl needs a browser from launchIsolated with a debugging connection');
    const prefix = `${scheme.replace(/:\/*$/, '')}:`.toLowerCase();
    const find = () => state.schemeUrls.find((u) => u.toLowerCase().startsWith(prefix));
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return await new Promise<string>((resolve, reject) => {
      const hit = find();
      if (hit) return resolve(hit);
      const timer = setTimeout(() => {
        state.waiters.delete(check);
        reject(new AssertionError(`the browser never navigated to a ${prefix}// URL within ${timeoutMs}ms`));
      }, timeoutMs);
      const check = () => {
        const u = find();
        if (!u) return;
        clearTimeout(timer);
        state.waiters.delete(check);
        resolve(u);
      };
      state.waiters.add(check);
    });
  }

  /** Presses Cancel on the browser's "Open <App>?" prompt, if `pid` is showing one. True if it did. */
  async cancelProtocolPrompt(pid: number): Promise<boolean> {
    const buttons = await this.#driver.findAll({ pid }, [{ role: 'AXButton', maxDepth: 20 }]).catch(() => []);
    if (!openButtons(buttons).length) return false;
    const cancel = buttons.filter((b) => /^cancel$/i.test(labelOf(b))).pop();
    if (!cancel) return false;
    await this.#driver.elementAction(cancel.ref, 'AXPress').catch(() => {});
    return true;
  }

  /**
   * Picks the browser `launchIsolated` drives. dtf's own Chrome for Testing
   * comes first when `dtf install-browser` has put it there: it behaves the
   * same on every machine. Otherwise it has to be an installed Chromium-based
   * browser: Safari and Firefox ignore the profile and accessibility flags, and
   * Safari does not even open the URL passed on its command line, so "the
   * default browser" is only used when it qualifies. Otherwise the first
   * installed Chromium browser wins.
   */
  async #chromiumBrowser(requested?: string): Promise<{ bundleId: string; appPath: string }> {
    if (!requested) {
      const managed = await managedChrome();
      if (managed) return { bundleId: 'chrome-for-testing', appPath: managed.path };
    }
    const candidates = requested ? [requested] : [
      (await this.defaultBrowser()) ?? '',
      ...CHROMIUM_BROWSERS,
    ].filter((id) => id && !NOT_CHROMIUM.includes(id));

    for (const id of [...new Set(candidates)]) {
      const appPath = await this.#driver.appPathForBundleId(id).catch(() => undefined);
      if (appPath) return { bundleId: id, appPath };
    }
    throw new Error(
      requested
        ? `no installed app found for bundle id ${requested}`
        : `launchIsolated needs a Chromium-based browser (Chrome, Edge, Brave, Arc, …) and none is installed; ` +
            `the default browser (${await this.defaultBrowser()}) is not Chromium-based`,
    );
  }

  /**
   * Whether the browser process `pid` is showing its "Open <App>?" prompt
   * right now (Chrome's "Open <App>", Edge's "Open" / "Cancel"). Looks only;
   * presses nothing.
   */
  async hasProtocolPrompt(pid: number): Promise<boolean> {
    const buttons = await this.#driver.findAll({ pid }, [{ role: 'AXButton', maxDepth: 20 }]).catch(() => []);
    return openButtons(buttons).length > 0;
  }

  /**
   * Approves the browser's "Open <App>?" confirmation.
   *
   * When an OAuth redirect targets a custom scheme, Chromium does not hand off
   * silently — it asks first. That prompt is not a native dialog: it is a Views
   * bubble inside the browser window's own accessibility tree, so it never shows
   * up in `dialogs.list()` and a test looking there waits forever while sign-in
   * sits one click from finishing.
   *
   * Two things make this fiddly, and both are handled here:
   *   - Chromium's Views controls put their label in AXDescription, not AXTitle,
   *     so matching on title alone silently finds nothing.
   *   - AXPress on a Views button frequently reports success and does nothing, so
   *     a real synthetic click is used as the fallback and the result is verified
   *     rather than assumed.
   *
   * Pass `always: true` to tick "Always allow", persisting the decision for the
   * life of the browser profile — worth doing when a suite signs in repeatedly.
   */
  async confirmProtocolLaunch(
    session: import('../app.ts').DesktopApp,
    opts: { always?: boolean; timeoutMs?: number; settleMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const candidates = await waitFor(async () => {
      const buttons = await this.#driver
        .findAll({ pid: session.pid }, [{ role: 'AXButton', maxDepth: 20 }])
        .catch(() => []);
      const found = openButtons(buttons);
      return found.length ? found : undefined;
    }, { timeoutMs, intervalMs: 300, description: "the browser's \"Open <App>?\" confirmation" })
      .catch(async () => {
        const buttons = await this.#driver
          .findAll({ pid: session.pid }, [{ role: 'AXButton', maxDepth: 20 }])
          .catch(() => []);
        throw new AssertionError(
          'the browser never showed an "Open <App>?" confirmation.\n' +
            `Buttons visible in ${session.name}: ${JSON.stringify(buttons.map(labelOf).filter(Boolean))}\n` +
            'If the redirect targets a custom scheme, check the app is installed and registered\n' +
            'for it (lsregister), and that the redirect actually fired.',
        );
      });

    if (opts.always) {
      const boxes = await this.#driver
        .findAll({ pid: session.pid }, [{ role: 'AXCheckBox', maxDepth: 20 }])
        .catch(() => []);
      const always = boxes.find((b) => /always allow/i.test(labelOf(b)));
      if (always) {
        // AXPress, for the same reason as the button below: a synthetic click
        // lands outside the live widget and dismisses the whole bubble.
        await this.#driver.elementAction(always.ref, 'AXPress').catch(() => {});
      }
    }

    // Press it via accessibility, not with a synthetic mouse click.
    //
    // Both were tried against a real redirect. A click at the button's reported
    // coordinates *dismisses* the bubble without launching anything — Chromium
    // mirrors the widget in its accessibility tree, so several candidates report
    // identical rects and the coordinates do not reliably land on the live one.
    // AXPress addresses the element itself and completes the hand-off.
    //
    // Candidates are tried newest-first because the live widget is the last one
    // Chromium publishes; each attempt is confirmed by watching the bubble go,
    // and a failed query counts as "still there" so a transient error can never
    // be mistaken for success.
    const stillOpen = async () => {
      const buttons = await this.#driver.findAll({ pid: session.pid }, [{ role: 'AXButton', maxDepth: 20 }]);
      return openButtons(buttons).length > 0;
    };

    // In front, so the Enter fallback below reaches this browser and nothing else.
    await this.#driver.activate(session.pid).catch(() => {});

    // Let the bubble finish appearing before pressing it. Caught early, mid
    // animation, the widget accepts the press and simply closes without ever
    // launching the app — which looks exactly like success from the outside.
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 2000));
    const settled = await this.#driver
      .findAll({ pid: session.pid }, [{ role: 'AXButton', maxDepth: 20 }])
      .then(openButtons)
      .catch(() => candidates);

    for (const candidate of [...(settled.length ? settled : candidates)].reverse()) {
      await this.#driver.elementAction(candidate.ref, 'AXPress').catch(() => {});
      const gone = await waitFor(async () => !(await stillOpen()), {
        timeoutMs: 3000, intervalMs: 250, description: 'the confirmation to close',
      }).catch(() => false);
      if (gone) return;
    }

    // Last resort: the Open button is the dialog's default action.
    await this.#driver.key('enter');
    await waitFor(async () => !(await stillOpen()), {
      timeoutMs: 3000, intervalMs: 250, description: 'the confirmation to close',
    }).catch(() => {
      throw new AssertionError('the browser\'s "Open <App>?" confirmation could not be dismissed');
    });
  }

  /** Closes every browser window whose URL matches — cleanup after a handoff test. */
  async closeMatching(pattern: string | RegExp): Promise<number> {
    let closed = 0;
    for (const page of await this.pages()) {
      const hit = pattern instanceof RegExp ? pattern.test(page.url) : page.url.includes(pattern);
      if (!hit) continue;
      const windows = await this.#driver.windowList(page.pid).catch(() => []);
      for (const window of windows) {
        if ((await this.#urlOf(window.ref)) === page.url) {
          const close = await this.#driver
            .find({ ref: window.ref }, [{ subrole: 'AXCloseButton', maxDepth: 3 }], { maxDepth: 0 })
            .catch(() => undefined);
          if (close) {
            await this.#driver.elementAction(close.ref, 'AXPress').catch(() => {});
            closed++;
          }
        }
      }
    }
    return closed;
  }
}
