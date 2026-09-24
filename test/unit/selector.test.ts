import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toSelectorPath, describeSelector } from '../../src/core/selector.ts';
import {
  selectorCandidates, quoteValue, isStableIdentifier, roleName, withNth, describeElement,
} from '../../src/recorder/selectors.ts';

test('DSL: role + exact title', () => {
  assert.deepEqual(toSelectorPath('button[title="Save"]'), [{ role: 'AXButton', title: 'Save' }]);
});

test('DSL: identifier shorthand, free text, nth and chains', () => {
  assert.deepEqual(toSelectorPath('#save'), [{ identifier: 'save' }]);
  assert.deepEqual(toSelectorPath('"Welcome back"'), [{ text: 'Welcome back' }]);
  assert.deepEqual(toSelectorPath('menuitem[title=Quit]:nth(1)'), [{ role: 'AXMenuItem', title: 'Quit', nth: 1 }]);
  assert.deepEqual(toSelectorPath('window >> button[title=OK]'), [{ role: 'AXWindow' }, { role: 'AXButton', title: 'OK' }]);
});

test('DSL: quoted values may contain commas and the other quote', () => {
  assert.deepEqual(toSelectorPath(`text[value="a, b"]`), [{ role: 'AXStaticText', value: 'a, b' }]);
  assert.deepEqual(toSelectorPath(`button[title='Say "hi"']`), [{ role: 'AXButton', title: 'Say "hi"' }]);
});

test('DSL: unknown attributes are an error, not a silent no-op', () => {
  assert.throws(() => toSelectorPath('button[colour=red]'), /unknown selector attribute/);
});

test('describeSelector renders object selectors readably', () => {
  assert.equal(describeSelector({ role: 'AXButton', title: 'OK' }), 'role="AXButton" title="OK"');
});

test('roleName reverses the alias table, preferring the canonical alias', () => {
  assert.equal(roleName('AXButton'), 'button');
  assert.equal(roleName('AXRadioButton'), 'radio');
  assert.equal(roleName('AXTextField'), 'textfield');
  assert.equal(roleName('AXSomethingNew'), 'AXSomethingNew');
});

test('quoteValue picks a quote that does not clash, or gives up', () => {
  assert.equal(quoteValue('Save'), '"Save"');
  assert.equal(quoteValue('Say "hi"'), `'Say "hi"'`);
  assert.equal(quoteValue(`it's "x"`), undefined);
  assert.equal(quoteValue('a >> b'), undefined);
});

test('generated identifiers are not treated as stable', () => {
  assert.ok(isStableIdentifier('save-button'));
  assert.ok(!isStableIdentifier('_NS:123'));
  assert.ok(!isStableIdentifier('4021'));
  assert.ok(!isStableIdentifier('3f2504e0-4f89-11d3-9a0c-0305e82c3301'));
  assert.ok(!isStableIdentifier('has space'));
  assert.ok(!isStableIdentifier(undefined));
});

test('candidates prefer identifier, then title, then description', () => {
  const c = selectorCandidates({ role: 'AXButton', identifier: 'btn-save', title: 'Save', description: 'Save file' });
  assert.deepEqual(c.slice(0, 3), ['#btn-save', 'button[title="Save"]', 'button[desc="Save file"]']);
  assert.equal(c.at(-1), 'button');
});

test('an unlabelled element is scoped under its nearest labelled ancestor', () => {
  const c = selectorCandidates(
    { role: 'AXTextField' },
    [{ role: 'AXGroup' }, { role: 'AXGroup', title: 'Account' }, { role: 'AXWindow', title: 'Settings' }],
  );
  assert.equal(c[0], 'group[title="Account"] >> textfield');
});

test('static text uses its value; editable fields never do', () => {
  assert.ok(selectorCandidates({ role: 'AXStaticText', value: 'Count: 0' }).includes('text[value="Count: 0"]'));
  assert.ok(!selectorCandidates({ role: 'AXTextField', value: 'user typed this' }).some((s) => s.includes('user typed')));
});

test('overlong labels are treated as content, not names', () => {
  const long = 'x'.repeat(200);
  assert.deepEqual(selectorCandidates({ role: 'AXButton', title: long }), ['button']);
});

test('withNth and describeElement', () => {
  assert.equal(withNth('button', 2), 'button:nth(2)');
  assert.deepEqual(toSelectorPath(withNth('button[title="A"]', 2)), [{ role: 'AXButton', title: 'A', nth: 2 }]);
  assert.equal(describeElement({ role: 'AXButton', title: 'Save' }), 'button “Save”');
  assert.equal(describeElement({ role: 'AXGroup' }), 'group');
});
