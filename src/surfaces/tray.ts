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

  constructor(driver: Driver, trayRef: string, content: TrayContent) {
    this.#driver = driver;
    this.#trayRef = trayRef;
    this.#content = content;
  }

  get kind() { return this.#content.kind; }
  get root(): AXNode { return this.#content.root; }

  /** Flat list of visible menu item titles, in order. */
  items(): string[] {
    const out: string[] = [];
    const walk = (n: AXNode) => {
      if (n.role === 'AXMenuItem') {
        const label = n.title ?? n.description ?? '';
        if (label) out.push(label);
      }
      n.children?.forEach(walk);
    };
    walk(this.#content.root);
    return out;
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

    for (let i = 0; i < path.length; i++) {
      const title = path[i];
      const isLeaf = i === path.length - 1;
      const item = await this.#findItem(scope, title, path.slice(0, i));

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
      const submenu = await waitFor(
        async () => {
          const t = await this.#driver.tree({ ref: item.ref }, { maxDepth: 1 });
          return t.children?.find((c) => c.role === 'AXMenu');
        },
        { timeoutMs: 3000, description: `submenu of '${title}'` },
      );
      scope = submenu.ref;
    }
  }

  async #findItem(scopeRef: string, title: string, parents: string[]): Promise<AXNode> {
    try {
      return await this.#driver.find({ ref: scopeRef }, [{ text: title, maxDepth: 3 }], { maxDepth: 0 });
    } catch {
      const available = (await this.#driver.tree({ ref: scopeRef }, { maxDepth: 3 })).children
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
    return new TrayPopup(this.#driver, item.ref, content);
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
