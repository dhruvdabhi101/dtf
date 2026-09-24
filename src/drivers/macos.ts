import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { NativeHelper } from '../core/rpc.ts';
import { UnsupportedError } from '../core/errors.ts';
import type { Driver, PreflightCheck, Root, ScreenshotOptions, TreeOptions } from './driver.ts';
import type {
  AXNode, AppInfo, Dialog, ElementContext, MouseButton, Notification, Rect,
  RecordedEvent, Selector, TrayContent, TrayItem, WindowInfo,
} from '../types.ts';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(HERE, '..', '..', 'native', 'macos', 'bin', 'dtfd-macos');
const BUILD_SCRIPT = join(HERE, '..', '..', 'native', 'macos', 'build.sh');

/** TCC's internal service identifiers, keyed by the friendly names we expose. */
const TCC_SERVICES: Record<string, string> = {
  Accessibility: 'kTCCServiceAccessibility',
  ScreenCapture: 'kTCCServiceScreenCapture',
  Camera: 'kTCCServiceCamera',
  Microphone: 'kTCCServiceMicrophone',
  Location: 'kTCCServiceLocation',
  Calendar: 'kTCCServiceCalendar',
  Reminders: 'kTCCServiceReminders',
  Contacts: 'kTCCServiceAddressBook',
  Photos: 'kTCCServicePhotos',
  AppleEvents: 'kTCCServiceAppleEvents',
  SystemPolicyAllFiles: 'kTCCServiceSystemPolicyAllFiles',
  SystemPolicyDesktopFolder: 'kTCCServiceSystemPolicyDesktopFolder',
  SystemPolicyDocumentsFolder: 'kTCCServiceSystemPolicyDocumentsFolder',
  SystemPolicyDownloadsFolder: 'kTCCServiceSystemPolicyDownloadsFolder',
  ListenEvent: 'kTCCServiceListenEvent',
  PostEvent: 'kTCCServicePostEvent',
};

const USER_TCC_DB = join(process.env.HOME ?? '', 'Library/Application Support/com.apple.TCC/TCC.db');

export class MacOSDriver implements Driver {
  readonly platform = 'darwin';
  readonly platformName = 'macOS';
  #helper: NativeHelper;
  #unsubscribeRecord: (() => void) | null = null;

  constructor(opts: { onStderr?: (l: string) => void } = {}) {
    this.#helper = new NativeHelper(HELPER_PATH, { onStderr: opts.onStderr });
  }

  async start(): Promise<void> {
    if (!existsSync(HELPER_PATH)) {
      // First run, or a fresh checkout: build the helper on demand.
      await run('/bin/bash', [BUILD_SCRIPT]).catch((err) => {
        throw new Error(
          `native helper is missing and could not be built.\n` +
            `Run: bash ${BUILD_SCRIPT}\n` +
            `The Xcode Command Line Tools are required (xcode-select --install).\n${err}`,
        );
      });
    }
    await this.#helper.start();
  }

  stop() { return this.#helper.stop(); }
  gc() { return this.#helper.gc(); }

  async preflight(): Promise<PreflightCheck[]> {
    // A Focus mode silently suppresses notification banners, which makes every
    // notification assertion fail for a reason that is invisible in the output.
    const focus = await run('/usr/bin/defaults', [
      'read', `${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`,
    ]).then((r) => r.stdout.includes('"assertionDetails"')).catch(() => false);
    return [{
      name: 'Do Not Disturb',
      ok: focus ? 'warn' : true,
      detail: focus
        ? 'a Focus mode appears to be ON — notification banners will be suppressed and notification tests will fail'
        : 'off — notification banners will be delivered',
    }];
  }

  // ── Runner permissions ───────────────────────────────────────────────────

  async checkAutomationPermission(prompt = false) {
    const r = await this.#helper.call<{ trusted: boolean }>('perm.accessibility', { prompt });
    return {
      granted: r.trusted,
      detail: r.trusted
        ? 'Accessibility permission granted'
        : 'The process running the tests needs Accessibility permission. ' +
          'Grant it in System Settings > Privacy & Security > Accessibility, ' +
          'adding the terminal or CI agent binary that runs the test command.',
    };
  }

  checkScreenRecordingPermission() {
    return this.#helper.call<{ granted: boolean }>('perm.screenRecording');
  }

  // ── Applications ─────────────────────────────────────────────────────────

  listApps() { return this.#helper.call<AppInfo[]>('app.list'); }
  findApps(q: { bundleId?: string; name?: string }) { return this.#helper.call<AppInfo[]>('app.find', q); }
  appInfo(pid: number) { return this.#helper.call<AppInfo>('app.info', { pid }); }
  async activate(pid: number) { await this.#helper.call('app.activate', { pid }); }
  setElectronAccessibility(pid: number) {
    return this.#helper.call<{ manualAccessibility: boolean; enhancedUserInterface: boolean }>(
      'app.enableElectronAccessibility', { pid },
    );
  }
  async hide(pid: number) { await this.#helper.call('app.hide', { pid }); }
  async terminate(pid: number, force = false) { await this.#helper.call('app.terminate', { pid, force }); }

  // ── Tree / query ─────────────────────────────────────────────────────────

  tree(root: Root, opts: TreeOptions = {}) {
    return this.#helper.call<AXNode>('tree', { ...root, ...opts });
  }

  find(root: Root, path: Selector[], opts: TreeOptions & { timeoutMs?: number } = {}) {
    return this.#helper.call<AXNode>('find', { ...root, selector: path, ...opts });
  }

  findAll(root: Root, path: Selector[], opts: TreeOptions = {}) {
    return this.#helper.call<AXNode[]>('find', { ...root, selector: path, all: true, ...opts });
  }

  async exists(root: Root, path: Selector[]) {
    const r = await this.#helper.call<{ exists: boolean }>('exists', { ...root, selector: path });
    return r.exists;
  }

  // ── Element interaction ──────────────────────────────────────────────────

  async elementAction(ref: string, action = 'AXPress', opts: { nonBlocking?: boolean } = {}) {
    await this.#helper.call('element.action', { ref, action, ...opts });
  }
  async elementSetValue(ref: string, value: string | number | boolean) {
    await this.#helper.call('element.setValue', { ref, value });
  }
  async elementClick(ref: string, opts: { button?: MouseButton; count?: number; modifiers?: string[] } = {}) {
    await this.#helper.call('element.click', { ref, ...opts });
  }
  async elementHover(ref: string) { await this.#helper.call('element.hover', { ref }); }
  async elementFocus(ref: string) { await this.#helper.call('element.focus', { ref }); }
  elementRect(ref: string) { return this.#helper.call<Rect>('element.rect', { ref }); }
  elementAttributes(ref: string) {
    return this.#helper.call<{ attributes: Record<string, unknown>; actions: string[] }>('element.attributes', { ref });
  }

  // ── Tray ─────────────────────────────────────────────────────────────────

  trayList(pid?: number) { return this.#helper.call<TrayItem[]>('tray.list', pid ? { pid } : {}); }
  trayOpen(ref: string, opts: { button?: MouseButton; useMouse?: boolean; timeoutMs?: number; maxDepth?: number } = {}) {
    return this.#helper.call<TrayContent>('tray.open', { ref, ...opts });
  }
  async trayClose() { await this.#helper.call('tray.close'); }

  // ── Menus ────────────────────────────────────────────────────────────────

  menuTree(pid: number, opts: TreeOptions = {}) { return this.#helper.call<AXNode>('menu.tree', { pid, ...opts }); }
  async menuClick(pid: number, path: string[]) { await this.#helper.call('menu.click', { pid, path }); }

  // ── Windows ──────────────────────────────────────────────────────────────

  windowList(pid: number) { return this.#helper.call<WindowInfo[]>('window.list', { pid }); }
  async windowSetBounds(ref: string, bounds: Partial<Rect>) {
    await this.#helper.call('window.setBounds', { ref, ...bounds });
  }
  async windowSetMinimized(ref: string, minimized: boolean) {
    await this.#helper.call('window.setMinimized', { ref, minimized });
  }

  // ── Notifications ────────────────────────────────────────────────────────

  notificationList() { return this.#helper.call<Notification[]>('notification.list'); }
  async notificationAct(index: number, action: string) {
    await this.#helper.call('notification.act', { index, action });
  }

  // ── Dialogs ──────────────────────────────────────────────────────────────

  dialogList(pid?: number) { return this.#helper.call<Dialog[]>('dialog.list', pid ? { pid } : {}); }

  /**
   * Uses the Go-to-folder sheet (Cmd+Shift+G) rather than navigating the file
   * browser, because that is stable across macOS versions and view modes.
   */
  async dialogSetFilePath(_ref: string, path: string) {
    await this.#helper.call('key', { combo: 'cmd+shift+g' });
    await new Promise((r) => setTimeout(r, 400));
    await this.#helper.call('type', { text: path, delayMs: 8 });
    await this.#helper.call('key', { combo: 'enter' });
  }

  // ── Input ────────────────────────────────────────────────────────────────

  async key(combo: string) { await this.#helper.call('key', { combo }); }
  async type(text: string, delayMs = 8) { await this.#helper.call('type', { text, delayMs }); }
  async click(x: number, y: number, opts: { button?: MouseButton; count?: number; modifiers?: string[] } = {}) {
    await this.#helper.call('click', { x, y, ...opts });
  }
  async move(x: number, y: number) { await this.#helper.call('move', { x, y }); }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    await this.#helper.call('drag', { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
  }
  async scroll(x: number, y: number, dx: number, dy: number) {
    await this.#helper.call('scroll', { x, y, dx, dy });
  }
  mouseLocation() { return this.#helper.call<{ x: number; y: number }>('mouse.location'); }

  async openUrl(url: string, opts: { appPath?: string; background?: boolean } = {}) {
    const args: string[] = [];
    if (opts.background !== false) args.push('-g');
    if (opts.appPath) args.push('-a', opts.appPath);
    args.push(url);
    await run('/usr/bin/open', args);
  }

  async appPathForBundleId(bundleId: string): Promise<string | undefined> {
    const { stdout } = await run('/usr/bin/mdfind', [
      `kMDItemCFBundleIdentifier == '${bundleId}'`,
    ]).catch(() => ({ stdout: '' }));
    // Spotlight can return several copies of the same app; prefer /Applications
    // over a build directory or a stale worktree.
    const paths = stdout.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.app'));
    return paths.find((p) => p.startsWith('/Applications/')) ?? paths[0];
  }

  async defaultUrlHandler(scheme: string): Promise<string | undefined> {
    const plist = join(process.env.HOME ?? '', 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
    const parsed = JSON.parse(stdout) as { LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[] };
    return parsed.LSHandlers?.find((h) => h.LSHandlerURLScheme === scheme)?.LSHandlerRoleAll;
  }

  /**
   * Reads a browser's current URL through AppleScript.
   *
   * Needed because Chromium-based browsers refuse AXManualAccessibility, so
   * unlike Electron apps their omnibox and document URL stay invisible to the
   * accessibility layer. The scripting bridge is the supported route.
   *
   * Two hazards this guards against:
   *   - Sending Apple events needs the Automation permission, and the very first
   *     attempt blocks on a consent dialog *indefinitely*. A hard timeout means a
   *     missing grant fails a test in seconds instead of hanging the suite.
   *   - Safari and the Chrome family use different scripting vocabularies.
   */
  async browserUrlViaScript(bundleId: string, timeoutMs = 3000): Promise<string | undefined> {
    const isSafari = bundleId === 'com.apple.Safari';
    const script = isSafari
      ? `tell application id "${bundleId}" to return URL of front document`
      : `tell application id "${bundleId}" to return URL of active tab of front window`;
    try {
      const { stdout } = await run('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs, killSignal: 'SIGKILL' });
      const url = stdout.trim();
      return url && url !== 'missing value' ? url : undefined;
    } catch {
      return undefined;
    }
  }

  // ── Recording ────────────────────────────────────────────────────────────

  async recordStart(onEvent: (e: RecordedEvent) => void) {
    if (this.#unsubscribeRecord) throw new Error('a recording is already running on this driver');
    this.#unsubscribeRecord = this.#helper.onEvent((msg) => {
      if (msg.event === 'record' && msg.data) onEvent(msg.data as RecordedEvent);
    });
    try {
      await this.#helper.call('record.start');
    } catch (err) {
      this.#unsubscribeRecord();
      this.#unsubscribeRecord = null;
      throw err;
    }
  }

  async recordStop() {
    await this.#helper.call('record.stop').catch(() => {});
    this.#unsubscribeRecord?.();
    this.#unsubscribeRecord = null;
  }

  async recordPick(armed = true) {
    await this.#helper.call('record.pick', { armed });
  }

  elementAtPoint(x: number, y: number) {
    return this.#helper.call<ElementContext & { ref: string }>('element.atPoint', { x, y });
  }

  // ── Screen ───────────────────────────────────────────────────────────────

  screenInfo() { return this.#helper.call<{ frame: Rect; scale: number; main: boolean }[]>('screen.info'); }

  /**
   * Uses the system `screencapture` tool rather than ScreenCaptureKit: it is
   * synchronous, has no framework setup cost, and honours the same Screen
   * Recording permission, so behaviour matches what a user would see.
   */
  async screenshot(opts: ScreenshotOptions = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'dtf-shot-'));
    const path = opts.outPath ?? join(dir, `shot-${Date.now()}.png`);
    const args = ['-x', '-o']; // -x: no sound, -o: no window shadow
    if (opts.windowId !== undefined) args.push('-l', String(opts.windowId));
    else if (opts.rect) args.push('-R', `${opts.rect.x},${opts.rect.y},${opts.rect.width},${opts.rect.height}`);
    args.push(path);

    await run('/usr/sbin/screencapture', args);
    const buf = await readFile(path);
    if (!opts.outPath) await unlink(path).catch(() => {});
    return { base64: buf.toString('base64'), path: opts.outPath };
  }

  // ── App privacy permissions (TCC) ────────────────────────────────────────

  /**
   * Resets a privacy grant so the next launch shows the first-run prompt again.
   *
   * This is the only TCC mutation macOS allows without disabling SIP; granting
   * a permission from a script is intentionally impossible. To pre-grant in CI,
   * install a PPPC configuration profile on the runner instead.
   */
  async resetPermission(service: string, bundleId: string) {
    if (service !== 'All' && !(service in TCC_SERVICES)) {
      throw new Error(`unknown permission service '${service}'; known: ${Object.keys(TCC_SERVICES).join(', ')}`);
    }
    const args = service === 'All' ? ['reset', 'All', bundleId] : ['reset', service, bundleId];
    await run('/usr/bin/tccutil', args).catch((err) => {
      throw new Error(`tccutil ${args.join(' ')} failed: ${err.stderr ?? err.message}`);
    });
  }

  async readPermission(service: string, bundleId: string) {
    const svc = TCC_SERVICES[service];
    if (!svc) return 'unknown' as const;
    try {
      const { stdout } = await run('/usr/bin/sqlite3', [
        USER_TCC_DB,
        `SELECT auth_value FROM access WHERE service='${svc}' AND client='${bundleId}' LIMIT 1;`,
      ]);
      const v = stdout.trim();
      if (v === '') return 'unset' as const;
      // 0 = denied, 1 = unknown/limited, 2 = allowed.
      return v === '2' ? ('allowed' as const) : v === '0' ? ('denied' as const) : ('unknown' as const);
    } catch {
      // Reading TCC.db needs Full Disk Access; absence of it is not a test failure.
      return 'unknown' as const;
    }
  }
}

export function assertMacOS() {
  if (process.platform !== 'darwin') throw new UnsupportedError('MacOSDriver', process.platform);
}
