import { describe, test, afterEach } from '../src/index.ts';
import { RecordingSession } from '../src/recorder/session.ts';
import { generateBody } from '../src/recorder/codegen.ts';
import { sleep, waitFor } from '../src/core/wait.ts';
import type { Rect } from '../src/types.ts';

/**
 * The recorder, end to end: real mouse and keyboard input goes in, steps and
 * code come out.
 *
 * Input here is deliberately synthesised as hardware-level events (`driver.click`,
 * `driver.type`) rather than accessibility presses, because that is the only
 * kind of input the recorder can see — the same input a person produces.
 *
 * Written purely against the framework API, so it is also the recorder's
 * acceptance test on every platform: a new driver passes this unchanged.
 */

const center = (r: Rect | undefined) => {
  if (!r) throw new Error('element has no on-screen rect');
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

let session: RecordingSession | null = null;

describe('Recorder', () => {
  afterEach(async () => {
    await session?.stop();
    session = null;
  });

  test('turns tray, click and typing input into steps and code', async ({ app, driver }) => {
    session = new RecordingSession(driver, app, { observe: false });
    await session.start();

    // Tray icon, then its "Show Window" item — with real clicks.
    const [tray] = await app.tray.list();
    let p = center(tray.rect);
    await driver.click(p.x, p.y);
    const item = await waitFor(() => driver.find({ ref: tray.ref }, [{ role: 'AXMenuItem', title: 'Show Window' }]).catch(() => undefined),
      { timeoutMs: 3000, description: 'the tray menu' });
    p = center(item.rect);
    await driver.click(p.x, p.y);
    await app.windows.waitFor({ title: 'DTF Fixture' });

    const window = app.windows.main();
    p = center(await window.find('#btn-increment').rect());
    await driver.click(p.x, p.y);

    p = center(await window.find('#demo-field').rect());
    await driver.click(p.x, p.y);
    await sleep(200);
    await driver.type('hi there', 30);
    await driver.key('backspace');
    await driver.key('mod+a');

    // Steps are resolved asynchronously; wait for the last one to land.
    await waitFor(async () => session!.steps.some((s) => s.kind === 'press'), { timeoutMs: 5000, description: 'the recorded shortcut' });

    const kinds = session.steps.map((s) => s.kind);
    if (JSON.stringify(kinds) !== JSON.stringify(['trayMenu', 'click', 'fill', 'press'])) {
      throw new Error(`unexpected steps: ${JSON.stringify(session.steps, null, 2)}`);
    }

    const code = generateBody(session.steps, '');
    const expected = [
      `await app.tray.click('Show Window');`,
      `const dtfFixtureWindow = app.windows.get({ title: 'DTF Fixture' });`,
      `await dtfFixtureWindow.find('#btn-increment').click();`,
      `await dtfFixtureWindow.find('#demo-field').fill('hi ther');`,
      `await app.key('mod+a');`,
    ].join('\n');
    if (code !== expected) throw new Error(`generated code differs:\n${code}\n\nexpected:\n${expected}`);
  });

  test('pick mode selects an element without clicking it', async ({ app, driver }) => {
    await app.tray.click('Show Window');
    const window = await app.windows.waitFor({ title: 'DTF Fixture' });
    const before = await window.find('#counter-label').text();

    session = new RecordingSession(driver, app, { observe: false });
    await session.start();
    const picked = session.pick(10_000);
    await sleep(150);

    // Pick the Increment button: if the click leaked through, the count would change.
    const p = center(await window.find('#btn-increment').rect());
    await driver.click(p.x, p.y);
    const result = await picked;

    if (result.target.selector !== '#btn-increment') throw new Error(`picked ${result.target.selector}`);
    await sleep(300);
    const after = await window.find('#counter-label').text();
    if (after !== before) throw new Error(`the pick click reached the app: ${before} → ${after}`);
    if (session.steps.length !== 0) throw new Error(`a pick must not record a step: ${JSON.stringify(session.steps)}`);
  });
});
