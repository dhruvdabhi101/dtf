import type { Driver } from '../drivers/driver.ts';
import type { AXNode, MouseButton, TrayContent, TrayItem } from '../types.ts';
import { Locator } from './locator.ts';
import { waitFor } from '../core/wait.ts';
import { AssertionError } from '../core/errors.ts';

export type TrayQuery = {
  /** Matched case-insensitively against title, then description, then tooltip. */
  label?: string;
  index?: number;
};

/** Depth-first search; `topLevel` does not descend into menu items (their submenus). */
function findNode(n: AXNode, pred: (n: AXNode) => boolean, topLevel = false): AXNode | undefined {
  if (pred(n)) return n;
  if (topLevel && n.role === 'AXMenuItem') return undefined;
  for (const c of n.children ?? []) {
    const hit = findNode(c, pred, topLevel);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The opened contents of a tray icon.
 *
 * Deliberately unified across the two shapes a tray can take: a classic menu,
 * and a popover window (which is what most Electron and SwiftUI menu-bar apps
 * actually show). Tests written against this do not need to know which they got.
 */
export class TrayPopup {
  #driver: Driver;
  #content: TrayContent;
  #trayRef: string;
  #pid: number | undefined;

  constructor(driver: Driver, trayRef: string, content: TrayContent, pid?: number) {
    this.#driver = driver;
    this.#pid = pid;
    this.#trayRef = trayRef;
    this.#content = content;
  }

  get kind() { return this.#content.kind; }
  get root(): AXNode { return this.#content.root; }

  /**
   * Menu item titles, in order: the top level of the menu only.
   *
   * Electron publishes every submenu's items in the accessibility tree even
   * while the submenu is closed, so a naive walk mixes "Pause for 1 hour" into
   * the top-level menu. Pass `nested: true` for that flattened list anyway.
   * To read one submenu, use `submenu(title)`.
   */
  items(opts: { nested?: boolean } = {}): string[] {
    const out: string[] = [];
    const walk = (n: AXNode) => {
      if (n.role === 'AXMenuItem') {
        const label = n.title ?? n.description ?? '';
        if (label) out.push(label);
        if (!opts.nested) return;
      }
      n.children?.forEach(walk);
    };
    walk(this.#content.root);
    return out;
  }

  /**
   * Titles of the items inside the submenu `title`, as far as the tree shows
   * them without opening it. Empty when the platform only builds a submenu
   * once it is open (plain AppKit); open it with `click()` in that case.
   */
  submenu(title: string | RegExp): string[] {
    const matches = (n: AXNode) => {
      const label = n.title ?? n.description ?? '';
      return typeof title === 'string' ? label === title : title.test(label);
    };
    let found: AXNode | undefined;
    const walk = (n: AXNode) => {
      if (found) return;
      if (n.role === 'AXMenuItem' && matches(n)) { found = n; return; }
      if (n.role === 'AXMenuItem') return; // only top-level parents
      n.children?.forEach(walk);
    };
    walk(this.#content.root);
    const menu = found?.children?.find((c) => c.role === 'AXMenu');
    return (menu?.children ?? [])
      .filter((c) => c.role === 'AXMenuItem')
      .map((c) => c.title ?? c.description ?? '')
      .filter(Boolean);
  }

  /** Every readable string in the popup — the right check for popover-style trays. */
  texts(): string[] {
    const out: string[] = [];
    const walk = (n: AXNode) => {
      for (const v of [n.title, n.description, typeof n.value === 'string' ? n.value : undefined]) {
        if (v && !out.includes(v)) out.push(v);
      }
      n.children?.forEach(walk);
    };
    walk(this.#content.root);
    return out;
  }

  /** Scoped locator for anything inside the popup. */
  find(selector: Parameters<Locator['find']>[0]): Locator {
    return new Locator(this.#driver, async () => ({ ref: this.#content.root.ref }), selector);
  }

  /**
   * Clicks a (possibly nested) menu path, e.g. `click('Preferences', 'Advanced')`.
   *
   * Submenus are opened by pressing their parent and waiting for the child menu
   * to materialise; AppKit only populates a submenu's accessibility children
   * once it has actually been opened.
   */
  async click(...path: string[]): Promise<void> {
    if (path.length === 0) throw new Error('tray click needs at least one item title');
    let scope = this.#content.root.ref;
    let found: AXNode | undefined; // the next item, when a submenu window already gave it

    for (let i = 0; i < path.length; i++) {
      const title = path[i];
      const isLeaf = i === path.length - 1;
      const item = found ?? await this.#findItem(scope, title, path.slice(0, i));
      found = undefined;

      if (isLeaf) {
        if (item.enabled === false) {
          throw new AssertionError(`tray menu item '${title}' is disabled`);
        }
        await this.#driver.elementAction(item.ref, 'AXPress');
        return;
      }

      // Opening a submenu starts a modal tracking loop, so this press must not
      // be awaited to completion — see the driver's nonBlocking note.
      await this.#driver.elementAction(item.ref, 'AXPress', { nonBlocking: true });
      const next = path[i + 1];
      const opened = await waitFor(
        async () => {
          // macOS: the submenu is a child of the item it belongs to.
          const t = await this.#driver.tree({ ref: item.ref }, { maxDepth: 1 }).catch(() => undefined);
          const child = t?.children?.find((c) => c.role === 'AXMenu');
          if (child) return { scope: child.ref };
          // Windows (Electron, WinForms): the submenu is a popup window of its
          // own, beside the menu. Find the next item there.
          const hit = await this.#inSubmenuWindow(next);
          return hit ? { item: hit } : undefined;
        },
        { timeoutMs: 3000, description: `submenu of '${title}'` },
      );
      if (opened.item) found = opened.item;
      else scope = opened.scope!;
    }
  }

  /**
   * Opens the submenu `title` and returns its item titles, in order. Works
   * whether the submenu is the item's child (macOS) or a popup window of its
   * own (Electron and WinForms on Windows). Leaves it open; `close()` it.
   */
  async openSubmenu(title: string | RegExp): Promise<string[]> {
    const label = (n: AXNode) => n.title ?? n.description ?? '';
    const parent = findNode(this.#content.root, (n) => n.role === 'AXMenuItem' && (typeof title === 'string' ? label(n) === title : title.test(label(n))), true);
    if (!parent) throw new AssertionError(`no tray menu item ${title}. Items: ${JSON.stringify(this.items())}`);
    await this.#driver.elementAction(parent.ref, 'AXPress', { nonBlocking: true });
    return waitFor(async () => {
      const t = await this.#driver.tree({ ref: parent.ref }, { maxDepth: 2 }).catch(() => undefined);
      const child = t?.children?.find((c) => c.role === 'AXMenu');
      const own = (child?.children ?? []).filter((c) => c.role === 'AXMenuItem').map(label).filter(Boolean);
      if (own.length) return own;
      const inWindow = (await this.#submenuWindowItems()).map(label).filter(Boolean);
      return inWindow.length ? inWindow : undefined;
    }, { timeoutMs: 3000, description: `submenu of '${label(parent)}'` });
  }

  /** The menu items of the app's popup windows other than this menu, top to bottom. */
  async #submenuWindowItems(): Promise<AXNode[]> {
    if (!this.#pid) return [];
    const items = await this.#driver
      .findAll({ pid: this.#pid }, [{ role: 'AXMenuItem', maxDepth: 14 }])
      .catch(() => [] as AXNode[]);
    const menu = findNode(this.#content.root, (n) => n.role === 'AXMenu')?.rect ?? this.#content.root.rect;
    const inside = (r: { x: number; y: number; width: number; height: number }) =>
      !!menu && r.x >= menu.x - 1 && r.y >= menu.y - 1 && r.x + r.width <= menu.x + menu.width + 1 && r.y + r.height <= menu.y + menu.height + 1;
    const seen = new Set<string>();
    return items
      .filter((n) => n.rect && n.rect.width > 0 && !inside(n.rect))
      .filter((n) => { const k = `${n.rect!.x},${n.rect!.y}`; return !seen.has(k) && !!seen.add(k); })
      .sort((a, b) => a.rect!.y - b.rect!.y);
  }

  /**
   * A menu item titled `title` in one of the app's popup windows other than
   * this menu: a submenu that opened as a window of its own. Told apart from
   * this menu's items (Electron also publishes a closed submenu's items under
   * its parent) by lying outside this menu's rect.
   */
  async #inSubmenuWindow(title: string): Promise<AXNode | undefined> {
    return (await this.#submenuWindowItems()).find((n) => (n.title ?? n.description) === title);
  }

  async #findItem(scopeRef: string, title: string, parents: string[]): Promise<AXNode> {
    // The top level is already in hand from opening. Popover-style menus (an
    // Electron menu on Windows is a window) nest their items well below the
    // root, deeper than a live search would look.
    if (scopeRef === this.#content.root.ref) {
      // Top level only: Electron also publishes closed submenus' items, and a
      // "Quit" inside one must not shadow the top-level "Quit".
      const hit = findNode(this.#content.root, (n) => n.role === 'AXMenuItem' && (n.title ?? n.description) === title, true);
      if (hit) return hit;
    }
    try {
      return await this.#driver.find({ ref: scopeRef }, [{ text: title, maxDepth: 10 }], { maxDepth: 0 });
    } catch {
      const available = scopeRef === this.#content.root.ref
        ? this.items()
        : (await this.#driver.tree({ ref: scopeRef }, { maxDepth: 3 })).children
          ?.map((c) => c.title ?? c.description ?? '')
          .filter(Boolean) ?? [];
      const where = parents.length ? ` under ${parents.join(' > ')}` : '';
      throw new AssertionError(
        `no tray menu item '${title}'${where}. Visible items: ${JSON.stringify(available)}`,
      );
    }
  }

  /** Dismisses the popup without activating anything. */
  async close(): Promise<void> {
    await this.#driver.trayClose();
  }

  async shouldHaveItem(title: string): Promise<void> {
    const items = this.items();
    const texts = this.texts();
    if (!items.includes(title) && !texts.some((t) => t.includes(title))) {
      throw new AssertionError(
        `expected tray popup to contain '${title}'. Items: ${JSON.stringify(items)}`,
        title, items,
      );
    }
  }
}

/**
 * The tray / menu-bar-extra / notification-area surface for one application.
 *
 * On macOS a status item lives inside its owning app's own accessibility tree
 * (`AXExtrasMenuBar`), which is why this is scoped to a pid rather than being a
 * global system query.
 */
export class TraySurface {
  #driver: Driver;
  #pid: () => number;

  constructor(driver: Driver, pid: () => number) {
    this.#driver = driver;
    this.#pid = pid;
  }

  /** Every tray icon owned by the app under test. */
  list(): Promise<TrayItem[]> {
    return this.#driver.trayList(this.#pid());
  }

  /** Every tray icon on the system, whichever app owns it. */
  listAll(): Promise<TrayItem[]> {
    return this.#driver.trayList();
  }

  /**
   * Waits for the app's tray icon to appear.
   *
   * Worth using as a first assertion: a tray icon that never registers is one of
   * the most common desktop regressions and is invisible to in-process tests.
   */
  async waitForItem(query: TrayQuery = {}, opts: { timeoutMs?: number } = {}): Promise<TrayItem> {
    return waitFor(async () => {
      const items = await this.list();
      return this.#match(items, query);
    }, { timeoutMs: opts.timeoutMs ?? 10_000, description: `tray item ${JSON.stringify(query)}` });
  }

  #match(items: TrayItem[], query: TrayQuery): TrayItem | undefined {
    let pool = items;
    if (query.label) {
      const needle = query.label.toLowerCase();
      pool = pool.filter((i) => (i.label ?? '').toLowerCase().includes(needle));
    }
    return query.index !== undefined ? pool[query.index] : pool[0];
  }

  /** Opens the tray icon and returns its contents. */
  async open(query: TrayQuery = {}, opts: { button?: MouseButton; useMouse?: boolean; timeoutMs?: number } = {}): Promise<TrayPopup> {
    const item = await this.waitForItem(query);
    const content = await this.#driver.trayOpen(item.ref, opts);
    return new TrayPopup(this.#driver, item.ref, content, item.pid || this.#pid());
  }

  /** Open, click a menu path, done. The common case in one call. */
  async click(...path: string[]): Promise<void> {
    const popup = await this.open();
    await popup.click(...path);
  }

  async close(): Promise<void> {
    await this.#driver.trayClose();
  }

  async shouldExist(query: TrayQuery = {}, opts: { timeoutMs?: number } = {}): Promise<TrayItem> {
    try {
      return await this.waitForItem(query, opts);
    } catch {
      const all = await this.list();
      throw new AssertionError(
        `expected a tray item matching ${JSON.stringify(query)}. ` +
          `The app currently has ${all.length} tray item(s): ${JSON.stringify(all.map((i) => i.label))}`,
      );
    }
  }
}
