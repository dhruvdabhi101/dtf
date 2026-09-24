import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const HELPER_PATH = join(HERE, '..', '..', 'native', 'windows', 'bin', 'dtfd-windows.exe');
const BUILD_SCRIPT = join(HERE, '..', '..', 'native', 'windows', 'build.ps1');

/**
 * CapabilityAccessManager capability names, keyed by the friendly names the
 * framework exposes. Services with no Windows counterpart are absent and read
 * as `unknown`.
 */
const CAPABILITIES: Record<string, string> = {
  Camera: 'webcam',
  Microphone: 'microphone',
  Location: 'location',
  Calendar: 'appointments',
  Contacts: 'contacts',
  Photos: 'picturesLibrary',
  SystemPolicyDocumentsFolder: 'documentsLibrary',
  ScreenCapture: 'graphicsCaptureProgrammatic',
  // Reading other apps' input is a UIPI matter, not a consent-store one; the
  // closest capability is the one that gates the input-injection broker.
  ListenEvent: 'humanInterfaceDevice',
  PostEvent: 'humanInterfaceDevice',
};

/** Runs a PowerShell script file without the execution-policy dance. */
function powershell(script: string, args: string[] = []) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true });
}

/** Reads one registry value via `reg query`, or undefined. */
async function regQuery(key: string, value?: string): Promise<string | undefined> {
  const args = ['query', key];
  if (value !== undefined) args.push(value === '' ? '/ve' : '/v', ...(value === '' ? [] : [value]));
  const { stdout } = await run('reg.exe', args, { windowsHide: true }).catch(() => ({ stdout: '' }));
  // Lines look like:  "    (Default)    REG_SZ    C:\path\app.exe"
  const line = stdout.split(/\r?\n/).find((l) => /REG_(SZ|EXPAND_SZ|DWORD)/.test(l));
  if (!line) return undefined;
  const m = line.match(/REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.*)$/);
  return m?.[1]?.trim();
}

/** The executable path inside a shell `open` command like `"C:\x\app.exe" "%1"`. */
function exeFromCommand(cmd: string | undefined): string | undefined {
  if (!cmd) return undefined;
  const quoted = cmd.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  const m = cmd.match(/^(.*?\.exe)/i);
  return m?.[1];
}

export class WindowsDriver implements Driver {
  readonly platform = 'win32';
  readonly platformName = 'Windows';
  #helper: NativeHelper;
  #unsubscribeRecord: (() => void) | null = null;

  constructor(opts: { onStderr?: (l: string) => void } = {}) {
    this.#helper = new NativeHelper(HELPER_PATH, { onStderr: opts.onStderr });
  }

  async start(): Promise<void> {
    if (!existsSync(HELPER_PATH)) {
      // First run, or a fresh checkout: build the helper on demand.
      await powershell(BUILD_SCRIPT).catch((err) => {
        throw new Error(
          `native helper is missing and could not be built.\n` +
            `Run: powershell -ExecutionPolicy Bypass -File ${BUILD_SCRIPT}\n` +
            `The .NET 8 SDK is required (winget install Microsoft.DotNet.SDK.8).\n${err.stderr ?? err.stdout ?? err}`,
        );
      });
    }
    await this.#helper.start();
  }

  stop() { return this.#helper.stop(); }
  gc() { return this.#helper.gc(); }

  async preflight(): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];

    // Focus Assist / Do Not Disturb suppresses toasts silently, which makes
    // every notification assertion fail for a reason invisible in the output.
    const fa = await this.#helper.call<{ state: string; detail?: string }>('perm.focusAssist')
      .catch((): { state: string; detail?: string } => ({ state: 'unknown' }));
    checks.push({
      name: 'Focus Assist',
      ok: fa.state === 'off' ? true : 'warn',
      detail: fa.state === 'off'
        ? 'off — toast notifications will be delivered'
        : fa.state === 'unknown'
          ? `could not be read${fa.detail ? ` (${fa.detail})` : ''} — if notification tests fail, check Settings > System > Notifications`
          : `ON (${fa.state === 'priorityOnly' ? 'Do not disturb / priority only' : 'alarms only'}) — toasts will be suppressed and notification tests will fail`,
    });

    const s = await this.#helper.call<{ locked: boolean | null; connectState: string; interactive: boolean; elevated: boolean }>('session.info')
      .catch(() => ({ locked: null, connectState: 'unknown', interactive: true, elevated: false }));
    const detached = s.locked === true || s.connectState === 'disconnected' || !s.interactive;
    checks.push({
      name: 'desktop session',
      ok: !detached,
      detail: detached
        ? `the session is ${s.locked ? 'locked' : s.connectState} — synthetic input goes nowhere; log in interactively (an RDP session must stay connected)`
        : `interactive and unlocked (${s.connectState})`,
    });

    // UIPI: a lower-integrity process cannot send input to a higher one. If
    // the tests run elevated and the app does not (or vice versa), every click
    // is silently dropped.
    checks.push({
      name: 'integrity level',
      ok: s.elevated ? 'warn' : true,
      detail: s.elevated
        ? 'dtf is running elevated — apps it launches inherit that, but input to a non-elevated app already running will be dropped (UIPI)'
        : 'not elevated — input reaches any non-elevated app; an elevated app under test would ignore it',
    });
    return checks;
  }

  // ── Runner permissions ───────────────────────────────────────────────────

  async checkAutomationPermission(_prompt = false) {
    // Windows has no Accessibility consent; the helper reports `trusted` for
    // protocol symmetry and integrity is checked in preflight instead.
    const r = await this.#helper.call<{ trusted: boolean }>('perm.accessibility');
    return { granted: r.trusted, detail: 'no permission needed on Windows (UI Automation is available to any interactive process)' };
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
  async dialogSetFilePath(ref: string, path: string) {
    await this.#helper.call('dialog.setFilePath', { ref, path });
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

  /**
   * Opens a URL. With `appPath`, the executable is started directly with the
   * URL as its argument — which is how Windows itself delivers a protocol
   * activation, and what lets a deep link target one specific build when
   * several claim the scheme. Without it, the shell's registered handler runs.
   */
  async openUrl(url: string, opts: { appPath?: string; background?: boolean } = {}) {
    if (opts.appPath) {
      if (/\.lnk$/i.test(opts.appPath) || /^shell:AppsFolder\\/i.test(opts.appPath)) {
        // A shortcut or an AUMID cannot take arguments through ShellExecute
        // with a URL; hand both to the shell and let it resolve.
        await run('cmd.exe', ['/d', '/c', 'start', '', opts.appPath, url], { windowsHide: true });
        return;
      }
      const { spawn } = await import('node:child_process');
      const child = spawn(opts.appPath, [url], { detached: true, stdio: 'ignore', windowsHide: opts.background !== false });
      child.unref();
      return;
    }
    // `start` needs the empty title argument or it treats a quoted URL as one.
    await run('cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true });
  }

  /**
   * An installed app for a "bundle id". Accepts what `appInfo` reports: an
   * executable path (returned as-is when it exists), an AUMID (resolved to a
   * `shell:AppsFolder` moniker the shell can start), or a bare exe name looked
   * up in App Paths.
   */
  async appPathForBundleId(bundleId: string): Promise<string | undefined> {
    if (/^[a-z]:\\/i.test(bundleId) && existsSync(bundleId)) return bundleId;
    if (bundleId.includes('!') || /^[\w.-]+_[a-z0-9]{13}$/i.test(bundleId)) return `shell:AppsFolder\\${bundleId}`;
    const exeName = bundleId.endsWith('.exe') ? bundleId : `${bundleId}.exe`;
    for (const hive of ['HKCU', 'HKLM']) {
      const path = await regQuery(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, '');
      if (path && existsSync(path.replace(/^"|"$/g, ''))) return path.replace(/^"|"$/g, '');
    }
    return undefined;
  }

  /**
   * The executable registered to open a URL scheme. For http/https that is
   * the user's default browser (UserChoice → ProgId → open command); for a
   * custom scheme it is the scheme's own open command.
   */
  async defaultUrlHandler(scheme: string): Promise<string | undefined> {
    const progId = await regQuery(`HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`, 'ProgId');
    const keys = [
      ...(progId ? [`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, `HKCR\\${progId}\\shell\\open\\command`] : []),
      `HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`,
      `HKCR\\${scheme}\\shell\\open\\command`,
    ];
    for (const key of keys) {
      const exe = exeFromCommand(await regQuery(key, ''));
      if (exe) return exe;
    }
    return undefined;
  }

  /**
   * No scripting bridge on Windows. Chromium browsers expose the page URL as
   * the document element's value, which the browser surface reads through the
   * accessibility path, so returning undefined here is the right fallback.
   */
  async browserUrlViaScript(_bundleId: string, _timeoutMs?: number): Promise<string | undefined> {
    return undefined;
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

  /** PrintWindow for one window (works when occluded), a desktop copy otherwise. Needs no permission. */
  async screenshot(opts: ScreenshotOptions = {}) {
    const r = await this.#helper.call<{ base64: string; path?: string | null }>('screenshot', {
      windowId: opts.windowId,
      ...(opts.rect ? { rectX: opts.rect.x, rectY: opts.rect.y, rectWidth: opts.rect.width, rectHeight: opts.rect.height } : {}),
      outPath: opts.outPath,
    });
    return { base64: r.base64, path: r.path ?? undefined };
  }

  // ── App privacy permissions (CapabilityAccessManager) ────────────────────

  #capability(service: string): string {
    if (service === 'All') return 'All';
    const cap = CAPABILITIES[service];
    if (!cap) {
      throw new UnsupportedError(`the '${service}' permission`, `Windows (known: ${Object.keys(CAPABILITIES).join(', ')})`);
    }
    return cap;
  }

  /**
   * Forgets the app's consent decision so the next request prompts again.
   *
   * The consent store is plain HKCU registry, so unlike macOS this can also
   * *grant* — see `setPermission`. The app is identified by its executable
   * path (what `bundleId` is for a classic desktop app) or its package family
   * name for a packaged app.
   */
  async resetPermission(service: string, bundleId: string) {
    const caps = service === 'All' ? Object.values(new Set(Object.values(CAPABILITIES))) : [this.#capability(service)];
    for (const cap of caps) await this.#helper.call('perm.consent.write', { capability: cap, app: bundleId, value: null });
  }

  async readPermission(service: string, bundleId: string) {
    const cap = CAPABILITIES[service];
    if (!cap) return 'unknown' as const;
    const r = await this.#helper.call<{ value?: string | null; exists: boolean }>('perm.consent.read', { capability: cap, app: bundleId }).catch(() => undefined);
    if (!r) return 'unknown' as const;
    if (!r.exists || !r.value) return 'unset' as const;
    return r.value === 'Allow' ? ('allowed' as const) : r.value === 'Deny' ? ('denied' as const) : ('unset' as const);
  }

  /** Grants or denies without a prompt. Windows-only capability; macOS cannot do this by design. */
  async setPermission(service: string, bundleId: string, state: 'allowed' | 'denied') {
    await this.#helper.call('perm.consent.write', {
      capability: this.#capability(service), app: bundleId, value: state === 'allowed' ? 'Allow' : 'Deny',
    });
  }
}
