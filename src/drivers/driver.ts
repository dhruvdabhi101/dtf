import type {
  AXNode, AppInfo, Dialog, ElementContext, MouseButton, Notification, Rect,
  RecordedEvent, Selector, TrayContent, TrayItem, WindowInfo,
} from '../types.ts';

export type PreflightCheck = { name: string; ok: boolean | 'warn'; detail: string };

export type Root = { pid: number } | { ref: string };

export type TreeOptions = { maxDepth?: number; maxNodes?: number };

export type ScreenshotOptions = {
  /** Capture just this window. Falls back to full screen if not found. */
  windowId?: number;
  rect?: Rect;
  /** Where to write the PNG. Returned either way as a base64 string. */
  outPath?: string;
};

/**
 * The platform contract.
 *
 * Everything above this line in the framework is platform-agnostic; everything
 * OS-specific lives behind one of these. A new platform is one class plus one
 * native helper — no changes to surfaces, runner, or assertions.
 */
export interface Driver {
  readonly platform: string;

  /** Human name for reports and `dtf doctor`, e.g. "macOS" or "Windows". */
  readonly platformName: string;

  start(): Promise<void>;
  stop(): Promise<void>;
  gc(): Promise<void>;

  /**
   * Platform-specific environment checks for `dtf doctor` — Do Not Disturb on
   * macOS, Focus Assist on Windows, and so on. Must not throw.
   */
  preflight(): Promise<PreflightCheck[]>;

  // Permissions the *test runner itself* needs to drive the OS.
  checkAutomationPermission(prompt?: boolean): Promise<{ granted: boolean; detail: string }>;
  checkScreenRecordingPermission(): Promise<{ granted: boolean }>;

  // Applications
  listApps(): Promise<AppInfo[]>;
  findApps(q: { bundleId?: string; name?: string }): Promise<AppInfo[]>;
  appInfo(pid: number): Promise<AppInfo>;
  activate(pid: number): Promise<void>;
  /** Asks a Chromium-based app to build its accessibility tree. See the macOS impl. */
  setElectronAccessibility(pid: number): Promise<{ manualAccessibility: boolean; enhancedUserInterface: boolean }>;
  hide(pid: number): Promise<void>;
  terminate(pid: number, force?: boolean): Promise<void>;

  // Accessibility tree
  tree(root: Root, opts?: TreeOptions): Promise<AXNode>;
  find(root: Root, path: Selector[], opts?: TreeOptions & { timeoutMs?: number }): Promise<AXNode>;
  findAll(root: Root, path: Selector[], opts?: TreeOptions): Promise<AXNode[]>;
  exists(root: Root, path: Selector[]): Promise<boolean>;

  // Element interaction
  elementAction(ref: string, action?: string, opts?: { nonBlocking?: boolean }): Promise<void>;
  elementSetValue(ref: string, value: string | number | boolean): Promise<void>;
  elementClick(ref: string, opts?: { button?: MouseButton; count?: number; modifiers?: string[] }): Promise<void>;
  elementHover(ref: string): Promise<void>;
  elementFocus(ref: string): Promise<void>;
  elementRect(ref: string): Promise<Rect>;
  elementAttributes(ref: string): Promise<{ attributes: Record<string, unknown>; actions: string[] }>;

  // Tray / menu bar extras / notification area
  trayList(pid?: number): Promise<TrayItem[]>;
  trayOpen(ref: string, opts?: { button?: MouseButton; useMouse?: boolean; timeoutMs?: number; maxDepth?: number }): Promise<TrayContent>;
  trayClose(): Promise<void>;

  // Application menu bar
  menuTree(pid: number, opts?: TreeOptions): Promise<AXNode>;
  menuClick(pid: number, path: string[]): Promise<void>;

  // Windows
  windowList(pid: number): Promise<WindowInfo[]>;
  windowSetBounds(ref: string, bounds: Partial<Rect>): Promise<void>;
  windowSetMinimized(ref: string, minimized: boolean): Promise<void>;

  // OS notifications
  notificationList(): Promise<Notification[]>;
  notificationAct(index: number, action: string): Promise<void>;

  // Native dialogs, sheets, and file panels
  dialogList(pid?: number): Promise<Dialog[]>;
  /**
   * Types a path into a file open/save panel and confirms it. How that is
   * done is entirely platform-specific (a Go-to-Folder sheet on macOS, the
   * filename box on Windows), which is why it lives behind the driver.
   */
  dialogSetFilePath(ref: string, path: string): Promise<void>;

  // Raw input
  key(combo: string): Promise<void>;
  type(text: string, delayMs?: number): Promise<void>;
  click(x: number, y: number, opts?: { button?: MouseButton; count?: number; modifiers?: string[] }): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  mouseLocation(): Promise<{ x: number; y: number }>;

  /**
   * Opens a URL (http(s) or a custom scheme).
   *
   * `appPath` targets a specific bundle instead of letting LaunchServices pick
   * the handler — which matters more than it sounds: several builds of the same
   * app on one disk all claim the same scheme, and LaunchServices will happily
   * route your deep link to the wrong one.
   */
  openUrl(url: string, opts?: { appPath?: string; background?: boolean }): Promise<void>;

  /** Absolute path to an installed app bundle, by bundle id. */
  appPathForBundleId(bundleId: string): Promise<string | undefined>;

  /** The bundle id registered to handle a URL scheme, or undefined. */
  defaultUrlHandler(scheme: string): Promise<string | undefined>;

  /**
   * The URL of a browser's front tab, via the scripting bridge.
   * Returns undefined when the browser is not scriptable or Automation is not
   * permitted, rather than throwing — callers fall back to accessibility.
   */
  browserUrlViaScript(bundleId: string, timeoutMs?: number): Promise<string | undefined>;

  // Recording
  /**
   * Starts watching real user input and calls `onEvent` for every click and
   * key press, resolved to the element it targeted. Only one recording can be
   * active per driver.
   */
  recordStart(onEvent: (e: RecordedEvent) => void): Promise<void>;
  recordStop(): Promise<void>;
  /** Arms (or disarms) pick mode: the next left click is swallowed and reported as `type: 'pick'`. */
  recordPick(armed?: boolean): Promise<void>;
  /** The element under a screen point, with the same context a recorded click carries. */
  elementAtPoint(x: number, y: number): Promise<ElementContext & { ref: string }>;

  // Screen
  screenInfo(): Promise<{ frame: Rect; scale: number; main: boolean }[]>;
  screenshot(opts?: ScreenshotOptions): Promise<{ base64: string; path?: string }>;

  // App privacy permissions (the ones the *app under test* asks the user for)
  resetPermission(service: string, bundleId: string): Promise<void>;
  readPermission(service: string, bundleId: string): Promise<'allowed' | 'denied' | 'unset' | 'unknown'>;
  /**
   * Grants or denies a permission without a prompt. Optional because not
   * every OS allows it: Windows keeps consent in writable registry keys,
   * macOS keeps it in the SIP-protected TCC database.
   */
  setPermission?(service: string, bundleId: string, state: 'allowed' | 'denied'): Promise<void>;
}
