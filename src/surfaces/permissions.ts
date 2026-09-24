import type { Driver } from '../drivers/driver.ts';
import type { Dialog, PermissionService } from '../types.ts';
import { DialogHandle, type DialogSurface } from './dialogs.ts';
import { AssertionError, UnsupportedError } from '../core/errors.ts';
import { waitFor } from '../core/wait.ts';

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
  #pid: () => number;

  constructor(driver: Driver, bundleId: () => string, dialogs: DialogSurface, pid: () => number) {
    this.#driver = driver;
    this.#bundleId = bundleId;
    this.#dialogs = dialogs;
    this.#pid = pid;
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

  /** Dialogs on screen right now, as a baseline: anything already there is not a prompt this test caused. */
  async #snapshot(): Promise<Set<string>> {
    return new Set((await this.#dialogs.list(true).catch(() => [])).map(dialogKey));
  }

  /**
   * Waits for a consent prompt: a dialog that was not on screen at `baseline`
   * and either belongs to the app under test or offers consent buttons.
   *
   * Both conditions matter on a real machine, which always has other windows
   * that report themselves as dialogs — an updater, a dictation overlay, a
   * password manager. Treating any of those as a permission prompt makes
   * `shouldNotPrompt` fail for reasons that have nothing to do with the app.
   */
  async #waitForPrompt(baseline: Set<string>, timeoutMs: number): Promise<Dialog | undefined> {
    const pid = this.#pid();
    return waitFor(async () => {
      const all = await this.#dialogs.list(true);
      return all.find((d) => !baseline.has(dialogKey(d)) && (d.pid === pid || looksLikeConsent(d)));
    }, { timeoutMs, intervalMs: 200, description: 'a permission prompt' }).catch(() => undefined);
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
    const found = await this.#waitForPrompt(new Set(), opts.timeoutMs ?? 10_000);
    if (!found) throw new AssertionError('no system permission prompt appeared');
    const dialog = new DialogHandle(this.#driver, found);
    if (!dialog.automatable) {
      throw new UnsupportedError(`answering the '${dialog.title}' prompt (it is on the secure desktop)`, this.#driver.platformName);
    }

    const wanted = choice === 'allow' ? ALLOW_LABELS : DENY_LABELS;
    const label = wanted.find((l) => dialog.buttons.includes(l));
    if (!label) {
      throw new AssertionError(
        `permission prompt '${dialog.title}' has no ${choice} button; buttons: ${JSON.stringify(dialog.buttons)}`,
      );
    }
    await dialog.click(label);
  }

  /**
   * Passes once a consent prompt is on screen. No baseline here: the prompt is
   * usually already up by the time this runs, straight after the action that
   * triggered it.
   */
  async shouldPrompt(opts: { timeoutMs?: number } = {}): Promise<void> {
    const dialog = await this.#waitForPrompt(new Set(), opts.timeoutMs ?? 10_000);
    if (!dialog) throw new AssertionError('expected the app to trigger a system permission prompt, but none appeared');
  }

  /** Fails if a new consent prompt appears within the window. Dialogs already on screen are ignored. */
  async shouldNotPrompt(opts: { withinMs?: number } = {}): Promise<void> {
    const baseline = await this.#snapshot();
    const dialog = await this.#waitForPrompt(baseline, opts.withinMs ?? 3000);
    if (dialog) {
      throw new AssertionError(
        `expected no permission prompt, but '${dialog.title}' from ${dialog.app} appeared (buttons: ${JSON.stringify(dialog.buttons.map((b) => b.title))})`,
      );
    }
  }
}

/** Labels Apple and Microsoft actually ship on consent prompts. */
const ALLOW_LABELS = ['Allow', 'OK', 'Allow While Using App', 'Allow Once', 'Continue', 'Yes'];
const DENY_LABELS = ["Don't Allow", 'Deny', 'Cancel', "Don't Allow Access", 'No'];

function looksLikeConsent(d: Dialog): boolean {
  const titles = d.buttons.map((b) => b.title);
  return titles.some((t) => ALLOW_LABELS.includes(t)) && titles.some((t) => DENY_LABELS.includes(t));
}

function dialogKey(d: Dialog): string {
  return `${d.pid}|${d.kind}|${d.title}|${d.texts.slice(0, 2).join('|')}`;
}
