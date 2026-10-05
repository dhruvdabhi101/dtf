import { defineConfig } from '../../../src/index.ts';
import base from '../dtf.config.ts';
import { clearStaleInstanceLock } from '../lib.ts';

/**
 * Worktrace performance suite: what the app costs while it records in the
 * background and someone uses the machine normally.
 *
 *   node src/cli.ts run examples/worktrace/perf
 *
 * Long-running by design (minutes per test). Shorten with DTF_PERF_MINUTES.
 * Reports land in dtf-artifacts/perf/<test>/…/report.html.
 */
export default defineConfig({
  ...base,
  // Launch Worktrace through dtf's proxy: per-host traffic figures, with no
  // admin rights needed.
  networkProxy: true,
  lifecycle: 'per-file',
  retries: 0,
  // Perf tests set their own (long) timeouts; this covers the rest.
  timeoutMs: 5 * 60_000,
  beforeLaunch: clearStaleInstanceLock,
  perf: {
    intervalMs: 1000,
    warmupMs: 30_000,
    // Starting points, not truths: tune them to your first baseline run.
    budgets: [
      { target: 'Worktrace', phase: 'browsing', cpuMean: 25, cpuP95: 80, memSlopeMBPerHour: 150 },
      { target: 'Worktrace', phase: 'idle', cpuMean: 10 },
    ],
  },
});
