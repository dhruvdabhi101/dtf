import { describe, test, beforeAll, sleep } from '../../src/index.ts';

/**
 * Worktrace lifecycle, windows and permissions.
 *
 * Everything here is read-only against the real signed-in profile. Nothing signs
 * out, toggles discovery, or quits.
 */
describe('Worktrace boot', () => {
  beforeAll(async ({ app }) => {
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
  });

  test('boots with no windows — it is a tray-first app', async ({ app }) => {
    // The defining behaviour of this app: it lives in the menu bar and opens
    // nothing on launch. A regression here (a window flashing up on every boot)
    // is invisible to a renderer-level test, because the renderer is exactly
    // what would be wrongly appearing.
    await app.windows.shouldHaveNone({ timeoutMs: 8000 });
  });

  test('stays resident after boot settles', async ({ app }) => {
    await sleep(3000);
    if (!(await app.isRunning())) {
      throw new Error(`Worktrace exited during boot. Log tail:\n${app.logText().split('\n').slice(-20).join('\n')}`);
    }
  });

  test('exposes a complete application menu bar', async ({ app }) => {
    const menus = await app.menu.topLevel();
    for (const expected of ['Worktrace', 'File', 'Edit', 'View', 'Window']) {
      if (!menus.includes(expected)) {
        throw new Error(`missing '${expected}' menu; found ${JSON.stringify(menus)}`);
      }
    }
  });

  test('does not log an error during boot', async ({ app }) => {
    await sleep(4000);

    // Deliberately narrow: this pins one specific known bad line rather than
    // any string containing "error", so it fails for a real reason and not
    // because a log message was reworded.
    await app.shouldNotLog(/safeStorage cannot be used before app is ready/);
  });
});

describe('Worktrace permissions window', () => {
  beforeAll(async ({ app }) => {
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
  });

  /**
   * Opens the permissions window from a known-closed state.
   *
   * Tests in a `per-file` run share one app instance, so a test that assumes
   * "no windows are open" only passes when it happens to run first. Making the
   * precondition explicit is what keeps these order-independent — and it is
   * cheap here because the app reuses a single window rather than stacking them.
   */
  const openPermissions = async (app: import('../../src/index.ts').DesktopApp) => {
    await closeAllWindows(app);
    await app.tray.click('Permissions');
    const window = await app.windows.waitFor({}, { timeoutMs: 10_000 });
    // Wait for Chromium to actually paint a render tree, not just for the frame.
    await window.find('"Close"').shouldExist({ timeoutMs: 10_000 });
    return window;
  };

  const closeAllWindows = async (app: import('../../src/index.ts').DesktopApp) => {
    for (let i = 0; i < 5 && (await app.windows.count()) > 0; i++) {
      const close = app.windows.main().find('"Close"');
      if (await close.exists()) await close.click();
      else await app.windows.main().close();
      await sleep(400);
    }
  };

  test('the tray opens the permissions window', async ({ app }) => {
    const window = await openPermissions(app);

    const rect = await window.rect();
    if (!rect || rect.width < 200 || rect.height < 200) {
      throw new Error(`permissions window has an implausible size: ${JSON.stringify(rect)}`);
    }
  });

  test('the permissions window explains what it needs', async ({ app }) => {
    const window = await openPermissions(app);

    // Readable only because the framework sets AXManualAccessibility at launch.
    // Without it Chromium never builds a render tree and this window is an empty
    // box to anything outside the process — including screen readers.
    await window.find('"Required permissions"').shouldExist();
    await window.find('"Grant permissions to enable AI discovery"').shouldExist();
  });

  test('re-opening reuses the window rather than stacking a new one', async ({ app }) => {
    await openPermissions(app);
    await app.tray.click('Permissions');
    await sleep(1500);

    const count = await app.windows.count();
    if (count !== 1) throw new Error(`expected the window to be reused, but ${count} are open`);
  });

  test('the permissions window can be closed again', async ({ app }) => {
    const window = await openPermissions(app);

    await window.find('"Close"').click();
    await app.windows.shouldHaveNone({ timeoutMs: 8000 });

    // Closing a window must not take the app down with it.
    if (!(await app.isRunning())) throw new Error('closing the permissions window quit the app');
  });

  test('screen recording permission is reported', async ({ app }) => {
    // Worktrace gates recording on systemPreferences.getMediaAccessStatus("screen").
    // 'unknown' here means the *test process* lacks Full Disk Access to read
    // TCC.db — not that the app lacks the grant. See README → Permissions.
    const status = await app.permissions.status('ScreenCapture');
    if (!['allowed', 'denied', 'unset', 'unknown'].includes(status)) {
      throw new Error(`unexpected status: ${status}`);
    }
  });

  test('no unexpected consent prompt appears on launch', async ({ app }) => {
    // A prompt on every launch (rather than once) is a classic TCC bug and a
    // top support complaint for recording apps.
    await app.permissions.shouldNotPrompt({ withinMs: 3000 });
  });
});
