import { describe, test, beforeAll } from '../../src/index.ts';

/**
 * Worktrace tray coverage.
 *
 * Worth comparing against `e2e/launch-and-tray.spec.ts` in the Worktrace repo.
 * That suite has a test called "tray icon is created and not destroyed after
 * boot" which asserts `app.isReady()`, that `app.getName()` is truthy, and that
 * the process is alive. All three would still pass if `TrayService.create()`
 * threw and no icon ever appeared — Playwright drives the renderer, and the tray
 * is not in the renderer.
 *
 * These tests look at the actual menu bar.
 */
describe('Worktrace tray', () => {
  beforeAll(async ({ app }) => {
    // Worktrace bootstraps services before creating the tray, so give the icon
    // its own window rather than assuming it exists the moment the process does.
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
  });

  test('registers exactly one status item', async ({ app }) => {
    const items = await app.tray.list();
    if (items.length !== 1) {
      throw new Error(`expected 1 tray icon, found ${items.length}: ${JSON.stringify(items.map((i) => i.label))}`);
    }
  });

  test('the status item is positioned on screen', async ({ app }) => {
    const [item] = await app.tray.list();
    if (!item.rect || item.rect.width < 8 || item.rect.height < 8) {
      throw new Error(`tray icon has an implausible rect: ${JSON.stringify(item.rect)}`);
    }
  });

  test('clicking the icon opens a menu', async ({ app }) => {
    const menu = await app.tray.open();
    if (menu.kind !== 'menu') {
      throw new Error(`expected an NSMenu, got a ${menu.kind}`);
    }
    if (menu.items().length < 3) {
      throw new Error(`tray menu looks empty: ${JSON.stringify(menu.items())}`);
    }
    await menu.close();
  });

  test('the menu exposes the core actions', async ({ app }) => {
    const menu = await app.tray.open();
    try {
      // These are the load-bearing entries: without them the app is unusable,
      // because the tray is its only UI surface.
      //
      // Note these are the labels the *shipped* 2.0.0-alpha build renders, which
      // differ from `main/helpers/menu-builders.ts` in the current source tree
      // ("Settings", "Turn on AI Workflow Discovery"). A test at this level pins
      // what users actually get, which is the point.
      await menu.shouldHaveItem('About Worktrace AI');
      await menu.shouldHaveItem('Permissions');
      await menu.shouldHaveItem('Sign Out');
      await menu.shouldHaveItem('Quit');
    } finally {
      await menu.close();
    }
  });

  test('the menu reflects the signed-in state', async ({ app }) => {
    const menu = await app.tray.open();
    try {
      const items = menu.items();

      // `buildStoppedStateMenu` / `buildRecordingStateMenu` render this line;
      // `buildUnauthenticatedMenu` renders "Not logged in" and "Sign in".
      const signedIn = items.find((i) => i.startsWith('Signed in as '));
      if (!signedIn) {
        throw new Error(`expected a "Signed in as …" entry; menu was ${JSON.stringify(items)}`);
      }
      if (items.includes('Sign in') || items.includes('Not logged in')) {
        throw new Error('menu shows both signed-in and signed-out entries at once');
      }
    } finally {
      await menu.close();
    }
  });

  test('recording state offers pause options', async ({ app }) => {
    const menu = await app.tray.open();
    try {
      const items = menu.items();
      const isDiscoveryOn = items.some((i) => i.startsWith('Turn off'));

      if (isDiscoveryOn) {
        const pauses = items.filter((i) => i.startsWith('Pause for'));
        if (pauses.length === 0) {
          throw new Error(`discovery is on but no "Pause for …" entry exists: ${JSON.stringify(items)}`);
        }
      } else {
        // The mirror image: when discovery is off there should be nothing to pause.
        if (items.some((i) => i.startsWith('Pause for'))) {
          throw new Error(`discovery is off but the menu still offers a pause: ${JSON.stringify(items)}`);
        }
      }
    } finally {
      await menu.close();
    }
  });

  test('the status item carries an accessibility label', async ({ app }) => {
    const [item] = await app.tray.list();
    if (!item.label.trim()) {
      throw new Error(
        'the tray icon exposes no accessibility label, description or tooltip.\n' +
          '  VoiceOver announces it as an unlabelled button, and any automation has to\n' +
          '  target it positionally.\n' +
          '  Fix in main/services/platform/tray.service.ts — the code calls\n' +
          '  setToolTip("Worktrace - Recording"/"- Idle"/"- Paused"), but the shipped\n' +
          '  build exposes neither that nor an accessibilityLabel on the status item.',
      );
    }
  });

  /**
   * Destructive: these mutate the real signed-in session, so they are skipped by
   * default. Run them against a build launched with `isolatedUserData: true`.
   */
  test.skip('signing out returns the menu to its logged-out state', async ({ app }) => {
    await app.tray.click('Sign Out');
    const menu = await app.tray.open();
    await menu.shouldHaveItem('Sign in');
    await menu.close();
  });

  test.skip('Quit terminates the app', async ({ app }) => {
    await app.tray.click('Quit');
    if (await app.isRunning()) throw new Error('app survived Quit');
  });
});
