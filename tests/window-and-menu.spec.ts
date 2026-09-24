import { describe, test, beforeEach } from '../src/index.ts';

describe('Windows', () => {
  beforeEach(async ({ app }) => {
    await app.tray.click('Show Window');
    await app.windows.waitFor({ title: 'DTF Fixture' });
  });

  test('the main window is present and titled', async ({ app }) => {
    const window = await app.windows.shouldExist({ title: 'DTF Fixture' });
    const rect = await window.rect();
    if (!rect || rect.width < 100) throw new Error(`implausible window rect: ${JSON.stringify(rect)}`);
  });

  test('controls inside the window are reachable and interactive', async ({ app }) => {
    const window = app.windows.main();

    await window.find('#counter-label').shouldHaveText('Count: 0');
    await window.find('button[title="Increment"]').click();
    await window.find('#counter-label').shouldHaveText('Count: 1');
  });

  test('text fields accept typed input', async ({ app }) => {
    const field = app.windows.main().find('#demo-field');
    await field.fill('hello dtf');
    await field.shouldHaveText('hello dtf');
  });

  test('a window can be moved and resized', async ({ app }) => {
    const window = app.windows.main();
    await window.setBounds({ x: 120, y: 120, width: 520, height: 360 });

    const rect = await window.rect();
    if (!rect || Math.abs(rect.width - 520) > 2) {
      throw new Error(`expected width ~520, got ${JSON.stringify(rect)}`);
    }
  });
});

describe('Application menu bar', () => {
  test('the standard menus are present', async ({ app }) => {
    const menus = await app.menu.topLevel();
    for (const expected of ['File', 'Edit', 'Window']) {
      if (!menus.includes(expected)) {
        throw new Error(`expected a '${expected}' menu; found ${JSON.stringify(menus)}`);
      }
    }
  });

  test('menu items can be enumerated', async ({ app }) => {
    const fileItems = await app.menu.items('File');
    for (const expected of ['New Note', 'Save…', 'Close Window']) {
      if (!fileItems.includes(expected)) {
        throw new Error(`expected File > ${expected}; found ${JSON.stringify(fileItems)}`);
      }
    }
    await app.menu.shouldHave('Edit', 'Select All');
  });

  test('invoking a menu item reaches the app', async ({ app }) => {
    await app.tray.click('Show Window');
    await app.windows.waitFor({ title: 'DTF Fixture' });
    await app.menu.click('File', 'New Note');
    await app.waitForLog(/^count=\d+$/);
  });

  test('a menu item can close the window without quitting the app', async ({ app }) => {
    await app.tray.click('Show Window');
    await app.windows.waitFor({ title: 'DTF Fixture' });
    await app.menu.click('File', 'Close Window');
    await app.windows.shouldHaveNone();
    if (!(await app.isRunning())) throw new Error('app quit when the window closed');
  });
});
