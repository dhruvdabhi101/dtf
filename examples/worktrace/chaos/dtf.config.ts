import { defineConfig } from '../../../src/index.ts';
import base from '../dtf.config.ts';
import { clearStaleInstanceLock } from '../lib.ts';

/**
 * Worktrace chaos suite: crashes, hangs, network loss and latency, CPU and
 * memory starvation, a full disk.
 *
 *   node src/cli.ts run examples/worktrace/chaos
 *   node src/cli.ts run examples/worktrace/chaos --allow-destructive   # + Wi-Fi, memory, disk
 *
 * Tests that need an administrator terminal (firewall, adapter, OS-level
 * shaping) run only with DTF_CHAOS_ADMIN=1. Every fault is undone when its
 * test ends, and by a watchdog if the run dies; `dtf chaos status` shows
 * anything outstanding.
 *
 * This runs against the real signed-in profile (recording needs it), so the
 * crash tests really do kill Worktrace mid-write. That is the point, but do
 * not run it on a profile whose data you need.
 */
export default defineConfig({
  ...base,
  networkProxy: true,
  // Tests kill and starve the app: give each a fresh launch.
  lifecycle: 'per-test',
  retries: 0,
  timeoutMs: 10 * 60_000,
  beforeLaunch: clearStaleInstanceLock,
  perf: { intervalMs: 1000 },
  chaos: {
    allowDestructive: process.env.DTF_CHAOS_DESTRUCTIVE === '1',
    maxFaultMs: 15 * 60_000,
  },
});
