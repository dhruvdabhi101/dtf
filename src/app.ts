import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';

import type { Driver } from './drivers/driver.ts';
import type { AXNode, AppInfo, LaunchOptions, MouseButton, SelectorPath } from './types.ts';
import { Locator } from './surfaces/locator.ts';
import { TraySurface } from './surfaces/tray.ts';
import { BrowserSurface } from './surfaces/browser.ts';
import { NotificationSurface } from './surfaces/notifications.ts';
import { DialogSurface } from './surfaces/dialogs.ts';
import { MenuSurface } from './surfaces/menu.ts';
import { WindowSurface } from './surfaces/windows.ts';
import { PermissionSurface } from './surfaces/permissions.ts';
import { waitFor, sleep } from './core/wait.ts';

const run = promisify(execFile);

export type LogLine = { stream: 'stdout' | 'stderr'; line: string; at: number };

type BundleMeta = { executable: string; bundleId: string; name: string };

/**
 * Resolves a Windows shortcut (.lnk) to its target and arguments, so a Start
 * Menu entry can be the configured app path. Uses the shell's own COM object
 * through PowerShell rather than parsing the binary format.
 */
async function readShortcut(lnkPath: string): Promise<{ executable: string; args: string[] }> {
  const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${JSON.stringify(lnkPath)}); ` +
    `[Console]::Out.Write((ConvertTo-Json @{ target = $s.TargetPath; args = $s.Arguments }))`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const info = JSON.parse(stdout) as { target?: string; args?: string };
  if (!info.target) throw new Error(`${lnkPath} has no target`);
  return { executable: info.target, args: info.args ? info.args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [] : [] };
}

/** Reads the fields we need out of a .app bundle's Info.plist. */
async function readBundle(appPath: string): Promise<BundleMeta> {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
  const info = JSON.parse(stdout) as Record<string, string>;
  const exeName = info.CFBundleExecutable;
  if (!exeName) throw new Error(`${plist} has no CFBundleExecutable`);
  return {
    executable: join(appPath, 'Contents', 'MacOS', exeName),
    bundleId: info.CFBundleIdentifier ?? '',
    name: info.CFBundleName ?? info.CFBundleDisplayName ?? basename(appPath, '.app'),
  };
}

/**
 * The id the OS keys an app's privacy grants on, read without launching it:
 * the bundle id of a `.app`, or the executable path on Windows. Permissions
 * have to be set before the first launch, because an app reads them at boot.
 */
export async function appIdentity(appPath: string): Promise<string> {
  const p = resolvePath(appPath);
  if (!existsSync(p)) throw new Error(`app not found at ${p}`);
  if (p.endsWith('.app')) {
    const { bundleId } = await readBundle(p);
    if (!bundleId) throw new Error(`${p} has no CFBundleIdentifier`);
    return bundleId;
  }
  if (/\.lnk$/i.test(p)) return (await readShortcut(p)).executable;
  return p;
}

/**
 * A running application under test, plus every OS surface attached to it.
 *
 * Applications are launched by executing the binary inside the bundle directly
 * rather than via `open`. That costs a little bundle parsing but buys three
 * things that matter for testing: a real child pid, control over the
 * environment, and the app's stdout/stderr captured as test artifacts.
 */
export class DesktopApp {
  #driver: Driver;
  #proc: ChildProcess | null = null;
  #pid: number;
  #bundleId: string;
  #name: string;
  #userDataDir: string | null = null;
  #appPath: string | null = null;
  #logs: LogLine[] = [];
  #attached = false;

  readonly tray: TraySurface;
  readonly browser: BrowserSurface;
  readonly notifications: NotificationSurface;
  readonly dialogs: DialogSurface;
  readonly menu: MenuSurface;
  readonly windows: WindowSurface;
  readonly permissions: PermissionSurface;

  constructor(driver: Driver, init: { pid: number; bundleId: string; name: string }) {
    this.#driver = driver;
    this.#pid = init.pid;
    this.#bundleId = init.bundleId;
    this.#name = init.name;

    const pid = () => this.#pid;
    this.tray = new TraySurface(driver, pid);
    this.browser = new BrowserSurface(driver);
    this.notifications = new NotificationSurface(driver, () => this.#name);
    this.dialogs = new DialogSurface(driver, pid);
    this.menu = new MenuSurface(driver, pid);
    this.windows = new WindowSurface(driver, pid);
    this.permissions = new PermissionSurface(driver, () => this.#bundleId, this.dialogs, pid);
  }

  get pid() { return this.#pid; }
  get bundleId() { return this.#bundleId; }
  get name() { return this.#name; }
  get driver() { return this.#driver; }
  /** True when this app was attached to rather than launched by the framework. */
  get attached() { return this.#attached; }

  /** Everything the app wrote to stdout/stderr since launch. */
  get logs(): LogLine[] { return this.#logs; }

  logText(): string {
    return this.#logs.map((l) => `[${l.stream}] ${l.line}`).join('\n');
  }

  /**
   * A marker for "everything logged so far".
   *
   * Tests sharing one app instance (the `per-file` default) otherwise assert
   * against output from earlier tests in the same file — which turns a passing
   * negative assertion into a false failure, or worse, a false pass.
   */
  logCursor(): number {
    return this.#logs.length;
  }

  /** Fails the test if the app logged anything matching `pattern`. */
  async shouldNotLog(pattern: RegExp, opts: { since?: number } = {}): Promise<void> {
    const hit = this.#logs.slice(opts.since ?? 0).find((l) => pattern.test(l.line));
    if (hit) throw new Error(`app logged a forbidden line: [${hit.stream}] ${hit.line}`);
  }

  async waitForLog(pattern: RegExp, opts: { timeoutMs?: number; since?: number } = {}): Promise<LogLine> {
    return waitFor(async () => this.#logs.slice(opts.since ?? 0).find((l) => pattern.test(l.line)), {
      timeoutMs: opts.timeoutMs ?? 10_000,
      description: `a log line matching ${pattern}`,
    });
  }

  // ── Launching / attaching ────────────────────────────────────────────────

  static async launch(driver: Driver, opts: LaunchOptions): Promise<DesktopApp> {
    const appPath = resolvePath(opts.path);
    if (!existsSync(appPath)) throw new Error(`app not found at ${appPath}`);

    let exe = appPath;
    let bundleId = '';
    let name = basename(appPath);
    const args = [...(opts.args ?? [])];

    if (appPath.endsWith('.app')) {
      const meta = await readBundle(appPath);
      exe = meta.executable;
      bundleId = meta.bundleId;
      name = meta.name;
    } else if (/\.lnk$/i.test(appPath)) {
      const link = await readShortcut(appPath);
      exe = link.executable;
      args.unshift(...link.args);
      // Name and id come from the running process; the shortcut's name is a guess.
      name = '';
    } else if (/\.exe$/i.test(appPath)) {
      // A bare executable: its display name is the version resource's
      // FileDescription and its "bundle id" its path or AppUserModelID, both
      // of which the driver reads off the running process below.
      name = '';
    }

    let userDataDir: string | null = null;
    if (opts.isolatedUserData) {
      userDataDir = await mkdtemp(join(tmpdir(), 'dtf-userdata-'));
      args.push(`${opts.userDataArg ?? '--user-data-dir='}${userDataDir}`);
    }

    const proc = spawn(exe, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!proc.pid) throw new Error(`failed to spawn ${exe}`);

    const app = new DesktopApp(driver, { pid: proc.pid, bundleId, name });
    app.#proc = proc;
    app.#userDataDir = userDataDir;
    app.#appPath = appPath;

    for (const stream of ['stdout', 'stderr'] as const) {
      const src = proc[stream];
      if (!src) continue;
      createInterface({ input: src }).on('line', (line) => {
        app.#logs.push({ stream, line, at: Date.now() });
      });
    }

    // The process exists immediately, but its accessibility tree does not.
    // Wait until the OS actually has it registered as an application.
    await waitFor(async () => {
      const info = await driver.appInfo(proc.pid!).catch(() => undefined);
      return info && !info.terminated ? info : undefined;
    }, {
      timeoutMs: opts.timeoutMs ?? 20_000,
      intervalMs: 200,
      description: `${name} to register with the window server`,
    });

    if (!bundleId || !name) {
      const info = await driver.appInfo(proc.pid);
      app.#bundleId = bundleId || info.bundleId;
      app.#name = name || info.name;
    }

    // Do this before the app opens any windows: Chromium only builds an
    // accessibility tree for windows created after an assistive client asks.
    if (opts.chromiumAccessibility !== false) {
      await driver.setElectronAccessibility(proc.pid).catch(() => {});
    }
    return app;
  }

  /** Attaches to an app that is already running (e.g. a login-item tray app). */
  static async attach(driver: Driver, q: { bundleId?: string; name?: string; pid?: number }): Promise<DesktopApp> {
    let info: AppInfo | undefined;
    if (q.pid !== undefined) {
      info = await driver.appInfo(q.pid);
    } else {
      const matches = await driver.findApps({ bundleId: q.bundleId, name: q.name });
      if (matches.length === 0) throw new Error(`no running app matching ${JSON.stringify(q)}`);
      if (matches.length > 1) {
        throw new Error(`${matches.length} apps match ${JSON.stringify(q)}: ${JSON.stringify(matches.map((m) => m.pid))}`);
      }
      info = matches[0];
    }
    // Windows the app already opened stay opaque; ones it opens from here on
    // will be readable.
    await driver.setElectronAccessibility(info.pid).catch(() => {});
    const app = new DesktopApp(driver, { pid: info.pid, bundleId: info.bundleId, name: info.name });
    app.#attached = true;
    return app;
  }

  // ── App-level operations ─────────────────────────────────────────────────

  info(): Promise<AppInfo> { return this.#driver.appInfo(this.#pid); }
  activate(): Promise<void> { return this.#driver.activate(this.#pid); }
  hide(): Promise<void> { return this.#driver.hide(this.#pid); }

  async isRunning(): Promise<boolean> {
    const info = await this.#driver.appInfo(this.#pid).catch(() => undefined);
    return !!info && !info.terminated;
  }

  /** The app's whole accessibility tree. The first thing to print when a test fails. */
  tree(maxDepth = 8): Promise<AXNode> {
    return this.#driver.tree({ pid: this.#pid }, { maxDepth });
  }

  /** Locator rooted at the application, so it spans every window. */
  find(selector: SelectorPath): Locator {
    return new Locator(this.#driver, async () => ({ pid: this.#pid }), selector);
  }

  // ── Raw input, for the cases nothing else covers ─────────────────────────

  key(combo: string): Promise<void> { return this.#driver.key(combo); }
  type(text: string): Promise<void> { return this.#driver.type(text); }
  click(x: number, y: number, opts?: { button?: MouseButton; count?: number }): Promise<void> {
    return this.#driver.click(x, y, opts);
  }

  screenshot(outPath?: string) { return this.#driver.screenshot({ outPath }); }

  /**
   * Delivers a deep link to this app, e.g. `myapp://auth/callback?code=…`.
   *
   * This is the seam that makes browser-based sign-in testable in CI. The OAuth
   * round trip ends by redirecting to a custom scheme; firing that URL directly
   * exercises everything the app is responsible for — protocol handling, token
   * exchange, session persistence, UI transition — without automating an
   * identity provider, which in CI means 2FA prompts, bot detection and
   * credentials in your pipeline.
   *
   * The link is routed to *this* bundle explicitly. Left to LaunchServices, a
   * machine with several builds of the same app installed will often deliver it
   * to whichever one it decides owns the scheme, which is a genuinely miserable
   * failure to debug.
   */
  async openDeepLink(url: string): Promise<void> {
    await this.#driver.openUrl(url, { appPath: this.#appPath ?? undefined, background: true });
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  /**
   * Asks the app to quit, then escalates.
   *
   * Tray apps routinely ignore a polite terminate — that is often the whole
   * point of them — so the force step is not optional in practice.
   */
  async close(opts: { timeoutMs?: number; force?: boolean } = {}): Promise<void> {
    // An app we attached to was running before the test and should outlive it.
    if (this.#attached && !opts.force) return;
    const timeoutMs = opts.timeoutMs ?? 5000;
    await this.#driver.terminate(this.#pid, false).catch(() => {});

    const stopped = await waitFor(async () => !(await this.isRunning()), {
      timeoutMs, intervalMs: 200, description: 'app to exit',
    }).catch(() => false);

    if (!stopped) {
      await this.#driver.terminate(this.#pid, true).catch(() => {});
      await sleep(500);
      this.#proc?.kill('SIGKILL');
    }

    if (this.#userDataDir) {
      await rm(this.#userDataDir, { recursive: true, force: true }).catch(() => {});
      this.#userDataDir = null;
    }
  }
}
