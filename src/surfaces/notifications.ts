import type { Driver } from '../drivers/driver.ts';
import type { Notification } from '../types.ts';
import { waitFor } from '../core/wait.ts';
import { AssertionError } from '../core/errors.ts';

export type NotificationQuery = {
  title?: string | RegExp;
  body?: string | RegExp;
  subtitle?: string | RegExp;
  /** Source app name. Defaults to the app under test. */
  app?: string;
  /** Matches against any text in the notification. */
  text?: string | RegExp;
  /** Search banners from every app, not just the app under test. */
  anyApp?: boolean;
};

function matches(value: string, pattern: string | RegExp): boolean {
  return pattern instanceof RegExp
    ? pattern.test(value)
    : value.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * OS notification banners.
 *
 * Read from the notification server's accessibility tree rather than from the
 * usernoted SQLite database. The database has richer history, but it is
 * TCC-protected and needs Full Disk Access on the test machine; the
 * accessibility route works with the permission this framework already needs
 * and reflects exactly what a user would see on screen.
 *
 * Practical caveat: a Focus mode that suppresses banners will suppress these
 * too. `dtf doctor` warns when Do Not Disturb is on.
 */
export class NotificationSurface {
  #driver: Driver;
  #appName: () => string;

  constructor(driver: Driver, appName: () => string) {
    this.#driver = driver;
    this.#appName = appName;
  }

  /** Every notification currently on screen, from any app. */
  listAll(): Promise<Notification[]> {
    return this.#driver.notificationList();
  }

  /** Only the notifications posted by the app under test. */
  async list(): Promise<Notification[]> {
    const name = this.#appName();
    const all = await this.listAll();
    return name ? all.filter((n) => n.app.toLowerCase().includes(name.toLowerCase())) : all;
  }

  #filter(list: Notification[], q: NotificationQuery): Notification | undefined {
    return list.find((n) => {
      if (q.app && !matches(n.app, q.app)) return false;
      if (q.title && !matches(n.title, q.title)) return false;
      if (q.subtitle && !matches(n.subtitle, q.subtitle)) return false;
      if (q.body && !matches(n.body, q.body)) return false;
      if (q.text && !n.texts.concat([n.raw]).some((t) => matches(t, q.text!))) return false;
      return true;
    });
  }

  /**
   * Waits for a matching banner.
   *
   * The default 15s window is generous on purpose: notification delivery goes
   * through a system daemon and is not synchronous with the call that posted it.
   */
  async waitFor(query: NotificationQuery = {}, opts: { timeoutMs?: number } = {}): Promise<Notification> {
    const scoped = query.app === undefined && !query.anyApp;
    return waitFor(async () => {
      const list = scoped ? await this.list() : await this.listAll();
      return this.#filter(list, query);
    }, {
      timeoutMs: opts.timeoutMs ?? 15_000,
      intervalMs: 250,
      description: `notification ${JSON.stringify(query)}`,
    });
  }

  async shouldHave(query: NotificationQuery, opts: { timeoutMs?: number } = {}): Promise<Notification> {
    try {
      return await this.waitFor(query, opts);
    } catch {
      const all = await this.listAll();
      throw new AssertionError(
        `expected a notification matching ${JSON.stringify(query)}.\n` +
          `Visible notifications: ${JSON.stringify(all.map((n) => ({ app: n.app, title: n.title, body: n.body })), null, 2)}\n` +
          `If this is unexpected, check that Do Not Disturb / a Focus mode is not suppressing banners.`,
      );
    }
  }

  async shouldNotHave(query: NotificationQuery, opts: { withinMs?: number } = {}): Promise<void> {
    const found = await this.waitFor(query, { timeoutMs: opts.withinMs ?? 3000 }).catch(() => undefined);
    if (found) {
      throw new AssertionError(
        `expected no notification matching ${JSON.stringify(query)}, but found: ` +
          JSON.stringify({ app: found.app, title: found.title, body: found.body }),
      );
    }
  }

  /** Clicks the banner body, which activates the app's notification handler. */
  async click(query: NotificationQuery = {}): Promise<void> {
    const n = await this.waitFor(query);
    await this.#driver.notificationAct(n.index, 'press');
  }

  /**
   * Presses a named action button on the banner.
   *
   * Action buttons are only rendered while the pointer is over the banner, so
   * the driver hovers first — this is why the mouse moves during these tests.
   */
  async clickAction(actionTitle: string, query: NotificationQuery = {}): Promise<void> {
    const n = await this.waitFor(query);
    await this.#driver.notificationAct(n.index, actionTitle);
  }

  async dismiss(query: NotificationQuery = {}): Promise<void> {
    const n = await this.waitFor(query);
    await this.#driver.notificationAct(n.index, 'close');
  }

  /** Clears everything on screen. Worth calling in test setup for a clean slate. */
  async dismissAll(): Promise<number> {
    let cleared = 0;
    for (let i = 0; i < 20; i++) {
      const list = await this.listAll();
      if (list.length === 0) break;
      try {
        await this.#driver.notificationAct(0, 'close');
        cleared++;
      } catch {
        break;
      }
    }
    return cleared;
  }
}
