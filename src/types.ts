/** Shared shapes for the whole framework. Kept dependency-free on purpose. */

export type Platform = 'darwin' | 'win32' | 'linux';

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * One node of a platform accessibility tree, normalised across OSes.
 *
 * `ref` is an opaque handle owned by the native driver. It is only valid until
 * the underlying UI changes, so treat it as short-lived: query, act, re-query.
 */
export type AXNode = {
  ref: string;
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  help?: string;
  identifier?: string;
  placeholder?: string;
  value?: unknown;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  rect?: Rect;
  actions?: string[];
  childCount?: number;
  children?: AXNode[];
  truncated?: boolean;
};

/**
 * A predicate over one element. Fields are ANDed.
 *
 * `text` is the pragmatic escape hatch — it matches when any of
 * title/value/description/help/placeholder contains the substring, which covers
 * the very common case of a control labelling itself in an attribute you did not
 * expect.
 */
export type Selector = {
  role?: string;
  subrole?: string;
  title?: string;
  titleContains?: string;
  titleMatch?: string;
  description?: string;
  descriptionContains?: string;
  value?: string;
  valueContains?: string;
  identifier?: string;
  help?: string;
  helpContains?: string;
  text?: string;
  enabled?: boolean;
  focused?: boolean;
  nth?: number;
  maxDepth?: number;
};

/** A selector chain: each step searches inside the previous match. */
export type SelectorPath = Selector | Selector[] | string;

export type TrayItem = {
  ref: string;
  index: number;
  pid: number;
  app: string;
  bundleId: string;
  role: string;
  /** Best available human label: title, else description, else tooltip. */
  label: string;
  title?: string;
  description?: string;
  help?: string;
  identifier?: string;
  actions: string[];
  rect?: Rect;
};

export type TrayContent = {
  /** `menu` for a classic NSMenu/context menu, `window` for a popover panel. */
  kind: 'menu' | 'window';
  root: AXNode;
};

export type Notification = {
  ref: string;
  index: number;
  /** Source application as the OS reports it. */
  app: string;
  title: string;
  subtitle: string;
  body: string;
  texts: string[];
  raw: string;
  buttons: { ref: string; title: string }[];
  actions: string[];
};

export type Dialog = {
  kind: 'sheet' | 'dialog' | 'filePanel' | 'messageBox';
  ref: string;
  pid: number;
  app: string;
  bundleId: string;
  title: string;
  subrole: string;
  buttons: { ref: string; title: string; enabled: boolean }[];
  texts: string[];
  root: AXNode;
};

export type WindowInfo = {
  index: number;
  ref: string;
  title: string;
  subrole: string;
  minimized: boolean;
  main: boolean;
  focused: boolean;
  rect?: Rect;
  windowId?: number;
  sheetCount?: number;
};

export type AppInfo = {
  pid: number;
  name: string;
  bundleId: string;
  active: boolean;
  hidden: boolean;
  terminated?: boolean;
  windowCount?: number;
  hasMenuBarExtra?: boolean;
  /** 'accessory' apps have no Dock icon — most tray-only apps are one. */
  policy?: 'regular' | 'accessory';
};

export type MouseButton = 'left' | 'right' | 'middle';

export type LaunchOptions = {
  /** Path to a .app bundle (macOS), .exe (Windows), or a bare executable. */
  path: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Run against a throwaway user-data directory so tests start from a known
   * state. The framework creates it and passes it to the app via `userDataArg`.
   */
  isolatedUserData?: boolean;
  /** How to hand the isolated dir to the app. Electron: `--user-data-dir=`. */
  userDataArg?: string;
  /** Wait this long for the app to appear in the OS process list. */
  timeoutMs?: number;
  /**
   * Ask Chromium-based apps (Electron, Chrome) to publish their render tree to
   * the accessibility layer. On by default, and harmless for native apps.
   *
   * Without it an Electron window is an empty box from the outside and nothing
   * inside it can be located. It must be set before the window is created,
   * which is why the framework does it at launch rather than on demand.
   */
  chromiumAccessibility?: boolean;
};

/** One privacy/permission service the framework can inspect and reset. */
export type PermissionService =
  | 'Accessibility'
  | 'ScreenCapture'
  | 'Camera'
  | 'Microphone'
  | 'Location'
  | 'Calendar'
  | 'Reminders'
  | 'Contacts'
  | 'Photos'
  | 'AppleEvents'
  | 'SystemPolicyAllFiles'
  | 'SystemPolicyDesktopFolder'
  | 'SystemPolicyDocumentsFolder'
  | 'SystemPolicyDownloadsFolder'
  | 'ListenEvent'
  | 'PostEvent'
  | 'All';

// ── Recording ────────────────────────────────────────────────────────────────
//
// What a native driver reports while the recorder is running. This is the
// cross-platform contract: the macOS helper fills it from AXUIElement, a Windows
// helper fills the same shape from UI Automation. Everything downstream (step
// building, selector generation, codegen, the Studio UI) only sees these types.

/** An element's identifying fields, without its subtree. */
export type ElementSummary = {
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  help?: string;
  identifier?: string;
  placeholder?: string;
  value?: string;
  enabled?: boolean;
  rect?: Rect;
};

/**
 * Which OS surface an interaction landed on. Decided natively, because every
 * platform has different ways of telling a tray menu from a context menu.
 */
export type Surface =
  | 'window'
  | 'dialog'
  | 'tray'
  | 'trayMenu'
  | 'menuBar'
  | 'contextMenu'
  | 'notification'
  | 'unknown';

/** Everything the helper knows about the element an event targeted. */
export type ElementContext = {
  pid: number;
  app: string;
  bundleId: string;
  surface: Surface;
  element?: ElementSummary;
  /** Closest ancestor first; the application node itself is omitted. */
  ancestors?: ElementSummary[];
  /** The containing top-level window, when there is one. */
  window?: ElementSummary;
  /** Menu item titles from the top of the menu down to the clicked item. */
  menuPath?: string[];
  /** The status item that owns a tray / trayMenu interaction. */
  trayItem?: ElementSummary;
  dialog?: { kind: Dialog['kind']; title: string; texts: string[] };
  notification?: { raw: string; texts: string[] };
};

export type RecordedClick = ElementContext & {
  seq: number;
  /** `pick` = the click selected an element for an assertion and was swallowed. */
  type: 'click' | 'pick';
  button: MouseButton;
  count: number;
  modifiers: string[];
  x: number;
  y: number;
  at: number;
};

export type RecordedKey = {
  seq: number;
  type: 'key';
  /** Normalised key name: `a`, `enter`, `backspace`, `left`, … */
  key: string;
  /** The character the key produced, if any. */
  text: string;
  modifiers: string[];
  repeat: boolean;
  pid: number;
  app?: string;
  bundleId?: string;
  /** The element that had keyboard focus when the key went down. */
  focus?: ElementContext;
  at: number;
};

export type RecordedEvent = RecordedClick | RecordedKey;
