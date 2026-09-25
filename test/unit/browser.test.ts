import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toUrl } from '../../src/surfaces/browser.ts';

test('toUrl: keeps a full URL', () => {
  assert.equal(toUrl('https://app.example.com/login?x=1'), 'https://app.example.com/login?x=1');
  assert.equal(toUrl('myapp://auth?token=t'), 'myapp://auth?token=t');
});

test('toUrl: Chromium omnibox without a scheme reads as https', () => {
  assert.equal(
    toUrl('app.worktrace.ai/auth/login?redirect=%2Fauth%2Fcli-token'),
    'https://app.worktrace.ai/auth/login?redirect=%2Fauth%2Fcli-token',
  );
  assert.equal(toUrl('example.com'), 'https://example.com');
  assert.equal(toUrl('localhost:3000/x'), 'https://localhost:3000/x');
});

test('toUrl: rejects search text and empties', () => {
  assert.equal(toUrl('worktrace login page'), undefined);
  assert.equal(toUrl('hello'), undefined);
  assert.equal(toUrl(''), undefined);
  assert.equal(toUrl(undefined), undefined);
});
