import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostHogServer } from '../../src/fakes/posthog.ts';

async function withServer(fn: (ph: PostHogServer) => Promise<void>, opts = {}): Promise<void> {
  const ph = await PostHogServer.start(opts);
  try {
    await fn(ph);
  } finally {
    await ph.close();
  }
}

const post = (url: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { 'Content-Type': 'application/json', ...headers } });

test('posthog-node batches: gzipped JSON under /batch/', async () => {
  await withServer(async (ph) => {
    const body = gzipSync(JSON.stringify({
      api_key: 'phc_test',
      batch: [
        { event: 'recording_started', distinct_id: 'u1', properties: { source: 'tray' }, uuid: 'a', timestamp: '2026-01-01T00:00:00Z' },
        { event: 'recording_paused', distinct_id: 'u1', properties: { minutes: 60 } },
      ],
    }));
    const res = await post(`${ph.url}/batch/`, body, { 'Content-Encoding': 'gzip' });
    assert.equal(res.status, 200);
    assert.deepEqual(ph.events.map((e) => e.event), ['recording_started', 'recording_paused']);
    const [first] = ph.events;
    assert.equal(first.distinctId, 'u1');
    assert.equal(first.apiKey, 'phc_test');
    assert.equal(first.path, '/batch/');
    assert.equal(first.uuid, 'a');
  });
});

test('a single plain event under /capture/, distinct_id inside properties', async () => {
  await withServer(async (ph) => {
    await post(`${ph.url}/capture/`, JSON.stringify({
      api_key: 'phc_test', event: 'app_launch_attempted', properties: { distinct_id: 'anon-1', beacon_stage: 'pre-init' },
    }));
    const e = await ph.waitForEvent({ event: 'app_launch_attempted', properties: { beacon_stage: 'pre-init' } }, { timeoutMs: 1000 });
    assert.equal(e.distinctId, 'anon-1');
  });
});

test('posthog-js bodies: gzip-js by query, and base64 in a form field', async () => {
  await withServer(async (ph) => {
    await post(`${ph.url}/e/?compression=gzip-js`, gzipSync(JSON.stringify([{ event: 'a', properties: {} }])), { 'Content-Type': 'text/plain' });
    const b64 = Buffer.from(JSON.stringify({ event: 'b', properties: { distinct_id: 'x' } })).toString('base64');
    await post(`${ph.url}/i/v0/e/?compression=base64`, `data=${encodeURIComponent(b64)}`, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.deepEqual(ph.events.map((e) => e.event), ['a', 'b']);
  });
});

test('an unreadable body is answered 200, recorded, and explained on timeout', async () => {
  await withServer(async (ph) => {
    const res = await post(`${ph.url}/batch/`, 'not json');
    assert.equal(res.status, 200);
    assert.match(ph.requests[0].error ?? '', /not JSON/);
    await assert.rejects(ph.waitForEvent('never', { timeoutMs: 200 }), /no analytics event matching 'never'[\s\S]*unreadable requests: POST \/batch\//);
  });
});

test('flags: configured values in both the /flags v2 and /decide shapes', async () => {
  await withServer(async (ph) => {
    const flags = await (await post(`${ph.url}/flags/?v=2`, '{}')).json();
    assert.equal(flags.flags.beta.enabled, true);
    assert.equal(flags.flags.theme.variant, 'dark');
    assert.equal(flags.featureFlags.beta, true);
    assert.equal(flags.errorsWhileComputingFlags, false);
    ph.setFlags({ beta: false });
    const decide = await (await post(`${ph.url}/decide/?v=4`, '{}')).json();
    assert.deepEqual(decide.featureFlags, { beta: false });
    assert.equal(decide.flags.beta.enabled, false);
    assert.equal(ph.events.length, 0, 'flag requests are not events');
  }, { flags: { beta: true, theme: 'dark' } });
});

test('a health probe and a CORS preflight both succeed', async () => {
  await withServer(async (ph) => {
    assert.equal((await fetch(`${ph.url}/`)).status, 200);
    const pre = await fetch(`${ph.url}/e/`, { method: 'OPTIONS', headers: { Origin: 'app://renderer', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'app://renderer');
  });
});

test('queries: name, pattern, properties by value or RegExp, and since', async () => {
  await withServer(async (ph) => {
    await post(`${ph.url}/batch/`, JSON.stringify({ batch: [
      { event: 'sign_in', distinct_id: 'u1', properties: { method: 'password', n: 1 } },
      { event: 'sign_out', distinct_id: 'u1', properties: {} },
    ] }));
    const mark = ph.cursor();
    await post(`${ph.url}/batch/`, JSON.stringify({ batch: [{ event: 'sign_in', distinct_id: 'u2', properties: { method: 'sso' } }] }));
    assert.equal(ph.find('sign_in').length, 2);
    assert.equal(ph.find(/^sign_/).length, 3);
    assert.equal(ph.find({ event: 'sign_in', properties: { method: /pass/ } }).length, 1);
    assert.equal(ph.find({ properties: { n: 1 } }).length, 1);
    assert.equal(ph.find('sign_in', { since: mark })[0].distinctId, 'u2');
    await ph.shouldNotHaveEvent('sign_out', { since: mark });
    await assert.rejects(ph.shouldNotHaveEvent('sign_out'), /expected no analytics event matching 'sign_out'/);
  });
});

test('events are appended to the log file as they arrive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dtf-posthog-'));
  try {
    const logFile = join(dir, 'events.jsonl');
    await withServer(async (ph) => {
      await post(`${ph.url}/capture/`, JSON.stringify({ event: 'one', properties: {} }));
      await post(`${ph.url}/capture/`, JSON.stringify({ event: 'two', properties: {} }));
    }, { logFile });
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ['one', 'two']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a port already in use fails with a reason', async () => {
  await withServer(async (ph) => {
    await assert.rejects(PostHogServer.start({ port: ph.port }), /already in use/);
  });
});
