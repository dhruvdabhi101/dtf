import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JUnitReporter, createReporters, serializeError, PrettyReporter, StreamReporter } from '../../src/runner/reporter.ts';
import { resolveApp, expandPath } from '../../src/runner/config.ts';
import { AssertionError } from '../../src/core/errors.ts';

test('JUnit output escapes XML and strips control characters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dtf-junit-'));
  try {
    await new JUnitReporter('/proj').onEvent({
      type: 'run-done',
      artifactsDir: dir,
      summary: {
        total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 1500,
        results: [
          { name: 'a <b> & "c"', file: '/proj/tests/x.spec.ts', status: 'passed', durationMs: 500 },
          { name: 'fails', file: '/proj/tests/x.spec.ts', status: 'failed', durationMs: 1000,
            error: { name: 'AssertionError', message: 'expected \u001b[31mred\u001b[0m', stack: 'at x' }, screenshot: '/tmp/s.png' },
        ],
      },
    });
    const xml = await readFile(join(dir, 'junit.xml'), 'utf8');
    assert.match(xml, /name="a &lt;b&gt; &amp; &quot;c&quot;"/);
    assert.match(xml, /<testsuite name="tests\/x.spec.ts" tests="2" failures="1"/);
    assert.match(xml, /\[\[ATTACHMENT\|\/tmp\/s.png\]\]/);
    assert.doesNotMatch(xml, /\u001b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reporters are created from a name, a list, or a comma string', () => {
  assert.ok(createReporters(undefined, '/') [0] instanceof PrettyReporter);
  const two = createReporters(['pretty', 'stream'], '/');
  assert.equal(two.length, 2);
  assert.ok(two[1] instanceof StreamReporter);
  assert.equal(createReporters('pretty,junit' as never, '/').length, 2);
  assert.equal(createReporters('silent', '/').length, 0);
  assert.throws(() => createReporters('nope' as never, '/'), /unknown reporter/);
});

test('errors serialise with their assertion details', () => {
  const e = serializeError(new AssertionError('bad', /x/, 'y'));
  assert.equal(e?.name, 'AssertionError');
  assert.equal(e?.expected, '/x/');
  assert.equal(e?.actual, 'y');
  assert.deepEqual(serializeError('plain'), { name: 'Error', message: 'plain' });
  assert.equal(serializeError(undefined), undefined);
});

test('per-platform app paths resolve for the current platform only', () => {
  const app = { path: { darwin: 'build/My.app', win32: 'build\\My.exe' }, isolatedUserData: true };
  assert.equal(resolveApp(app, '/proj', 'darwin')?.path, '/proj/build/My.app');
  assert.equal(resolveApp(app, '/proj', 'linux'), undefined);
  assert.equal(resolveApp({ path: '/abs/App.app' }, '/proj', 'darwin')?.path, '/abs/App.app');
  assert.equal(resolveApp(app, '/proj', 'darwin')?.isolatedUserData, true);
});

test('app paths expand ~, %VAR% and $VAR', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', HOME: '/Users/me', APPS: '/opt/apps' };
  assert.equal(expandPath('%LOCALAPPDATA%\\Programs\\Worktrace\\Worktrace.exe', env), 'C:\\Users\\me\\AppData\\Local\\Programs\\Worktrace\\Worktrace.exe');
  assert.equal(expandPath('%localappdata%\\X.exe', env), 'C:\\Users\\me\\AppData\\Local\\X.exe');
  assert.equal(expandPath('~/Applications/My.app', env), '/Users/me/Applications/My.app');
  assert.equal(expandPath('$APPS/My.app', env), '/opt/apps/My.app');
  assert.equal(expandPath('${APPS}/My.app', env), '/opt/apps/My.app');
  assert.equal(expandPath('build/~weird/My.app', env), 'build/~weird/My.app');
  assert.throws(() => expandPath('%NOPE%\\X.exe', env), /NOPE/);
  assert.equal(resolveApp({ path: { win32: '$APPS/My.exe' } }, '/proj', 'win32', env)?.path, '/opt/apps/My.exe');
});
