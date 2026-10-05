import { basename } from 'node:path';
import { existsSync } from 'node:fs';

import { describe, test, beforeEach, sleep, waitFor, type DesktopApp } from '../../../src/index.ts';
import { assertHealthy, setRecording, trayLatencyMs, worktraceDataDir } from '../lib.ts';

/**
 * Worktrace under failure. Each test injects one fault while the app records,
 * then checks the same invariants: the app is running (or came back), its
 * tray works, and it logged no unhandled error.
 *
 * Gates (decided when the file loads):
 *   --allow-destructive / DTF_CHAOS_DESTRUCTIVE=1   Wi-Fi off, memory and disk exhaustion
 *   DTF_CHAOS_ADMIN=1                               firewall block, OS-level shaping (admin terminal)
 *   DTF_SOAK=1                                      the long randomized runs
 *   DTF_CHAOS_SEED=<n> / --seed <n>                 replay a randomized run exactly
 */

const destructive = process.env.DTF_CHAOS_DESTRUCTIVE === '1';
const admin = process.env.DTF_CHAOS_ADMIN === '1';
const soak = process.env.DTF_SOAK === '1';
const when = (cond: boolean) => (cond ? test : test.skip);

const worktrace = (app: DesktopApp) => ({ label: 'Worktrace', pid: app.pid, name: basename(app.executable ?? 'Worktrace') });

/** Did the app open new connections after `since`? The sign that it noticed the network was back. */
async function trafficResumed(proxy: { totals(): { connections: number } } | null, since: number, timeoutMs = 120_000) {
  if (!proxy) return;
  await waitFor(async () => proxy.totals().connections > since || undefined, {
    timeoutMs, intervalMs: 2000, description: 'Worktrace to open a new connection after the network came back',
  });
}

describe('Worktrace chaos: processes', () => {
  beforeEach(async ({ app }) => {
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
    await setRecording(app, true);
  });

  test('survives its GPU process crashing', async ({ app, chaos }) => {
    const since = app.logCursor();
    const victims = await chaos.process.kill(app, { which: 'gpu', how: 'crash' }).catch(() => []);
    if (!victims.length) return; // no GPU process on this machine (software rendering)
    await sleep(10_000);
    await assertHealthy(app, { since });
  });

  test('survives a helper (utility/renderer) process crashing', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.process.kill(app, { which: 'random-child', how: 'crash' });
    await sleep(10_000);
    await assertHealthy(app, { since });
  });

  test('a sidecar crash is noticed and recovered', async ({ app, chaos }) => {
    const tree = await chaos.process.tree(app);
    if (!tree.some((p) => p.kind === 'sidecar')) return; // this build runs no sidecar
    const since = app.logCursor();
    await chaos.process.kill(app, { which: 'sidecar', how: 'crash' });
    // Worktrace should restart what it spawned; give it a minute.
    await waitFor(async () => (await chaos.process.tree(app)).some((p) => p.kind === 'sidecar') || undefined, {
      timeoutMs: 60_000, intervalMs: 2000, description: 'the sidecar to be restarted',
    });
    await assertHealthy(app, { since });
  });

  test('a main-process crash while recording: relaunch recovers with data intact', async ({ app, chaos }) => {
    await sleep(20_000); // let it write something first
    await chaos.process.kill(app, { which: 'main', how: 'crash' });
    await waitFor(async () => !(await app.isRunning()) || undefined, { timeoutMs: 10_000, description: 'the app to die' });
    const since = app.logCursor();
    await app.relaunch();
    await assertHealthy(app, { since, timeoutMs: 60_000 });
  });

  test('a 20 s hang (all processes frozen) and then it carries on', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.process.suspend(app, { which: 'tree' }), () => sleep(20_000));
    await sleep(5000);
    await assertHealthy(app, { since });
  });

  when(soak)('kill loop: 10 crashes at random moments, recovering each time', async ({ app, chaos, attach }) => {
    const log = await chaos.process.killLoop({
      target: () => app,
      iterations: 10,
      betweenMs: [5_000, 90_000],
      how: 'crash',
      recover: async () => {
        await waitFor(async () => !(await app.isRunning()) || undefined, { timeoutMs: 10_000, description: 'the app to die' });
        await app.relaunch();
        await app.tray.shouldExist({}, { timeoutMs: 60_000 });
        await setRecording(app, true);
      },
      check: async () => { await assertHealthy(app, { timeoutMs: 60_000 }); },
    });
    attach('kills', log.map((l) => `#${l.i} after ${l.afterMs}ms: ${l.victims.map((v) => v.kind).join(',')}`).join('\n'));
  }, { timeoutMs: 40 * 60_000 });
});

describe('Worktrace chaos: network', () => {
  beforeEach(async ({ app }) => {
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
    await setRecording(app, true);
  });

  test('offline for 2 minutes (app only), then back', async ({ app, chaos, proxy, perf }) => {
    const since = app.logCursor();
    const mon = await perf.monitor([worktrace(app)], { name: 'offline' });
    await perf.phase('offline', () => chaos.with(chaos.network.offline({ style: 'refuse' }), () => sleep(120_000)));
    const before = proxy?.totals().connections ?? 0;
    await perf.phase('recovery', () => trafficResumed(proxy, before));
    await mon.stop();
    await assertHealthy(app, { since });
  });

  test('connections that hang instead of failing (captive portal / dead gateway)', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.network.offline({ style: 'hang' }), async () => {
      await sleep(60_000);
      // Hung requests must not block the UI.
      const ms = await trayLatencyMs(app);
      if (ms > 5000) throw new Error(`tray menu took ${ms}ms to open while the network hung`);
    });
    await assertHealthy(app, { since });
  });

  test('extreme latency (3 s ± 1 s) for 2 minutes', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.network.profile('extreme-latency'), async () => {
      await sleep(60_000);
      const ms = await trayLatencyMs(app);
      if (ms > 5000) throw new Error(`tray menu took ${ms}ms to open under 3 s network latency`);
      await sleep(60_000);
    });
    await assertHealthy(app, { since });
  });

  test('slow 3G and a lossy link', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.network.profile('slow-3g'), () => sleep(60_000));
    await chaos.with(chaos.network.loss({ percent: 30 }), () => sleep(60_000));
    await assertHealthy(app, { since });
  });

  test('flapping network: 5 drops of 20 s', async ({ app, chaos, proxy }) => {
    const since = app.logCursor();
    await chaos.network.flap({ downMs: 20_000, upMs: 20_000, cycles: 5 });
    const before = proxy?.totals().connections ?? 0;
    await trafficResumed(proxy, before);
    await assertHealthy(app, { since });
  });

  test('its API host stops resolving', async ({ app, chaos, proxy }) => {
    // The busiest host the app has talked to so far stands in for "its API".
    await sleep(30_000);
    const hosts = Object.entries(proxy?.hosts() ?? {}).sort((a, b) => b[1].connections - a[1].connections).map(([h]) => h);
    if (!hosts.length) return; // no traffic seen through the proxy
    const since = app.logCursor();
    await chaos.with(chaos.network.dnsFail({ hosts: [hosts[0]] }), () => sleep(60_000));
    await assertHealthy(app, { since });
  });

  when(destructive)('real Wi-Fi disconnect (OS reports offline)', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.network.offline({ via: 'wifi' }), () => sleep(60_000));
    await sleep(20_000); // reconnect + DHCP
    await assertHealthy(app, { since });
  });

  when(admin)('firewall block of every Worktrace executable (traffic that ignores the proxy too)', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.network.offline({ via: 'firewall', target: app }), () => sleep(90_000));
    await assertHealthy(app, { since });
  });

  when(admin && destructive)('OS-level 1 s latency and 10% packet loss (all programs)', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.network.latency({ ms: 1000, via: 'os' }), () => sleep(60_000));
    await chaos.with(chaos.network.loss({ percent: 10, via: 'os' }), () => sleep(60_000));
    await assertHealthy(app, { since });
  });
});

describe('Worktrace chaos: CPU, memory, disk', () => {
  beforeEach(async ({ app }) => {
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
    await setRecording(app, true);
  });

  test('machine at 100% CPU (competing at normal priority) for 2 minutes', async ({ app, chaos, perf, attach }) => {
    const since = app.logCursor();
    const mon = await perf.monitor([worktrace(app)], { name: 'cpu-stress' });
    const latencies: number[] = [];
    await perf.phase('cpu-100', () => chaos.with(chaos.cpu.stress({ load: 1, priority: 'normal' }), async () => {
      for (let i = 0; i < 4; i++) { await sleep(25_000); latencies.push(await trayLatencyMs(app)); }
    }));
    await mon.stop();
    attach('tray latency at 100% CPU', `${latencies.join(', ')} ms`);
    if (Math.max(...latencies) > 10_000) throw new Error(`the tray took up to ${Math.max(...latencies)}ms to open at 100% CPU`);
    await assertHealthy(app, { since });
  });

  (process.platform === 'win32' ? test : test.skip)('Worktrace capped at 5% of the machine for 2 minutes', async ({ app, chaos, perf }) => {
    const since = app.logCursor();
    const mon = await perf.monitor([worktrace(app)], { name: 'cpu-cap' });
    await perf.phase('capped', () => chaos.with(chaos.cpu.cap(app, { percent: 5 }), () => sleep(120_000)));
    await perf.phase('uncapped', () => sleep(30_000));
    await mon.stop();
    await assertHealthy(app, { since });
  });

  (process.platform === 'win32' ? test : test.skip)('Worktrace limited to 400 MB of memory', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.memory.cap(app, { mb: 400 }), () => sleep(120_000));
    // Exceeding the limit may kill a helper; the app as a whole must survive or come back.
    if (!(await app.isRunning())) await app.relaunch();
    await assertHealthy(app, { since });
  });

  when(destructive)('machine memory held at 95% for 2 minutes', async ({ app, chaos, perf }) => {
    const since = app.logCursor();
    const mon = await perf.monitor([worktrace(app)], { name: 'memory-pressure' });
    await perf.phase('memory-95', () => chaos.with(chaos.memory.stress({ usedFraction: 0.95 }), () => sleep(120_000)));
    await mon.stop();
    await assertHealthy(app, { since });
  });

  when(destructive && existsSync(worktraceDataDir()))('disk full under its data directory for 2 minutes', async ({ app, chaos }) => {
    const since = app.logCursor();
    await chaos.with(chaos.disk.fill({ path: worktraceDataDir(), leaveMB: 20 }), () => sleep(120_000));
    await sleep(30_000); // space is back: recording should resume
    await assertHealthy(app, { since });
  });
});

describe('Worktrace chaos: randomized', () => {
  when(soak)('30 minutes of random faults', async ({ app, chaos, attach }) => {
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
    await setRecording(app, true);
    const since = app.logCursor();
    const result = await chaos.random({
      durationMs: 30 * 60_000,
      faults: {
        offline: () => chaos.network.offline(),
        hang: () => chaos.network.offline({ style: 'hang' }),
        latency: () => chaos.network.profile('extreme-latency'),
        lossy: () => chaos.network.loss({ percent: 20 }),
        cpu: () => chaos.cpu.stress({ load: 1 }),
        freeze: () => chaos.process.suspend(app, { which: 'tree' }),
        ...(process.platform === 'win32' ? { starve: () => chaos.cpu.cap(app, { percent: 3 }) } : {}),
      },
      gapMs: [10_000, 60_000],
      faultMs: [5_000, 60_000],
      invariant: async () => { await assertHealthy(app, { since, timeoutMs: 60_000 }); },
    });
    attach(`random faults (seed ${result.seed})`, result.events.map((e) => `${new Date(e.at).toISOString()} ${e.fault} for ${e.forMs}ms`).join('\n'));
  }, { timeoutMs: 45 * 60_000 });
});
