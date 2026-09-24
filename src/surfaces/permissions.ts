import type { Driver } from '../drivers/driver.ts';
import type { PermissionService } from '../types.ts';
import type { DialogSurface } from './dialogs.ts';
import { AssertionError, UnsupportedError } from '../core/errors.ts';

/**
 * The app-under-test's privacy permissions.
 *
 * What is and is not possible here is dictated by the OS, and it is worth being
 * explicit about it because it shapes how you write these tests.
 *
 * macOS:
 *   - Resetting a grant is allowed. `tccutil reset` is the supported way to put
 *     the app back into its first-run state so the consent prompt appears again.
 *   - Granting a permission from a script is deliberately impossible. TCC.db is
 *     protected by SIP and only the system consent UI may write to it. To
 *     pre-grant on a CI machine, install a PPPC configuration profile on the
 *     runner — the only supported route, and it needs MDM enrolment.
 *   - Reading current grants needs Full Disk Access for the test process; without
 *     it, reads return 'unknown' rather than failing the test.
 *
 * Windows:
 *   - Consent lives in the CapabilityAccessManager consent store, plain HKCU
 *     registry, so reset, read *and* `grant()` / `deny()` all work without a
 *     prompt. The app is identified by its executable path (its `bundleId`).
 *   - UAC elevation prompts live on the secure desktop and cannot be answered
 *     from a script; `answerPrompt` throws `UnsupportedError` for them.
 *
 * On both, the testable behaviours are: does the app ask at the right moment,
 * does it ask only once, and does it degrade correctly when denied.
 */
export class PermissionSurface {
  #driver: Driver;
  #bundleId: () => string;
  #dialogs: DialogSurface;

  constructor(driver: Driver, bundleId: () => string, dialogs: DialogSurface) {
    this.#driver = driver;
    this.#bundleId = bundleId;
    this.#dialogs = dialogs;
  }

  /**
   * Puts the app back to its pre-consent state for one service.
   *
   * Call this in setup, before launching, when you want to test the first-run
   * consent flow. Note it takes effect for the *next* launch.
   */
  async reset(service: PermissionService): Promise<void> {
    await this.#driver.resetPermission(service, this.#bundleId());
  }

  async resetAll(): Promise<void> {
    await this.#driver.resetPermission('All', this.#bundleId());
  }

  /** 'unknown' means the test process cannot read the consent store, not that it is unset. */
  status(service: PermissionService): Promise<'allowed' | 'denied' | 'unset' | 'unknown'> {
    return this.#driver.readPermission(service, this.#bundleId());
  }

  /**
   * Pre-grants a permission without a prompt, on platforms whose consent store
   * is writable (Windows). Throws `UnsupportedError` on macOS, where this is
   * impossible by design.
   */
  async grant(service: PermissionService): Promise<void> {
    await this.#set(service, 'allowed');
  }

  /** Records a denial without a prompt, so the denied-path UI can be tested directly. */
  async deny(service: PermissionService): Promise<void> {
    await this.#set(service, 'denied');
  }

  async #set(service: PermissionService, state: 'allowed' | 'denied'): Promise<void> {
    if (!this.#driver.setPermission) {
      throw new UnsupportedError(`${state === 'allowed' ? 'granting' : 'denying'} a permission from a script`, this.#driver.platformName);
    }
    await this.#driver.setPermission(service, this.#bundleId(), state);
  }

  /**
   * Waits for the system consent prompt and answers it.
   *
   * The prompt is a window owned by a system process, not by the app, which is
   * why this searches across processes.
   */
  async answerPrompt(choice: 'allow' | 'deny', opts: { timeoutMs?: number } = {}): Promise<void> {
    const dialog = await this.#dialogs.waitFor({ anyApp: true, kind: 'dialog' }, opts).catch(() => undefined);
    if (!dialog) throw new AssertionError('no system permission prompt appeared');
    if (!dialog.automatable) {
      throw new UnsupportedError(`answering the '${dialog.title}' prompt (it is on the secure desktop)`, this.#driver.platformName);
    }

    // Consent prompts vary in wording across services and OS versions, so match
    // on any of the affirmative/negative labels Apple actually ships.
    const allowLabels = ['Allow', 'OK', 'Allow While Using App', 'Allow Once', 'Continue'];
    const denyLabels = ["Don't Allow", 'Deny', 'Cancel', "Don't Allow Access"];
    const wanted = choice === 'allow' ? allowLabels : denyLabels;
    const found = wanted.find((l) => dialog.buttons.includes(l));

    if (!found) {
      throw new AssertionError(
        `permission prompt '${dialog.title}' has no ${choice} button; buttons: ${JSON.stringify(dialog.buttons)}`,
      );
    }
    await dialog.click(found);
  }

  async shouldPrompt(opts: { timeoutMs?: number } = {}): Promise<void> {
    const dialog = await this.#dialogs.waitFor({ anyApp: true }, opts).catch(() => undefined);
    if (!dialog) throw new AssertionError('expected the app to trigger a system permission prompt, but none appeared');
  }

  async shouldNotPrompt(opts: { withinMs?: number } = {}): Promise<void> {
    const dialog = await this.#dialogs
      .waitFor({ anyApp: true }, { timeoutMs: opts.withinMs ?? 3000 })
      .catch(() => undefined);
    if (dialog) {
      throw new AssertionError(
        `expected no permission prompt, but '${dialog.title}' appeared (buttons: ${JSON.stringify(dialog.buttons)})`,
      );
    }
  }
}
