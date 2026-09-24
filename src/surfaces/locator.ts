import type { Driver, Root } from '../drivers/driver.ts';
import type { AXNode, MouseButton, Rect, SelectorPath } from '../types.ts';
import { toSelectorPath, describeSelector } from '../core/selector.ts';
import { waitFor } from '../core/wait.ts';
import { AssertionError } from '../core/errors.ts';

export type RootProvider = () => Promise<Root>;

export type LocatorOptions = { timeoutMs?: number };

/**
 * A lazy, self-retrying handle to an element.
 *
 * Nothing is queried until you act on it, and every action re-resolves the
 * element first. That matters more on the desktop than on the web: menus are
 * rebuilt from scratch each time they open, and a handle you grabbed a moment
 * ago is frequently already dead.
 */
export class Locator {
  #driver: Driver;
  #root: RootProvider;
  #path: ReturnType<typeof toSelectorPath>;
  #label: string;
  #timeoutMs: number;

  constructor(driver: Driver, root: RootProvider, selector: SelectorPath, opts: LocatorOptions = {}) {
    this.#driver = driver;
    this.#root = root;
    this.#path = toSelectorPath(selector);
    this.#label = describeSelector(selector);
    this.#timeoutMs = opts.timeoutMs ?? 5000;
  }

  get description() { return this.#label; }

  /** Narrows to a descendant. */
  find(selector: SelectorPath, opts: LocatorOptions = {}): Locator {
    return new Locator(this.#driver, async () => ({ ref: (await this.resolve()).ref }), selector, {
      timeoutMs: opts.timeoutMs ?? this.#timeoutMs,
    });
  }

  /** Resolves to the live node, waiting for it to appear. */
  async resolve(opts: LocatorOptions = {}): Promise<AXNode> {
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    return waitFor(
      async () => this.#driver.find(await this.#root(), this.#path, { maxDepth: 0 }),
      { timeoutMs, description: `element ${this.#label}` },
    );
  }

  /** Resolves to the node *and* its subtree. */
  async snapshot(maxDepth = 6): Promise<AXNode> {
    const node = await this.resolve();
    return this.#driver.tree({ ref: node.ref }, { maxDepth });
  }

  async all(): Promise<AXNode[]> {
    return this.#driver.findAll(await this.#root(), this.#path);
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }

  async exists(): Promise<boolean> {
    return this.#driver.exists(await this.#root(), this.#path);
  }

  async waitUntilGone(opts: LocatorOptions = {}): Promise<void> {
    await waitFor(async () => !(await this.exists()), {
      timeoutMs: opts.timeoutMs ?? this.#timeoutMs,
      description: `${this.#label} to disappear`,
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Presses the element.
   *
   * Prefers the accessibility press action, which is synchronous and does not
   * move the user's pointer. Falls back to a real synthetic click for controls
   * that only respond to hardware-level events (common in Electron and in
   * custom-drawn UI).
   */
  async click(opts: { button?: MouseButton; count?: number; modifiers?: string[]; force?: boolean } = {}): Promise<void> {
    const node = await this.resolve();
    const wantsMouse = opts.force || opts.button === 'right' || opts.button === 'middle' || (opts.count ?? 1) > 1;
    if (!wantsMouse && node.actions?.includes('AXPress')) {
      try {
        await this.#driver.elementAction(node.ref, 'AXPress');
        return;
      } catch {
        // fall through to a real click
      }
    }
    await this.#driver.elementClick(node.ref, opts);
  }

  async doubleClick(): Promise<void> { return this.click({ count: 2 }); }
  async rightClick(): Promise<void> { return this.click({ button: 'right' }); }

  async hover(): Promise<void> {
    await this.#driver.elementHover((await this.resolve()).ref);
  }

  async focus(): Promise<void> {
    await this.#driver.elementFocus((await this.resolve()).ref);
  }

  /** Sets the value directly via accessibility — instant, no keystrokes. */
  async setValue(value: string | number | boolean): Promise<void> {
    await this.#driver.elementSetValue((await this.resolve()).ref, value);
  }

  /**
   * Focuses the element and types character by character.
   *
   * Slower than `setValue`, but it fires the same input events a user would, so
   * it exercises validation, autocomplete, and change handlers.
   */
  async fill(text: string, opts: { clear?: boolean } = {}): Promise<void> {
    await this.focus();
    if (opts.clear !== false) {
      await this.#driver.key('mod+a');
      await this.#driver.key('delete');
    }
    await this.#driver.type(text);
  }

  async press(combo: string): Promise<void> {
    await this.focus();
    await this.#driver.key(combo);
  }

  async performAction(action: string): Promise<void> {
    await this.#driver.elementAction((await this.resolve()).ref, action);
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async text(): Promise<string> {
    const n = await this.resolve();
    return (n.title ?? (typeof n.value === 'string' ? n.value : undefined) ?? n.description ?? '').toString();
  }

  async value(): Promise<unknown> { return (await this.resolve()).value; }
  async isEnabled(): Promise<boolean> { return (await this.resolve()).enabled !== false; }
  async isFocused(): Promise<boolean> { return (await this.resolve()).focused === true; }
  async rect(): Promise<Rect> { return this.#driver.elementRect((await this.resolve()).ref); }

  /** Every accessibility attribute the platform exposes. Useful when writing a new test. */
  async attributes() { return this.#driver.elementAttributes((await this.resolve()).ref); }

  // ── Assertions ───────────────────────────────────────────────────────────

  /**
   * Assertions poll until the deadline, so a test never has to sleep before
   * checking something the UI is still animating into place.
   */
  async shouldExist(opts: LocatorOptions = {}): Promise<void> {
    await waitFor(() => this.exists(), {
      timeoutMs: opts.timeoutMs ?? this.#timeoutMs,
      description: `${this.#label} to exist`,
    }).catch(() => {
      throw new AssertionError(`expected ${this.#label} to exist, but it was never found`);
    });
  }

  async shouldNotExist(opts: LocatorOptions = {}): Promise<void> {
    await waitFor(async () => !(await this.exists()), {
      timeoutMs: opts.timeoutMs ?? this.#timeoutMs,
      description: `${this.#label} to not exist`,
    }).catch(() => {
      throw new AssertionError(`expected ${this.#label} not to exist, but it is present`);
    });
  }

  async shouldHaveText(expected: string | RegExp, opts: LocatorOptions = {}): Promise<void> {
    let actual = '';
    const ok = await waitFor(async () => {
      actual = await this.text();
      return expected instanceof RegExp ? expected.test(actual) : actual.includes(expected);
    }, { timeoutMs: opts.timeoutMs ?? this.#timeoutMs, description: `${this.#label} text` }).catch(() => false);
    if (!ok) {
      throw new AssertionError(
        `expected ${this.#label} to have text ${expected}, got ${JSON.stringify(actual)}`,
        expected, actual,
      );
    }
  }

  async shouldBeEnabled(opts: LocatorOptions = {}): Promise<void> {
    const ok = await waitFor(() => this.isEnabled(), {
      timeoutMs: opts.timeoutMs ?? this.#timeoutMs, description: `${this.#label} enabled`,
    }).catch(() => false);
    if (!ok) throw new AssertionError(`expected ${this.#label} to be enabled`);
  }

  async shouldBeDisabled(opts: LocatorOptions = {}): Promise<void> {
    const ok = await waitFor(async () => !(await this.isEnabled()), {
      timeoutMs: opts.timeoutMs ?? this.#timeoutMs, description: `${this.#label} disabled`,
    }).catch(() => false);
    if (!ok) throw new AssertionError(`expected ${this.#label} to be disabled`);
  }
}
