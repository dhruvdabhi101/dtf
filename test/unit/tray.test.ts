import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrayPopup } from '../../src/surfaces/tray.ts';
import type { Driver } from '../../src/drivers/driver.ts';
import type { AXNode } from '../../src/types.ts';

const item = (title: string, children?: AXNode[]): AXNode => ({ ref: title, role: 'AXMenuItem', title, children });

// What Electron publishes: submenu items are in the tree while the submenu is closed.
const root: AXNode = {
  ref: 'root', role: 'AXMenu', children: [
    item('AI is learning how you work'),
    item('Sign Out'),
    item('Turn off AI discovery', [
      { ref: 'sub', role: 'AXMenu', children: [item('Pause for 1 hour'), item('Pause for 24 hours'), item('Quit')] },
    ]),
  ],
};
const popup = new TrayPopup({} as Driver, 'tray', { kind: 'menu', root });

test('tray items(): top level only by default', () => {
  assert.deepEqual(popup.items(), ['AI is learning how you work', 'Sign Out', 'Turn off AI discovery']);
});

test('tray items({ nested: true }): the flattened list', () => {
  assert.deepEqual(popup.items({ nested: true }), [
    'AI is learning how you work', 'Sign Out', 'Turn off AI discovery', 'Pause for 1 hour', 'Pause for 24 hours', 'Quit',
  ]);
});

test('tray submenu(): by title or pattern', () => {
  assert.deepEqual(popup.submenu('Turn off AI discovery'), ['Pause for 1 hour', 'Pause for 24 hours', 'Quit']);
  assert.deepEqual(popup.submenu(/^Turn off/), ['Pause for 1 hour', 'Pause for 24 hours', 'Quit']);
  assert.deepEqual(popup.submenu('Sign Out'), []);
});
