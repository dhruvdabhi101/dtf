import { describe, test } from '../src/index.ts';

/**
 * Tray / menu-bar-extra coverage.
 *
 * This is the surface that motivated the framework: a status item lives outside
 * every window, so no in-process renderer test can observe it, and it is one of
 * the easiest things to break without noticing.
 */
describe('Tray', () => {
  test('registers a status item', async ({ app }) => {
    const item = await app.tray.shouldExist({ label: 'DTF' });
    if (!item.rect) throw new Error('tray item reported no on-screen rect');
  });

  test('the menu lists the expected items', async ({ app }) => {
    const menu = await app.tray.open();
    await menu.shouldHaveItem('Show Window');
    await menu.shouldHaveItem('Send Notification');
    await menu.shouldHaveItem('Quit');
    await menu.close();
  });

  test('activating a menu item reaches the app', async ({ app }) => {
    const menu = await app.tray.open();
    await menu.click('Increment Counter');
    await app.waitForLog(/^count=1$/);
  });

  test('nested submenus can be traversed', async ({ app }) => {
    const menu = await app.tray.open();
    await menu.click('Advanced', 'Nested Action');
    await app.waitForLog(/nested-action-fired/);
  });

  test('closing the last window leaves the app alive in the tray', async ({ app }) => {
    await app.tray.click('Show Window');
    const window = await app.windows.waitFor({ title: 'DTF Fixture' });
    await window.close();

    await app.windows.shouldHaveNone();
    if (!(await app.isRunning())) throw new Error('app quit instead of staying resident in the tray');
    await app.tray.shouldExist({ label: 'DTF' });
  });
});
