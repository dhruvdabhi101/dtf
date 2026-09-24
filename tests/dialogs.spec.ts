import { describe, test, beforeEach } from '../src/index.ts';

/**
 * Native modals.
 *
 * An Electron/native alert or save panel is a separate window — sometimes in a
 * separate *process* — so it is invisible to any test running inside the app.
 */
describe('Native dialogs', () => {
  beforeEach(async ({ app }) => {
    await app.activate();
    await app.tray.click('Show Window');
  });

  test('an alert sheet exposes its message and buttons', async ({ app }) => {
    await app.find('button[title="Show Alert"]').click();

    // AppKit attaches alerts to their window as sheets; Windows has no sheet
    // and shows a task dialog window instead. The kind is the only difference.
    const dialog = await app.dialogs.shouldAppear({ kind: process.platform === 'darwin' ? 'sheet' : 'dialog' });
    await dialog.shouldHaveText('Are you sure?');
    await dialog.shouldHaveButtons('Confirm', 'Cancel');
    await dialog.click('Cancel');

    await app.waitForLog(/alert-result=cancel/);
  });

  test('confirming the alert reports the right result', async ({ app }) => {
    await app.find('button[title="Show Alert"]').click();
    const dialog = await app.dialogs.shouldAppear({ text: 'Are you sure?' });
    await dialog.click('Confirm');
    await app.waitForLog(/alert-result=confirm/);
  });

  test('a save panel is found and can be cancelled', async ({ app }) => {
    await app.find('button[title="Save File…"]').click();

    // Save panels are matched across processes on purpose: for a sandboxed app
    // the panel belongs to the system open/save XPC service, not to the app.
    const panel = await app.dialogs.shouldAppear({ anyApp: true, title: /Save/ });
    await panel.dismiss();
    await app.waitForLog(/save-result=cancelled/);
  });

  test('no dialog appears when nothing asked for one', async ({ app }) => {
    await app.dialogs.shouldNotAppear({}, { withinMs: 1500 });
  });
});
