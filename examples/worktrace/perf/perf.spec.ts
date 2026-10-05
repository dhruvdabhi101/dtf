import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { describe, test, beforeAll, sleep, type DesktopApp } from '../../../src/index.ts';
import { isRecording, minutes, setRecording, trayLatencyMs } from '../lib.ts';

/**
 * Worktrace performance: the app recording in the background while a scripted
 * "normal user" browses in a real Chrome.
 *
 * Every test writes an HTML report (CPU, memory, disk, handles and the app's
 * network traffic per host, over time, with phases shaded) and attaches its
 * summary table to the test result.
 *
 * Environment:
 *   DTF_PERF_MINUTES   length of the browsing phase (default 10)
 *   DTF_SOAK=1         also run the 60-minute leak soak
 *   DTF_SOAK_MINUTES   its length (default 60)
 */

const BASELINES = join(import.meta.dirname, 'baselines');
mkdirSync(BASELINES, { recursive: true });

/** Worktrace under a fixed label, so budgets and baselines name it the same on every machine. */
const worktrace = (app: DesktopApp) => ({ label: 'Worktrace', pid: app.pid, name: basename(app.executable ?? 'Worktrace') });

describe('Worktrace performance', () => {
  beforeAll(async ({ app }) => {
    await app.tray.shouldExist({}, { timeoutMs: 30_000 });
  });

  const browseMs = minutes(process.env.DTF_PERF_MINUTES, 10);

  test('recording in the background while the user browses', async ({ app, perf, attach }) => {
    const browser = await perf.openBrowser();
    const mon = await perf.monitor([worktrace(app), { label: 'Browser', pid: browser.app.pid }], { name: 'recording-while-browsing' });

    await setRecording(app, false);
    await perf.idle('idle', 60_000);

    await setRecording(app, true);
    await perf.phase('recording-idle', () => sleep(60_000));

    const trayMs: number[] = [];
    await perf.phase('browsing', async () => {
      await browser.run({ preset: 'browse-news', durationMs: browseMs, seed: 42 });
      trayMs.push(await trayLatencyMs(app));
    });
    const report = await mon.stop();

    attach('tray latency while recording', `${trayMs.join(', ')} ms`);
    attach('network by host', JSON.stringify(report.data.proxyHosts, null, 2));

    // The config's budgets (dtf.config.ts → perf.budgets), then the saved
    // baseline for this platform: the first run writes it, later runs fail
    // on a >20% regression.
    perf.assertBudgets(report);
    report.assertNoRegression(join(BASELINES, `${process.platform}-browsing.json`), { tolerance: 0.2 });
  }, { timeoutMs: 3 * 60_000 + minutes(process.env.DTF_PERF_MINUTES, 10) + 5 * 60_000 });

  test('what recording costs: A/B with recording on vs off', async ({ app, perf, attach }) => {
    const browser = await perf.openBrowser();
    const wasOn = await isRecording(app);
    try {
      const result = await perf.ab({
        targets: [worktrace(app), { label: 'Browser', pid: browser.app.pid }],
        variants: {
          'recording-on': { setup: () => setRecording(app, true) },
          'recording-off': { setup: () => setRecording(app, false) },
        },
        // Same seed every round: identical pages, pauses and scrolls.
        run: () => browser.run({ preset: 'browse-news', durationMs: 3 * 60_000, seed: 7 }),
        repeat: 2,
        settleMs: 10_000,
      });
      attach('A/B', result.table());

      const cost = result.delta('recording-on', 'recording-off', 'Worktrace');
      const browserCost = result.delta('recording-on', 'recording-off', 'Browser');
      attach('cost of recording', JSON.stringify({ worktrace: cost, browser: browserCost }, null, 2));

      // Recording should not slow down the user's own work noticeably.
      if (browserCost.cpuMean > 15) {
        throw new Error(`the browser used ${browserCost.cpuMean} more % CPU while Worktrace recorded\n${result.table()}`);
      }
    } finally {
      await setRecording(app, wasOn).catch(() => {});
    }
  }, { timeoutMs: 40 * 60_000 });

  test('video playback while recording', async ({ app, perf }) => {
    const browser = await perf.openBrowser();
    await setRecording(app, true);
    const mon = await perf.monitor([worktrace(app), { label: 'Browser', pid: browser.app.pid }], { name: 'video' });
    await perf.phase('video', () => browser.run({ preset: 'video', durationMs: 5 * 60_000 }));
    const report = await mon.stop();
    // A full-screen-changing video is the capture pipeline's worst case.
    report.assertBudgets({ target: 'Worktrace', phase: 'video', cpuMean: 60, memSlopeMBPerHour: 300 });
  }, { timeoutMs: 10 * 60_000 });

  (process.env.DTF_SOAK === '1' ? test : test.skip)('leak soak: an hour of recording while reading docs', async ({ app, perf }) => {
    const browser = await perf.openBrowser();
    await setRecording(app, true);
    const mon = await perf.monitor([worktrace(app)], { name: 'soak', intervalMs: 5000, warmupMs: 5 * 60_000 });
    await perf.phase('soak', () => browser.run({ preset: 'docs-reading', durationMs: minutes(process.env.DTF_SOAK_MINUTES, 60), seed: 3 }));
    const report = await mon.stop();
    const s = report.of('Worktrace').phase('soak');
    if (s.memMB.slopePerHour > 50) throw new Error(`memory grows ${s.memMB.slopePerHour.toFixed(0)} MB/hour (${s.memMB.start.toFixed(0)} → ${s.memMB.end.toFixed(0)} MB). Report: ${report.files.html}`);
    if (s.handles.slopePerHour > 500) throw new Error(`handles grow ${s.handles.slopePerHour.toFixed(0)}/hour. Report: ${report.files.html}`);
  }, { timeoutMs: minutes(process.env.DTF_SOAK_MINUTES, 60) + 10 * 60_000 });
});
