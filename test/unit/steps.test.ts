import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StepBuilder, portableCombo, compactSteps, describeStep, dialogIdentity } from '../../src/recorder/steps.ts';
import { isRelevant } from '../../src/recorder/session.ts';
import { click, key, target, advance } from './fixtures.ts';

const kinds = (b: StepBuilder) => b.steps.map((s) => s.kind);

test('tray click then menu item becomes one tray.click step', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  b.apply({ type: 'click', event: click({ surface: 'tray', trayItem: { role: 'AXMenuBarItem', title: 'DTF' } }) });
  b.apply({ type: 'click', event: click({ surface: 'trayMenu', menuPath: ['Show Window'] }) });
  assert.deepEqual(b.steps.map(({ id: _i, at: _a, ...s }) => s), [{ kind: 'trayMenu', path: ['Show Window'], label: 'DTF' }]);
});

test('clicking through a submenu keeps only the leaf path', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  b.apply({ type: 'click', event: click({ surface: 'tray' }) });
  b.apply({ type: 'click', event: click({ surface: 'trayMenu', menuPath: ['Advanced'] }) });
  b.apply({ type: 'click', event: click({ surface: 'trayMenu', menuPath: ['Advanced', 'Reset'] }) });
  assert.equal(b.steps.length, 1);
  assert.deepEqual((b.steps[0] as { path: string[] }).path, ['Advanced', 'Reset']);
});

test('menu bar: File then File › Export collapses, and a lone File is dropped', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  b.apply({ type: 'click', event: click({ surface: 'menuBar', menuPath: ['File'] }) });
  b.apply({ type: 'click', event: click({ surface: 'menuBar', menuPath: ['File', 'Export…'] }) });
  b.apply({ type: 'click', event: click({ surface: 'menuBar', menuPath: ['Edit'] }) });
  assert.deepEqual(compactSteps(b.steps).map((s) => (s as { path: string[] }).path), [['File', 'Export…']]);
});

test('typing into a focused field becomes one fill, with backspace applied', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  const field = target('#name');
  b.apply({ type: 'click', event: click({ surface: 'window', element: { role: 'AXTextField' } }), target: field });
  for (const ch of 'helloo') b.apply({ type: 'key', event: key(ch), target: field });
  b.apply({ type: 'key', event: key('backspace', ''), target: field });
  assert.deepEqual(kinds(b), ['fill']);
  assert.equal((b.steps[0] as { text: string }).text, 'hello');
});

test('shift is text, not a shortcut', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  const field = target('#name');
  b.apply({ type: 'key', event: key('h', 'H', ['shift']), target: field });
  b.apply({ type: 'key', event: key('i', 'i'), target: field });
  assert.deepEqual(kinds(b), ['fill']);
  assert.equal((b.steps[0] as { text: string }).text, 'Hi');
});

test('shortcuts are recorded portably: cmd on macOS and ctrl on Windows both become mod', () => {
  assert.equal(portableCombo(['cmd'], 's', 'darwin'), 'mod+s');
  assert.equal(portableCombo(['ctrl'], 's', 'win32'), 'mod+s');
  assert.equal(portableCombo(['shift', 'cmd'], 'z', 'darwin'), 'mod+shift+z');
  assert.equal(portableCombo(['ctrl'], 'c', 'darwin'), 'ctrl+c');

  const b = new StepBuilder({ platform: 'win32' });
  b.apply({ type: 'key', event: key('s', 's', ['ctrl']) });
  assert.deepEqual(b.steps.map((s) => (s as { combo?: string }).combo), ['mod+s']);
});

test('enter and escape are key presses, not text', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  const field = target('#q');
  b.apply({ type: 'key', event: key('a'), target: field });
  b.apply({ type: 'key', event: key('enter', '\r'), target: field });
  b.apply({ type: 'key', event: key('escape', '\u001b') });
  assert.deepEqual(kinds(b), ['fill', 'press', 'press']);
});

test('a second click within the double-click window merges into a double-click', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  const row = target('row:nth(2)');
  b.apply({ type: 'click', event: click({ surface: 'window', count: 1 }), target: row });
  advance(-850); // the fixture clock adds 1s per click; land 150ms after the first
  b.apply({ type: 'click', event: click({ surface: 'window', count: 2 }), target: row });
  assert.equal(b.steps.length, 1);
  assert.equal((b.steps[0] as { count: number }).count, 2);
});

test('dialog button clicks become dialogButton steps identified by title', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  b.apply({
    type: 'click',
    event: click({
      surface: 'dialog', element: { role: 'AXButton', title: 'Save' },
      dialog: { kind: 'sheet', title: '', texts: ['Save changes?', 'Your edits will be lost.'] },
    }),
  });
  assert.deepEqual(b.steps.map(({ id: _i, at: _a, ...s }) => s), [
    { kind: 'dialogButton', dialog: { text: 'Save changes?', kind: 'sheet' }, button: 'Save' },
  ]);
});

test('file panels are identified by kind, not by localised text', () => {
  assert.deepEqual(
    dialogIdentity({ pid: 1, app: 'x', bundleId: 'y', surface: 'dialog', dialog: { kind: 'filePanel', title: 'Enregistrer', texts: [] } }),
    { kind: 'filePanel' },
  );
});

test('clicks in a tray popover window are scoped to the popup', () => {
  const b = new StepBuilder({ platform: 'darwin' });
  b.apply({ type: 'click', event: click({ surface: 'tray' }) });
  b.apply({ type: 'click', event: click({ surface: 'window', window: { role: 'AXWindow', title: '' } }), target: target('#sync', 'sync', '') });
  assert.deepEqual(kinds(b), ['trayOpen', 'click']);
  assert.equal((b.steps[1] as { target: { scope: { kind: string } } }).target.scope.kind, 'trayPopup');
});

test('describeStep gives one readable line per step', () => {
  assert.equal(describeStep({ kind: 'menu', path: ['File', 'Save'] }), 'Menu › File › Save');
  assert.equal(describeStep({ kind: 'expect', check: { type: 'notification', title: 'Done' } }), 'Expect notification “Done”');
});

test('only input aimed at the app under test is recorded', () => {
  assert.ok(isRelevant(click({ surface: 'window', pid: 42 }), 42));
  assert.ok(!isRelevant(click({ surface: 'window', pid: 7 }), 42), 'another app, e.g. the Studio browser tab');
  assert.ok(isRelevant(click({ surface: 'notification', pid: 300 }), 42), 'banners are owned by a system process');
  assert.ok(isRelevant(click({ surface: 'dialog', pid: 301, dialog: { kind: 'filePanel', title: '', texts: [] } }), 42));
  assert.ok(!isRelevant(click({ surface: 'dialog', pid: 301, dialog: { kind: 'dialog', title: 'Updates', texts: [] } }), 42));
  assert.ok(isRelevant(key('a', 'a', [], { pid: 42 }), 42));
  assert.ok(!isRelevant(key('a', 'a', [], { pid: 7 }), 42));
  assert.ok(isRelevant(key('a', 'a', [], { pid: 0, focus: { pid: 42, app: '', bundleId: '', surface: 'window' } }), 42));
});
