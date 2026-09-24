import type { Driver } from '../drivers/driver.ts';
import type { AXNode } from '../types.ts';
import { AssertionError } from '../core/errors.ts';

/**
 * The application menu bar (File / Edit / View / ...).
 *
 * Items are located and pressed structurally through the accessibility tree
 * rather than by hovering the real menu open. That avoids the flakiness of menu
 * tracking loops and, usefully, works even when the app is not frontmost.
 */
export class MenuSurface {
  #driver: Driver;
  #pid: () => number;

  constructor(driver: Driver, pid: () => number) {
    this.#driver = driver;
    this.#pid = pid;
  }

  /** The full menu bar tree. Handy while writing a test. */
  tree(maxDepth = 4): Promise<AXNode> {
    return this.#driver.menuTree(this.#pid(), { maxDepth });
  }

  /** Top-level menu titles. */
  async topLevel(): Promise<string[]> {
    const t = await this.tree(1);
    return (t.children ?? []).map((c) => c.title ?? '').filter(Boolean);
  }

  /** Item titles directly under a menu path. */
  async items(...path: string[]): Promise<string[]> {
    let node = await this.tree(path.length + 2);
    for (const title of path) {
      const container = node.role === 'AXMenuBar' ? node : node.children?.find((c) => c.role === 'AXMenu') ?? node;
      const next = container.children?.find((c) => c.title === title);
      if (!next) {
        throw new AssertionError(
          `no menu '${title}'; available: ${JSON.stringify(container.children?.map((c) => c.title).filter(Boolean))}`,
        );
      }
      node = next;
    }
    const menu = node.children?.find((c) => c.role === 'AXMenu') ?? node;
    return (menu.children ?? []).map((c) => c.title ?? '').filter(Boolean);
  }

  /** Clicks a menu path, e.g. `click('File', 'New Window')`. */
  async click(...path: string[]): Promise<void> {
    await this.#driver.menuClick(this.#pid(), path);
  }

  async has(...path: string[]): Promise<boolean> {
    const leaf = path[path.length - 1];
    try {
      return (await this.items(...path.slice(0, -1))).includes(leaf);
    } catch {
      return false;
    }
  }

  async shouldHave(...path: string[]): Promise<void> {
    if (!(await this.has(...path))) {
      const parent = path.slice(0, -1);
      const available = await this.items(...parent).catch(() => []);
      throw new AssertionError(
        `expected menu item ${path.join(' > ')}; ${parent.join(' > ') || 'menu bar'} contains ${JSON.stringify(available)}`,
      );
    }
  }
}
