import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { generateSpec, generateBody, appendToSpec, lit } from '../../src/recorder/codegen.ts';
import type { Step, StepInput } from '../../src/recorder/steps.ts';
import { target } from './fixtures.ts';

const run = promisify(execFile);
let n = 0;
const step = (s: StepInput): Step => ({ ...s, id: `t${n++}` });

test('string literals escape quotes, backslashes and newlines', () => {
  assert.equal(lit(`it's`), `'it\\'s'`);
  assert.equal(lit('a\\b'), `'a\\\\b'`);
  assert.equal(lit('two\nlines'), `'two\\nlines'`);
});

test('a recorded flow reads like hand-written code', () => {
  const code = generateBody([
    step({ kind: 'trayMenu', path: ['Show Window'] }),
    step({ kind: 'click', target: target('#btn-increment', 'button', 'DTF Fixture'), button: 'left', count: 1 }),
    step({ kind: 'fill', target: target('#demo-field', 'field', 'DTF Fixture'), text: 'hello' }),
    step({ kind: 'press', combo: 'mod+s' }),
    step({ kind: 'expect', check: { type: 'text', target: target('#counter-label', 'label', 'DTF Fixture'), text: 'Count: 1' } }),
  ], '');
  assert.equal(code, [
    `await app.tray.click('Show Window');`,
    `const dtfFixtureWindow = app.windows.get({ title: 'DTF Fixture' });`,
    `await dtfFixtureWindow.find('#btn-increment').click();`,
    `await dtfFixtureWindow.find('#demo-field').fill('hello');`,
    `await app.key('mod+s');`,
    `await dtfFixtureWindow.find('#counter-label').shouldHaveText('Count: 1');`,
  ].join('\n'));
});

test('a window used once is inlined rather than given a variable', () => {
  const code = generateBody([step({ kind: 'click', target: target('#ok', 'ok', 'Prefs'), button: 'left', count: 1 })], '');
  assert.equal(code, `await app.windows.get({ title: 'Prefs' }).find('#ok').click();`);
});

test('dialog steps declare the dialog once and reuse it', () => {
  const code = generateBody([
    step({ kind: 'fill', target: { scope: { kind: 'dialog', dialogKind: 'filePanel' }, selector: 'textfield', label: 'f' }, text: 'out.csv' }),
    step({ kind: 'dialogButton', dialog: { kind: 'filePanel' }, button: 'Save' }),
  ], '');
  assert.equal(code, [
    `const dialog = await app.dialogs.shouldAppear({ kind: 'filePanel', anyApp: true });`,
    `await dialog.find('textfield').fill('out.csv');`,
    `await dialog.click('Save');`,
  ].join('\n'));
});

test('right-click tray opens use the popup variable for the following menu click', () => {
  const code = generateBody([
    step({ kind: 'trayOpen', button: 'right', label: 'My App' }),
    step({ kind: 'trayMenu', path: ['Quit'] }),
  ], '');
  assert.equal(code, [
    `const popup = await app.tray.open({ label: 'My App' }, { button: 'right' });`,
    `await popup.click('Quit');`,
  ].join('\n'));
});

test('checks map onto the framework assertions', () => {
  const code = generateBody([
    step({ kind: 'expect', check: { type: 'notification', title: 'Export complete' } }),
    step({ kind: 'expect', check: { type: 'dialog', text: 'Unsaved changes' } }),
    step({ kind: 'expect', check: { type: 'noWindows' } }),
    step({ kind: 'expect', check: { type: 'menuItem', path: ['File', 'Export…'] } }),
    step({ kind: 'expect', check: { type: 'log', pattern: 'saved to /tmp/x' } }),
  ], '');
  assert.equal(code, [
    `await app.notifications.shouldHave({ title: 'Export complete' });`,
    `await app.dialogs.shouldAppear({ text: 'Unsaved changes' });`,
    `await app.windows.shouldHaveNone();`,
    `await app.menu.shouldHave('File', 'Export…');`,
    `await app.waitForLog(/saved to \\/tmp\\/x/);`,
  ].join('\n'));
});

test('generated specs are valid TypeScript that Node can load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dtf-codegen-'));
  try {
    const src = generateSpec([
      step({ kind: 'trayMenu', path: [`It's "quoted"`] }),
      step({ kind: 'fill', target: target(`button[title="a, b"]`, 'x', `Win's`), text: 'line\nbreak' }),
      step({ kind: 'comment', text: 'a note' }),
    ], { testName: `it's a test`, describeName: 'Suite', importFrom: 'dtf' })
      // Swap the import for a stub so the file can be executed on its own.
      .replace(`from 'dtf'`, `from './stub.ts'`);
    await writeFile(join(dir, 'stub.ts'), 'export const describe = (_n: string, f: () => void) => f();\nexport const test = (_n: string, _f: unknown) => {};\n');
    await writeFile(join(dir, 'gen.spec.ts'), src);
    await run(process.execPath, ['--no-warnings', join(dir, 'gen.spec.ts')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendToSpec adds a test at the end and imports test when missing', () => {
  const src = `import { describe } from 'dtf';\n\ndescribe('x', () => {});\n`;
  const out = appendToSpec(src, [step({ kind: 'press', combo: 'enter' })], 'new one');
  assert.match(out, /^import \{ describe, test \} from 'dtf';/);
  assert.match(out, /test\('new one', async \(\{ app \}\) => \{\n  await app\.key\('enter'\);\n\}\);\n$/);

  const already = `import { test } from 'dtf';\n`;
  assert.equal(appendToSpec(already, [], 'e').match(/import/g)?.length, 1);
});
