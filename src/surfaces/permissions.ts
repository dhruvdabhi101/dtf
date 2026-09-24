import type { Driver } from '../drivers/driver.ts';
import type { PermissionService } from '../types.ts';
import type { DialogSurface } from './dialogs.ts';
import { AssertionError } from '../core/errors.ts';

/**
 * The app-under-test's privacy permissions.
 *
 * What is and is not possible here is dictated by the OS, and it is worth being
 * explicit about it because it shapes how you write these tests:
 *
 *   - Resetting a grant is allowed. `tccutil reset` is the supported way to put
 *     the app back into its first-run state so the consent prompt appears again.
 *   - Granting a permission from a script is deliberately impossible. TCC.db is
 *     protected by SIP and only the system consent UI may write to it.
 *   - Reading current grants needs Full Disk Access for the test process; without
 *     it, reads return 'unknown' rather than failing the test.
 *
 * So the testable behaviours are: does the app ask at the right moment, does it
 * ask only once, and does it degrade correctly when denied. To pre-grant
 * permissions on a CI machine, install a PPPC configuration profile on the
 * runner — that is the only supported route, and it needs MDM enrolment.
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

  /** 'unknown' means the test process cannot read TCC.db, not that it is unset. */
  status(service: PermissionService): Promise<'allowed' | 'denied' | 'unset' | 'unknown'> {
    return this.#driver.readPermission(service, this.#bundleId());
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
