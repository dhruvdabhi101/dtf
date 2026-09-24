import type { Driver } from '../drivers/driver.ts';
import type { Dialog, SelectorPath } from '../types.ts';
import { Locator } from './locator.ts';
import { waitFor } from '../core/wait.ts';
import { AssertionError } from '../core/errors.ts';

export type DialogQuery = {
  title?: string | RegExp;
  /** Matches any static text inside the dialog — alert bodies live here. */
  text?: string | RegExp;
  kind?: Dialog['kind'];
  /** Include dialogs owned by other processes (file panels, system prompts). */
  anyApp?: boolean;
};

/** Button titles that back out of a dialog without accepting it. */
const CANCEL_TITLES = ['Cancel', "Don't Save", 'Close', 'No', 'Dismiss'];

function matches(value: string, pattern: string | RegExp): boolean {
  return pattern instanceof RegExp ? pattern.test(value) : value.toLowerCase().includes(pattern.toLowerCase());
}

/** A live native modal: an alert, a sheet, or a file open/save panel. */
export class DialogHandle {
  #driver: Driver;
  #dialog: Dialog;

  constructor(driver: Driver, dialog: Dialog) {
    this.#driver = driver;
    this.#dialog = dialog;
  }

  get kind() { return this.#dialog.kind; }
  get title() { return this.#dialog.title; }
  get texts() { return this.#dialog.texts; }
  get buttons() { return this.#dialog.buttons.map((b) => b.title); }
  get owningApp() { return this.#dialog.app; }
  get root() { return this.#dialog.root; }
  /** False for a prompt the OS isolates from automation (a UAC prompt). */
  get automatable() { return this.#dialog.automatable !== false; }

  find(selector: SelectorPath): Locator {
    return new Locator(this.#driver, async () => ({ ref: this.#dialog.ref }), selector);
  }

  /** Presses a button by its visible title. */
  async click(buttonTitle: string): Promise<void> {
    const btn = this.#dialog.buttons.find((b) => b.title === buttonTitle)
      ?? this.#dialog.buttons.find((b) => b.title.toLowerCase() === buttonTitle.toLowerCase());
    if (!btn) {
      throw new AssertionError(
        `dialog '${this.#dialog.title || this.#dialog.kind}' has no button '${buttonTitle}'. ` +
          `Available: ${JSON.stringify(this.buttons)}`,
      );
    }
    if (!btn.enabled) throw new AssertionError(`dialog button '${buttonTitle}' is disabled`);
    await this.#driver.elementAction(btn.ref, 'AXPress');
  }

  /**
   * Dismisses the modal without accepting it.
   *
   * Prefers the dialog's own cancel control and only falls back to Escape.
   * Escape is a keystroke sent to whatever currently has keyboard focus, so it
   * silently does nothing when the app under test is not frontmost — a very
   * easy way to write a test that passes locally and hangs in CI.
   */
  async dismiss(): Promise<void> {
    const cancel = this.#dialog.buttons.find((b) => CANCEL_TITLES.includes(b.title) && b.enabled);
    if (cancel) {
      await this.#driver.elementAction(cancel.ref, 'AXPress');
      return;
    }
    await this.#driver.key('escape');
  }

  /**
   * Types a path into a file panel and confirms it.
   *
   * The mechanics differ per OS (macOS uses the Go-to-folder sheet, Windows
   * the filename box), so the driver does the typing.
   */
  async setFilePath(path: string): Promise<void> {
    if (this.kind !== 'filePanel' && !/save|open/i.test(this.title)) {
      throw new AssertionError(`setFilePath is only meaningful on a file panel; this is a ${this.kind}`);
    }
    await this.#driver.dialogSetFilePath(this.#dialog.ref, path);
  }

  async shouldHaveText(expected: string | RegExp): Promise<void> {
    const joined = this.#dialog.texts.join(' | ');
    if (!matches(joined, expected)) {
      throw new AssertionError(
        `expected dialog to contain ${expected}, got: ${JSON.stringify(this.#dialog.texts)}`,
        expected, this.#dialog.texts,
      );
    }
  }

  async shouldHaveButtons(...titles: string[]): Promise<void> {
    const missing = titles.filter((t) => !this.buttons.includes(t));
    if (missing.length) {
      throw new AssertionError(
        `dialog is missing button(s) ${JSON.stringify(missing)}; it has ${JSON.stringify(this.buttons)}`,
      );
    }
  }
}

/**
 * Native modals.
 *
 * Covers the three places a modal can actually live, so a test never has to
 * care which the app happened to produce:
 *   - a sheet attached to one of the app's own windows,
 *   - a standalone dialog window,
 *   - a window belonging to a *different* process — a sandboxed app's save
 *     panel is served by the system's open/save panel XPC service, which is why
 *     naive "look at the app's windows" approaches miss it entirely.
 */
export class DialogSurface {
  #driver: Driver;
  #pid: () => number;

  constructor(driver: Driver, pid: () => number) {
    this.#driver = driver;
    this.#pid = pid;
  }

  async list(anyApp = false): Promise<Dialog[]> {
    return this.#driver.dialogList(anyApp ? undefined : this.#pid());
  }

  async waitFor(query: DialogQuery = {}, opts: { timeoutMs?: number } = {}): Promise<DialogHandle> {
    const dialog = await waitFor(async () => {
      const list = await this.list(query.anyApp);
      return list.find((d) => {
        if (query.kind && d.kind !== query.kind) return false;
        if (query.title && !matches(d.title, query.title)) return false;
        if (query.text && !d.texts.some((t) => matches(t, query.text!))) return false;
        return true;
      });
    }, {
      timeoutMs: opts.timeoutMs ?? 10_000,
      intervalMs: 200,
      description: `dialog ${JSON.stringify(query)}`,
    });
    return new DialogHandle(this.#driver, dialog);
  }

  async shouldAppear(query: DialogQuery = {}, opts: { timeoutMs?: number } = {}): Promise<DialogHandle> {
    try {
      return await this.waitFor(query, opts);
    } catch {
      const all = await this.list(true);
      throw new AssertionError(
        `expected a dialog matching ${JSON.stringify(query)}.\n` +
          `Currently open: ${JSON.stringify(all.map((d) => ({ kind: d.kind, app: d.app, title: d.title, buttons: d.buttons.map((b) => b.title) })), null, 2)}`,
      );
    }
  }

  async shouldNotAppear(query: DialogQuery = {}, opts: { withinMs?: number } = {}): Promise<void> {
    const found = await this.waitFor(query, { timeoutMs: opts.withinMs ?? 2500 }).catch(() => undefined);
    if (found) throw new AssertionError(`expected no dialog matching ${JSON.stringify(query)}, but '${found.title}' is open`);
  }

  /** Waits for any modal and presses the given button. The one-liner form. */
  async accept(buttonTitle = 'OK', query: DialogQuery = {}): Promise<void> {
    const d = await this.waitFor(query);
    await d.click(buttonTitle);
  }

  /**
   * Dismisses every modal the app under test has open. Used to get back to a
   * clean state between tests.
   *
   * Deliberately scoped to the app's own process: other apps' dialogs (an
   * updater, a dictation overlay) are none of the test's business, and
   * pressing Escape at them both wastes time and interferes with whatever
   * else is on the machine. Each dialog is closed through its own cancel
   * control where it has one; Escape is the fallback, sent only after the app
   * is brought to the front so the key actually reaches it.
   */
  async dismissAll(): Promise<number> {
    const pid = this.#pid();
    let dismissed = 0;
    let previous = Infinity;
    for (let round = 0; round < 5; round++) {
      const own = (await this.list(false)).filter((d) => d.pid === pid);
      // Stop when a round made no progress: something is refusing to close and
      // retrying will not change that.
      if (!own.length || own.length >= previous) break;
      previous = own.length;
      for (const d of own) {
        const handle = new DialogHandle(this.#driver, d);
        const hasCancel = d.buttons.some((b) => b.enabled && CANCEL_TITLES.includes(b.title));
        if (!hasCancel) await this.#driver.activate(pid).catch(() => {});
        await handle.dismiss().catch(() => {});
        dismissed++;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return dismissed;
  }

}
