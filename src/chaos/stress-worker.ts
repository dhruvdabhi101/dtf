/**
 * A resource hog, run as its own process so the test runner stays responsive
 * while the machine is starved.
 *
 *   node stress-worker.(ts|js) cpu <threads> <load 0..1> <ownerPid> <maxMs>
 *   node stress-worker.(ts|js) mem <targetUsedFraction> <minFreeMB> <ownerPid> <maxMs>
 *
 * Either mode exits on its own when its owner (the runner) is gone or `maxMs`
 * passes, so a crashed run cannot leave the machine pinned.
 */
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { freemem, totalmem } from 'node:os';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

if (!isMainThread) {
  // One busy thread: spin for `load` of every 100 ms slice, sleep the rest.
  // At full load it never yields: on Windows even setTimeout(0) sleeps up to a
  // timer tick (~15 ms), and the gaps added up to a machine well short of 100%.
  const load = (workerData as { load: number }).load;
  const slice = 100;
  if (load >= 1) {
    let x = 0;
    for (;;) x = (x + Math.sqrt(x + 1)) % 1e9;
  }
  const spin = () => {
    const start = Date.now();
    let x = 0;
    while (Date.now() - start < slice * load) x = (x + Math.sqrt(x + 1)) % 1e9;
    setTimeout(spin, slice * (1 - load));
  };
  spin();
} else {
  const [mode, a, b, owner, maxMs] = process.argv.slice(2);
  const ownerPid = Number(owner);
  const deadline = Date.now() + Number(maxMs || 600_000);
  setInterval(() => {
    if (Date.now() > deadline || (ownerPid && !alive(ownerPid))) process.exit(0);
  }, 1000);

  if (mode === 'cpu') {
    const threads = Math.max(1, Number(a));
    const load = Math.min(1, Math.max(0.01, Number(b)));
    for (let i = 0; i < threads; i++) new Worker(new URL(import.meta.url), { workerData: { load } });
  } else if (mode === 'mem') {
    // Allocate and touch memory until the machine's used fraction reaches the
    // target, never pushing free memory under `minFreeMB`. Re-checks every
    // 250 ms: gives memory back if something else starts using it, so the
    // target is a level, not a one-off allocation.
    const target = Math.min(0.99, Math.max(0.1, Number(a)));
    const minFree = Number(b) * 1048576;
    const CHUNK = 32 * 1048576;
    const held: Buffer[] = [];
    const adjust = () => {
      const total = totalmem();
      for (let i = 0; i < 16; i++) {
        const free = freemem();
        const used = (total - free) / total;
        if (used < target - 0.005 && free - CHUNK > minFree) {
          // fill() commits every page; a bare allocation may stay virtual.
          held.push(Buffer.allocUnsafe(CHUNK).fill(0xa5));
        } else if ((used > target + 0.02 || free < minFree) && held.length) {
          held.pop();
        } else break;
      }
      // Dropped buffers only return to the OS once collected.
      (globalThis as { gc?: () => void }).gc?.();
      if (process.send) process.send({ heldMB: held.length * 32 });
    };
    setInterval(adjust, 250);
    adjust();
  } else {
    console.error(`unknown mode ${mode}`);
    process.exit(2);
  }
}
