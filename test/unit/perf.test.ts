import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { percentile, dist, slope } from '../../src/perf/stats.ts';
import { PerfReport, type PerfData, type TargetPoint } from '../../src/perf/report.ts';
import { renderHtml } from '../../src/perf/html.ts';
import { resolveTarget } from '../../src/perf/monitor.ts';
import { parsePsTime, parseNettopRow, selectTrees } from '../../src/perf/sampler.ts';
import { Rng } from '../../src/core/random.ts';
import { NetworkProxy } from '../../src/net/proxy.ts';
import { Chaos } from '../../src/chaos/index.ts';
import { classify, pick, type ProcInfo } from '../../src/chaos/procs.ts';
import { listEntries, restoreStale, writeEntry } from '../../src/chaos/journal.ts';

test('percentile interpolates between ranks and handles edges', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10, 0, 20], 100), 20);
  const d = dist([1, 2, 3, NaN]);
  assert.equal(d.n, 3);
  assert.equal(d.mean, 2);
});

test('slope fits a line, not the endpoints', () => {
  assert.equal(slope([0, 1, 2, 3], [0, 2, 4, 6]), 2);
  // A spike at the end barely moves the fitted slope.
  const flat = slope([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 10, 10, 10, 10, 10, 10, 10, 10, 50]);
  assert.ok(flat < 3, `slope ${flat}`);
});

test('Rng replays the same sequence for a seed', () => {
  const a = new Rng(7), b = new Rng(7);
  const xs = Array.from({ length: 5 }, () => a.int(0, 1000));
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b.int(0, 1000)));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, () => new Rng(8).int(0, 1000)));
});

function fakeData(): PerfData {
  const t0 = 1_000_000;
  const pts: TargetPoint[] = [];
  for (let i = 1; i <= 120; i++) {
    pts.push({
      t: t0 + i * 1000, dtMs: 1000, cpu: i <= 60 ? 5 : 40, memMB: 200 + i * 0.5, wsMB: 150,
      ioReadBytes: 0, ioWriteBytes: 1048576, handles: 500 + i, threads: 30, procs: 4,
    });
  }
  return {
    name: 'fake', startedAt: t0, endedAt: t0 + 121_000, intervalMs: 1000, warmupMs: 0, cores: 8, platform: 'test',
    targets: ['App'],
    phases: [{ name: 'idle', start: t0, end: t0 + 60_500 }, { name: 'busy', start: t0 + 60_500, end: t0 + 121_000 }],
    events: [
      { at: t0 + 70_000, kind: 'fault-start', label: 'offline (proxy, refuse)' },
      { at: t0 + 80_000, kind: 'fault-end', label: 'offline (proxy, refuse)' },
    ],
    series: { App: pts },
    system: pts.map((p) => ({ t: p.t, dtMs: 1000, cpu: p.cpu / 8, memUsedMB: 8000, memTotalMB: 16000 })),
    proxy: pts.map((p) => ({ t: p.t, dtMs: 1000, upBytes: 100, downBytes: 900, connections: 0, errors: 0 })),
    proxyHosts: { 'api.example.com': { bytesUp: 12000, bytesDown: 108000, connections: 3, errors: 0 } },
  };
}

test('reports summarize per phase and check budgets', () => {
  const r = new PerfReport(fakeData());
  assert.equal(r.of('App').phase('idle').cpu.mean, 5);
  assert.equal(r.of('App').phase('busy').cpu.p95, 40);
  assert.equal(r.of().cpuMachine.max, 5);
  // 0.5 MB per second is 1800 MB per hour.
  assert.ok(Math.abs(r.of('App').memMB.slopePerHour - 1800) < 1);
  assert.equal(r.of('App').handles.growth, 119);
  // No per-process network here, so budgets fall back to the proxy: 1000 B/s.
  assert.equal(r.proxy('all')?.bytesPerMin, 60_000);

  assert.deepEqual(r.check({ phase: 'idle', cpuP95: 10 }), []);
  const v = r.check([{ phase: 'busy', cpuP95: 10 }, { memSlopeMBPerHour: 100 }, { netBytesPerMin: 1000 }]);
  assert.deepEqual(v.map((x) => x.metric), ['cpuP95', 'memSlopeMBPerHour', 'netBytesPerMin']);
  assert.throws(() => r.assertBudgets({ phase: 'busy', cpuMean: 1 }), /cpuMean: 40 > 1/);
  assert.throws(() => r.of('Nope'), /no perf target/);
  assert.match(r.table(), /App\s+busy\s+40\.0/);
});

test('baselines save on first use and flag regressions past the tolerance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dtf-baseline-'));
  try {
    const path = join(dir, 'base.json');
    const first = new PerfReport(fakeData());
    assert.deepEqual(first.compareBaseline(path), []);
    assert.ok(existsSync(path));

    const worse = fakeData();
    for (const p of worse.series.App) p.cpu *= 2;
    const regs = new PerfReport(worse).compareBaseline(path, { tolerance: 0.2 });
    assert.ok(regs.some((x) => x.metric === 'cpu.p95' && x.phase === 'busy'), JSON.stringify(regs));
    // Under the noise floor: 5% → 6% CPU is not a regression.
    const slightly = fakeData();
    for (const p of slightly.series.App) if (p.cpu === 5) p.cpu = 6;
    assert.deepEqual(new PerfReport(slightly).compareBaseline(path).filter((x) => x.phase === 'idle'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the HTML report is self-contained and shows phases and faults', () => {
  const data = fakeData();
  const html = renderHtml(data, new PerfReport(data).summary);
  assert.match(html, /<svg /);
  assert.match(html, /offline \(proxy, refuse\)/);
  assert.match(html, /api\.example\.com/);
  assert.doesNotMatch(html, /<script/);
});

test('targets resolve from apps, names and explicit specs', () => {
  const exe = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  assert.deepEqual(resolveTarget('chrome'), { label: 'chrome', pids: [], names: [exe] });
  assert.deepEqual(resolveTarget({ pid: 42, name: 'Worktrace', executable: '/x/Worktrace.exe' }), { label: 'Worktrace', pids: [42], names: ['Worktrace.exe'] });
  assert.deepEqual(resolveTarget({ label: 'svc', pid: 7 }), { label: 'svc', pids: [7], names: [] });
});

test('sampler parsing: ps times, nettop rows, process trees', () => {
  assert.equal(parsePsTime('0:01.50'), 1500);
  assert.equal(parsePsTime('1:02:03.00'), 3_723_000);
  assert.equal(parsePsTime('2-00:00:01.00'), 172_801_000);
  assert.deepEqual(parseNettopRow('12:00:00.1,Worktrace Helper.4242,1000,200,'), { pid: 4242, rx: 1000, tx: 200 });
  assert.equal(parseNettopRow('time,,bytes_in,bytes_out,'), undefined);

  const all = [
    { pid: 1, ppid: 0, name: 'init' },
    { pid: 10, ppid: 1, name: 'Worktrace.exe' },
    { pid: 11, ppid: 10, name: 'Worktrace.exe' },
    { pid: 12, ppid: 11, name: 'screenpipe.exe' },
    { pid: 20, ppid: 1, name: 'chrome.exe' },
  ];
  assert.deepEqual(selectTrees(all, { pids: [10], names: [] }).map((p) => p.pid), [10, 11, 12]);
  assert.deepEqual(selectTrees(all, { pids: [], names: ['CHROME.EXE'] }).map((p) => p.pid), [20]);
});

test('process classification follows Chromium --type switches', () => {
  assert.equal(classify('', true, 'App.exe', 'App.exe'), 'main');
  assert.equal(classify('App.exe --type=renderer --foo', false, 'App.exe', 'App.exe'), 'renderer');
  assert.equal(classify('App.exe --type=gpu-process', false, 'App.exe', 'App.exe'), 'gpu');
  assert.equal(classify('App.exe --type=utility --utility-sub-type=network.mojom.NetworkService', false, 'App.exe', 'App.exe'), 'utility');
  assert.equal(classify('screenpipe.exe --port 3030', false, 'App.exe', 'screenpipe.exe'), 'sidecar');

  const tree: ProcInfo[] = [
    { pid: 1, ppid: 0, name: 'a', kind: 'main', commandLine: '' },
    { pid: 2, ppid: 1, name: 'a', kind: 'renderer', commandLine: '' },
    { pid: 3, ppid: 1, name: 'a', kind: 'gpu', commandLine: '' },
  ];
  assert.deepEqual(pick(tree, 'renderer', new Rng(1)).map((p) => p.pid), [2]);
  assert.deepEqual(pick(tree, 'child', new Rng(1)).map((p) => p.pid), [2, 3]);
  assert.equal(pick(tree, 'random-child', new Rng(1)).length, 1);
  assert.deepEqual(pick(tree, 3, new Rng(1)).map((p) => p.pid), [3]);
});

test('the restore journal replays entries whose runner is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dtf-journal-'));
  const prev = process.env.DTF_CHAOS_JOURNAL;
  process.env.DTF_CHAOS_JOURNAL = join(dir, 'journal');
  try {
    const leftover = join(dir, 'fill.bin');
    await writeFile(leftover, 'x');
    // A pid that cannot be running.
    writeEntry({ id: 'dead', kind: 'disk-fill', description: 'dead run', createdAt: 1, deadline: 2, ownerPid: 2 ** 22 + 7, undo: [{ op: 'rm', path: leftover }] });
    writeEntry({ id: 'live', kind: 'disk-fill', description: 'live run', createdAt: 3, deadline: 4, ownerPid: process.pid, undo: [] });
    assert.equal(listEntries().length, 2);
    const done = await restoreStale();
    // This process's own entries are restored too: it is the one asking.
    assert.deepEqual(done.map((d) => d.entry.id).sort(), ['dead', 'live']);
    assert.ok(!existsSync(leftover));
    assert.equal(listEntries().length, 0);
  } finally {
    if (prev === undefined) delete process.env.DTF_CHAOS_JOURNAL; else process.env.DTF_CHAOS_JOURNAL = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('machine-wide faults refuse to run without allowDestructive', async () => {
  const prev = process.env.DTF_CHAOS_DESTRUCTIVE;
  delete process.env.DTF_CHAOS_DESTRUCTIVE;
  try {
    const chaos = new Chaos();
    await assert.rejects(chaos.memory.stress(), /allowDestructive/);
    await assert.rejects(chaos.disk.fill({ path: tmpdir() }), /allowDestructive/);
    await assert.rejects(chaos.network.offline({ via: 'wifi' }), /allowDestructive/);
    // Proxy faults need the proxy, and say how to turn it on.
    await assert.rejects(chaos.network.latency({ ms: 100 }), /networkProxy/);
  } finally {
    if (prev !== undefined) process.env.DTF_CHAOS_DESTRUCTIVE = prev;
  }
});

/** One GET through the proxy, as a proxied HTTP client sends it. */
function viaProxy(proxy: NetworkProxy, url: string): Promise<{ status: number; bytes: number; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const req = request({ host: '127.0.0.1', port: proxy.port, path: url }, (res) => {
      let n = 0;
      res.on('data', (d: Buffer) => { n += d.length; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: n, ms: Date.now() - t }));
    });
    req.on('error', () => resolve({ status: 0, bytes: -1, ms: Date.now() - t }));
    req.end();
  });
}

/** A CONNECT tunnel carrying a raw request, as HTTPS does (without the TLS). */
function viaTunnel(proxy: NetworkProxy, port: number): Promise<{ status: number; bytes: number; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const req = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${port}` });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode ?? 0, bytes: 0, ms: Date.now() - t }); return; }
      let n = 0;
      socket.on('data', (d: Buffer) => { n += d.length; });
      socket.on('close', () => resolve({ status: 200, bytes: n, ms: Date.now() - t }));
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    req.on('error', () => resolve({ status: 0, bytes: -1, ms: Date.now() - t }));
    req.end();
  });
}

test('the proxy counts traffic, and chaos faults shape it and restore cleanly', async () => {
  const body = Buffer.alloc(50 * 1024, 1);
  const origin = createServer((_req, res) => res.end(body));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
  const port = (origin.address() as { port: number }).port;
  const proxy = await new NetworkProxy().start();
  const chaos = new Chaos({ proxy });
  try {
    const plain = await viaProxy(proxy, `http://127.0.0.1:${port}/`);
    assert.equal(plain.bytes, body.length);

    await chaos.with(chaos.network.latency({ ms: 400 }), async () => {
      const slow = await viaTunnel(proxy, port);
      assert.ok(slow.bytes > body.length, 'the delayed tunnel still delivers everything');
      assert.ok(slow.ms >= 400, `latency applied: ${slow.ms}ms`);
    });

    await chaos.with(chaos.network.throttle({ downKbps: 800 }), async () => {
      // 50 KB at 800 kbit/s is about half a second.
      const t = await viaTunnel(proxy, port);
      assert.ok(t.ms >= 400, `throttled: ${t.ms}ms`);
    });

    const off = await chaos.network.offline();
    assert.equal((await viaProxy(proxy, `http://127.0.0.1:${port}/`)).status, 502);
    assert.equal((await viaTunnel(proxy, port)).status, 502);
    // Stacked faults come off independently.
    const lat = await chaos.network.latency({ ms: 50 });
    await off.restore();
    assert.deepEqual(proxy.conditions, { latencyMs: 50 });
    await lat.restore();
    assert.deepEqual(proxy.conditions, {});

    const back = await viaTunnel(proxy, port);
    assert.equal(back.status, 200);
    const stats = proxy.hosts()['127.0.0.1'];
    assert.ok(stats.bytesDown > body.length * 3);
    assert.equal(stats.errors, 2);
    assert.equal(chaos.timeline.events.filter((e) => e.kind === 'fault-start').length, 4);
  } finally {
    await chaos.restoreAll();
    await proxy.stop();
    origin.close();
  }
});

test('a budget naming a missing target or phase is an error, not a pass', () => {
  const r = new PerfReport(fakeData());
  assert.throws(() => r.check({ target: 'Worktrace', cpuMean: 1 }), /target 'Worktrace'/);
  assert.throws(() => r.check({ phase: 'browsing', cpuMean: 1 }), /phase 'browsing'/);
});
