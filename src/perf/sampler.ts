import { spawn, type ChildProcess } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

import { spawnPowershell, sh } from '../core/shell.ts';
import { WIN32_PRELUDE } from '../core/win32.ts';

/**
 * Raw process and system counters, one snapshot per tick.
 *
 * Counters are cumulative (CPU time, I/O bytes, network bytes); the monitor
 * turns them into rates from the deltas between ticks. Sampling runs outside
 * the test runner's event loop (a PowerShell/C# loop on Windows, `ps` and
 * `nettop` on macOS) so a busy test does not skew its own measurements.
 */
export type RawProc = {
  pid: number;
  ppid: number;
  name: string;
  /** Cumulative CPU time, user + kernel. */
  cpuMs: number;
  /** Private (committed) bytes on Windows; resident size on macOS. */
  privBytes: number;
  /** Working set / resident size. */
  wsBytes: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
  handles?: number;
  threads?: number;
  /** Cumulative network bytes, where the OS reports them per process (macOS). */
  netRxBytes?: number;
  netTxBytes?: number;
};

export type RawSample = {
  t: number;
  cores: number;
  sys: { busyMs: number; totalMs: number; memTotal: number; memAvail: number; netRx?: number; netTx?: number };
  procs: RawProc[];
};

export type SamplerTarget = { pids: number[]; names: string[] };

export interface Sampler {
  stop(): Promise<void>;
}

export function startSampler(targets: SamplerTarget, intervalMs: number, onSample: (s: RawSample) => void, onError: (msg: string) => void): Sampler {
  if (process.platform === 'win32') return windowsSampler(targets, intervalMs, onSample, onError);
  if (process.platform === 'darwin') return macSampler(targets, intervalMs, onSample, onError);
  throw new Error(`perf sampling is not implemented on ${process.platform}`);
}

// ── Windows ────────────────────────────────────────────────────────────────

function windowsSampler(targets: SamplerTarget, intervalMs: number, onSample: (s: RawSample) => void, onError: (msg: string) => void): Sampler {
  const arr = (xs: (string | number)[]) => `@(${xs.map((x) => (typeof x === 'number' ? String(x) : `'${x.replace(/'/g, "''")}'`)).join(',')})`;
  const script = `${WIN32_PRELUDE}
[DtfNative]::Sample([int[]]${arr(targets.pids)}, [string[]]${arr(targets.names)}, ${Math.max(100, intervalMs)}, ${process.pid})
`;
  const child = spawnPowershell(script);
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  child.on('exit', (code) => { if (code && !stopped) onError(`the sampler exited with code ${code}: ${stderr.trim().slice(0, 500)}`); });
  let stopped = false;
  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (!line.startsWith('{')) return;
    try {
      const j = JSON.parse(line) as { t: number; cores: number; sys: number[]; p: (number | string)[][] };
      const [idle, kern, user, memTotal, memAvail, rx, tx] = j.sys;
      onSample({
        t: j.t,
        cores: j.cores,
        // GetSystemTimes' kernel time includes idle time.
        sys: { busyMs: (kern + user - idle) / 10_000, totalMs: (kern + user) / 10_000, memTotal, memAvail, netRx: rx, netTx: tx },
        procs: j.p.filter((p) => (p[3] as number) >= 0).map((p) => ({
          pid: p[0] as number, ppid: p[1] as number, name: p[2] as string,
          cpuMs: (p[3] as number) / 10_000, privBytes: p[4] as number, wsBytes: p[5] as number,
          ioReadBytes: p[6] as number, ioWriteBytes: p[7] as number, handles: p[8] as number, threads: p[9] as number,
        })),
      });
    } catch (err) {
      onError(`unreadable sample: ${(err as Error).message}`);
    }
  });
  return { stop: () => killChild(child, () => { stopped = true; }) };
}

function killChild(child: ChildProcess, before: () => void): Promise<void> {
  before();
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000).unref();
  });
}

// ── macOS ──────────────────────────────────────────────────────────────────

/** `ps` TIME: `[[dd-]hh:]mm:ss.cc`. */
export function parsePsTime(s: string): number {
  const [dayPart, rest] = s.includes('-') ? s.split('-') : ['0', s];
  const parts = rest.split(':').map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return (Number(dayPart) * 86400 + secs) * 1000;
}

/** One `nettop -P -L 0 -x -J bytes_in,bytes_out` row: `time,name.pid,in,out,`. */
export function parseNettopRow(line: string): { pid: number; rx: number; tx: number } | undefined {
  const cols = line.split(',');
  if (cols.length < 4 || cols[0] === 'time') return undefined;
  const m = cols[1].match(/\.(\d+)$/);
  if (!m) return undefined;
  const rx = Number(cols[2]);
  const tx = Number(cols[3]);
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return undefined;
  return { pid: Number(m[1]), rx, tx };
}

function cpuTotals(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

/** Every process in the trees rooted at a target pid or name, as the Windows sampler selects them. */
export function selectTrees<T extends { pid: number; ppid: number; name: string }>(all: T[], targets: SamplerTarget): T[] {
  const names = new Set(targets.names.map((n) => n.toLowerCase()));
  const inSet = new Set<number>();
  for (const p of all) if (targets.pids.includes(p.pid) || names.has(p.name.toLowerCase())) inSet.add(p.pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) {
      if (!inSet.has(p.pid) && p.ppid !== 0 && p.ppid !== p.pid && inSet.has(p.ppid)) { inSet.add(p.pid); grew = true; }
    }
  }
  return all.filter((p) => inSet.has(p.pid));
}

function macSampler(targets: SamplerTarget, intervalMs: number, onSample: (s: RawSample) => void, onError: (msg: string) => void): Sampler {
  const net = new Map<number, { rx: number; tx: number }>();
  // Per-process network counters. Best effort: nettop needs no root, but its
  // output format is not a stable interface.
  let nettop: ChildProcess | undefined;
  try {
    nettop = spawn('/usr/bin/nettop', ['-P', '-L', '0', '-x', '-s', String(Math.max(1, Math.round(intervalMs / 1000))), '-J', 'bytes_in,bytes_out'], { stdio: ['ignore', 'pipe', 'ignore'] });
    nettop.on('error', () => { nettop = undefined; });
    createInterface({ input: nettop.stdout! }).on('line', (line) => {
      const row = parseNettopRow(line);
      if (row) net.set(row.pid, { rx: row.rx, tx: row.tx });
    });
  } catch { nettop = undefined; }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now();
    const r = await sh('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { timeoutMs: 10_000 });
    if (!r.ok) onError(`ps failed: ${r.stderr}`);
    const all: RawProc[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const rss = Number(m[3]) * 1024;
      const n = net.get(pid);
      all.push({
        pid, ppid: Number(m[2]), name: basename(m[5]), cpuMs: parsePsTime(m[4]), privBytes: rss, wsBytes: rss,
        netRxBytes: n?.rx, netTxBytes: n?.tx,
      });
    }
    const c = cpuTotals();
    const cores = cpus().length;
    onSample({
      t: t0, cores,
      sys: { busyMs: c.busy, totalMs: c.total, memTotal: totalmem(), memAvail: freemem() },
      procs: selectTrees(all, targets),
    });
    if (!stopped) timer = setTimeout(tick, Math.max(0, intervalMs - (Date.now() - t0)));
  };
  void tick();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      nettop?.kill();
    },
  };
}
