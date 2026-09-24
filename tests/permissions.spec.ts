import { describe, test } from '../src/index.ts';

/**
 * Privacy permissions.
 *
 * Be clear about what the OS makes testable here, because it constrains the
 * shape of every test in this file:
 *
 *   - Resetting a grant is supported (`tccutil reset`), so you *can* put an app
 *     back into its first-run state and test the consent flow.
 *   - Granting a permission from a script is impossible by design. TCC.db is
 *     protected by SIP and only the system consent UI may write to it. On CI,
 *     pre-grant with a PPPC configuration profile via MDM.
 *   - Reading a grant needs Full Disk Access for the *test* process. Without it
 *     `status()` reports 'unknown' rather than failing, so these tests stay
 *     meaningful on a developer laptop.
 *
 * The genuinely testable behaviours are therefore: does the app ask at the right
 * moment, does it ask only once, and does it degrade gracefully when denied.
 */
describe('Permissions', () => {
  test('the app-under-test\'s permission state can be queried', async ({ app }) => {
    const status = await app.permissions.status('Camera');
    if (!['allowed', 'denied', 'unset', 'unknown'].includes(status)) {
      throw new Error(`unexpected permission status: ${status}`);
    }
  });

  test('resetting a grant is safe and idempotent', async ({ app }) => {
    // Reset is the supported way to re-arm a first-run consent flow. It is a
    // no-op for an app that never asked, which is what the fixture does.
    await app.permissions.reset('Camera');
    await app.permissions.reset('Camera');
  });

  test('an app that requests nothing shows no consent prompt', async ({ app }) => {
    await app.tray.click('Show Window');
    await app.permissions.shouldNotPrompt({ withinMs: 2000 });
  });

  /**
   * The shape of a real first-run consent test. Enable it against an app that
   * actually requests a protected resource:
   *
   *   await app.permissions.reset('Microphone');   // before launch
   *   await app.find('button[title="Record"]').click();
   *   await app.permissions.answerPrompt('deny');
   *   await app.find('"Microphone access is required"').shouldExist();
   */
  test.skip('first-run consent flow', async () => {});
});
