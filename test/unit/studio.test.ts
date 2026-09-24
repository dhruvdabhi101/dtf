import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

import { startStudio } from '../../src/studio/server.ts';

/**
 * The Studio API can write files and launch processes, so its guards are
 * tested directly: token, Host header, and path containment. None of these
 * endpoints touch the OS driver, so this runs on any platform.
 */

let dir: string;
let base: string;
let token: string;
let close: () => Promise<void>;

function get(path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(path, base);
    const req = request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dtf-studio-'));
  await mkdir(join(dir, 'tests'));
  await writeFile(join(dir, 'tests', 'a.spec.ts'), '// spec\n');
  await writeFile(join(dir, 'secret.txt'), 'nope');
  const s = await startStudio({ cwd: dir, port: 0, open: false });
  base = s.url;
  close = s.close;
  const page = await get('/');
  token = page.body.match(/name="dtf-token" content="([0-9a-f]+)"/)![1];
});

after(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

test('the page embeds a per-launch token', () => {
  assert.match(token, /^[0-9a-f]{48}$/);
});

test('API calls without the token are refused', async () => {
  assert.equal((await get('/api/project')).status, 401);
  assert.equal((await get('/api/project', { 'x-dtf-token': 'f'.repeat(48) })).status, 401);
  assert.equal((await get('/api/project', { 'x-dtf-token': token })).status, 200);
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const r = await get('/api/project', { 'x-dtf-token': token, host: 'evil.example:4417' });
  assert.equal(r.status, 403);
});

test('file reads are confined to the project', async () => {
  const ok = await get(`/api/file?path=tests/a.spec.ts`, { 'x-dtf-token': token });
  assert.equal(ok.status, 200);
  const escape = await get(`/api/file?path=${encodeURIComponent('../../etc/passwd')}`, { 'x-dtf-token': token });
  assert.equal(escape.status, 403);
});

test('file writes only accept test sources inside the project', async () => {
  const h = { 'x-dtf-token': token, 'content-type': 'application/json' };
  assert.equal((await get('/api/file', h, 'PUT', { path: 'tests/b.spec.ts', content: '// b' })).status, 200);
  assert.equal((await get('/api/file', h, 'PUT', { path: 'notes.txt', content: 'x' })).status, 400);
  assert.equal((await get('/api/file', h, 'PUT', { path: '../outside.spec.ts', content: 'x' })).status, 403);
});

test('artifacts are only served from the artifacts directory', async () => {
  const r = await get(`/artifacts?path=${encodeURIComponent(join(dir, 'secret.txt'))}&token=${token}`);
  assert.equal(r.status, 404);
});

test('static UI files cannot be used to traverse out of the UI folder', async () => {
  const r = await get('/ui/../../../package.json');
  assert.notEqual(r.status, 200);
});
