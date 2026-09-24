import type { Driver } from '../drivers/driver.ts';
import type { Rect, SelectorPath, WindowInfo } from '../types.ts';
import { Locator } from './locator.ts';
import { waitFor } from '../core/wait.ts';
import { AssertionError } from '../core/errors.ts';

export type WindowQuery = { title?: string | RegExp; index?: number };

/** One live application window. */
export class WindowHandle {
  #driver: Driver;
  #resolve: () => Promise<WindowInfo>;

  constructor(driver: Driver, resolve: () => Promise<WindowInfo>) {
    this.#driver = driver;
    this.#resolve = resolve;
  }

  info(): Promise<WindowInfo> { return this.#resolve(); }
  async title(): Promise<string> { return (await this.#resolve()).title; }
  async rect(): Promise<Rect | undefined> { return (await this.#resolve()).rect; }

  /** Locators are scoped to this window, so identical controls in other windows never match. */
  find(selector: SelectorPath): Locator {
    return new Locator(this.#driver, async () => ({ ref: (await this.#resolve()).ref }), selector);
  }

  async setBounds(bounds: Partial<Rect>): Promise<void> {
    await this.#driver.windowSetBounds((await this.#resolve()).ref, bounds);
  }

  async minimize(): Promise<void> { await this.#driver.windowSetMinimized((await this.#resolve()).ref, true); }
  async restore(): Promise<void> { await this.#driver.windowSetMinimized((await this.#resolve()).ref, false); }

  async close(): Promise<void> {
    const w = await this.#resolve();
    const btn = await this.#driver
      .find({ ref: w.ref }, [{ subrole: 'AXCloseButton', maxDepth: 3 }], { maxDepth: 0 })
      .catch(() => undefined);
    if (btn) {
      await this.#driver.elementAction(btn.ref, 'AXPress');
      return;
    }
    await this.#driver.key('cmd+w');
  }

  /** PNG of just this window, at native resolution. Requires Screen Recording permission. */
  async screenshot(outPath?: string): Promise<{ base64: string; path?: string }> {
    const w = await this.#resolve();
    return this.#driver.screenshot({ windowId: w.windowId, rect: w.windowId ? undefined : w.rect, outPath });
  }
}

export class WindowSurface {
  #driver: Driver;
  #pid: () => number;

  constructor(driver: Driver, pid: () => number) {
    this.#driver = driver;
    this.#pid = pid;
  }

  list(): Promise<WindowInfo[]> { return this.#driver.windowList(this.#pid()); }
  async count(): Promise<number> { return (await this.list()).length; }

  #pick(list: WindowInfo[], q: WindowQuery): WindowInfo | undefined {
    let pool = list;
    if (q.title) {
      pool = pool.filter((w) =>
        q.title instanceof RegExp ? q.title.test(w.title) : w.title.toLowerCase().includes(q.title!.toString().toLowerCase()),
      );
    }
    return q.index !== undefined ? pool[q.index] : pool.find((w) => w.main) ?? pool[0];
  }

  /**
   * A handle that re-resolves the window on every use.
   *
   * Window refs go stale whenever the app rebuilds its window list, so holding a
   * live query rather than a snapshot is what makes long tests survive.
   */
  get(query: WindowQuery = {}): WindowHandle {
    return new WindowHandle(this.#driver, async () => {
      const found = this.#pick(await this.list(), query);
      if (!found) {
        const all = await this.list();
        throw new AssertionError(
          `no window matching ${JSON.stringify(query)}; open windows: ${JSON.stringify(all.map((w) => w.title))}`,
        );
      }
      return found;
    });
  }

  /** Alias reading naturally in tests: `app.windows.main()`. */
  main(): WindowHandle { return this.get(); }

  async waitFor(query: WindowQuery = {}, opts: { timeoutMs?: number } = {}): Promise<WindowHandle> {
    await waitFor(async () => this.#pick(await this.list(), query), {
      timeoutMs: opts.timeoutMs ?? 10_000,
      description: `window ${JSON.stringify(query)}`,
    });
    return this.get(query);
  }

  async waitForCount(n: number, opts: { timeoutMs?: number } = {}): Promise<void> {
    await waitFor(async () => (await this.count()) === n, {
      timeoutMs: opts.timeoutMs ?? 10_000,
      description: `window count to be ${n}`,
    }).catch(async () => {
      throw new AssertionError(`expected ${n} window(s), found ${await this.count()}`);
    });
  }

  async shouldExist(query: WindowQuery = {}, opts: { timeoutMs?: number } = {}): Promise<WindowHandle> {
    try {
      return await this.waitFor(query, opts);
    } catch {
      const all = await this.list();
      throw new AssertionError(
        `expected a window matching ${JSON.stringify(query)}; open: ${JSON.stringify(all.map((w) => w.title))}`,
      );
    }
  }

  /**
   * Asserts the app has no visible windows — the state a tray-only app should be
   * in after "close to tray". A regression here is exactly the kind of thing an
   * in-process test suite cannot see.
   */
  async shouldHaveNone(opts: { timeoutMs?: number } = {}): Promise<void> {
    await waitFor(async () => (await this.count()) === 0, {
      timeoutMs: opts.timeoutMs ?? 5000,
      description: 'all windows to close',
    }).catch(async () => {
      const all = await this.list();
      throw new AssertionError(`expected no open windows, found: ${JSON.stringify(all.map((w) => w.title))}`);
    });
  }
}
