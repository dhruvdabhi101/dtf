import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { NetworkProxy } from '../net/proxy.ts';
import { startSampler, type RawSample, type Sampler } from './sampler.ts';
import { PerfReport, type PerfData, type ProxyPoint, type SystemPoint, type TargetPoint } from './report.ts';
import { renderHtml } from './html.ts';
import type { Timeline } from './timeline.ts';

/**
 * What to measure. A `DesktopApp` covers its whole process tree (Electron's
 * renderer, GPU and utility helpers, and any sidecar it spawns). A string is
 * an executable name, e.g. `'chrome'`, matching every process tree it roots.
 */
export type PerfTarget =
  | { readonly pid: number; readonly name: string; readonly executable?: string | null }
  | string
  | { label: string; pid?: number; name?: string };

type Resolved = { label: string; pids: number[]; names: string[] };

const exeName = (n: string) => (process.platform === 'win32' && !/\.exe$/i.test(n) ? `${n}.exe` : n);

export function resolveTarget(t: PerfTarget): Resolved {
  if (typeof t === 'string') return { label: t, pids: [], names: [exeName(t)] };
  if ('label' in t) return { label: t.label, pids: t.pid ? [t.pid] : [], names: t.name ? [exeName(t.name)] : [] };
  // A DesktopApp. Its executable name also matches the app after a relaunch
  // gives it a new pid, which is what a crash-recovery test needs.
  const exe = t.executable ? basename(t.executable) : undefined;
  return { label: t.name || `pid ${t.pid}`, pids: [t.pid], names: exe ? [exe] : [] };
}

export type MonitorOptions = {
  intervalMs?: number;
  /** Excluded from the `all` phase: startup noise that is not the steady state. */
  warmupMs?: number;
  name?: string;
};

export class PerfMonitor {
  #targets: Resolved[];
  #intervalMs: number;
  #warmupMs: number;
  #name: string;
  #timeline: Timeline;
  #proxy: NetworkProxy | null;
  #outDir: string;
  #sampler: Sampler | null = null;
  #startedAt = 0;
  #cores = 1;
  #series: Record<string, TargetPoint[]> = {};
  #system: SystemPoint[] = [];
  #proxyPts: ProxyPoint[] = [];
  #prev: { t: number; sys: RawSample['sys']; procs: Map<number, RawSample['procs'][number]>; proxy?: ReturnType<NetworkProxy['totals']> } | null = null;
  #errors: string[] = [];
  #ndjson: WriteStream | null = null;
  #report: PerfReport | null = null;
  #eventsFrom = 0;

  constructor(targets: PerfTarget[], opts: MonitorOptions & { timeline: Timeline; proxy: NetworkProxy | null; outDir: string }) {
    if (targets.length === 0) throw new Error('perf.monitor needs at least one target');
    this.#targets = targets.map(resolveTarget);
    const seen = new Set<string>();
    for (const t of this.#targets) {
      let l = t.label;
      for (let i = 2; seen.has(l); i++) l = `${t.label} (${i})`;
      t.label = l;
      seen.add(l);
      this.#series[l] = [];
    }
    this.#intervalMs = opts.intervalMs ?? 1000;
    this.#warmupMs = opts.warmupMs ?? 0;
    this.#name = opts.name ?? 'perf';
    this.#timeline = opts.timeline;
    this.#proxy = opts.proxy;
    this.#outDir = opts.outDir;
  }

  get targets(): string[] { return this.#targets.map((t) => t.label); }
  get running(): boolean { return !!this.#sampler; }
  /** Problems the sampler reported (e.g. it could not start). Surfaced on stop too. */
  get errors(): readonly string[] { return this.#errors; }

  async start(): Promise<this> {
    await mkdir(this.#outDir, { recursive: true });
    this.#ndjson = createWriteStream(join(this.#outDir, 'samples.ndjson'));
    this.#startedAt = Date.now();
    this.#eventsFrom = this.#timeline.events.length;
    const all = { pids: this.#targets.flatMap((t) => t.pids), names: this.#targets.flatMap((t) => t.names) };
    let first!: () => void;
    const firstSample = new Promise<void>((r) => { first = r; });
    this.#sampler = startSampler(all, this.#intervalMs, (s) => { this.#onSample(s); first(); }, (msg) => { this.#errors.push(msg); first(); });
    // Wait for the first tick so a phase started right after this is measured.
    await Promise.race([firstSample, new Promise((r) => setTimeout(r, 15_000))]);
    if (!this.#prev && this.#errors.length) throw new Error(`perf sampler failed to start: ${this.#errors.join('; ')}`);
    return this;
  }

  /** Assigns each process to the first target whose tree it is in. */
  #labelOf(procs: RawSample['procs']): Map<number, string> {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out = new Map<number, string>();
    const rootOf = (pid: number): string | undefined => {
      const p = byPid.get(pid);
      if (!p) return undefined;
      return this.#targets.find((t) => t.pids.includes(p.pid) || t.names.some((n) => n.toLowerCase() === p.name.toLowerCase()))?.label;
    };
    for (const p of procs) {
      let cur: number | undefined = p.pid;
      const seen = new Set<number>();
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur);
        const label = rootOf(cur);
        if (label) { out.set(p.pid, label); break; }
        cur = byPid.get(cur)?.ppid;
      }
    }
    return out;
  }

  #onSample(s: RawSample) {
    this.#cores = s.cores;
    const procs = new Map(s.procs.map((p) => [p.pid, p]));
    const proxyNow = this.#proxy?.totals();
    const prev = this.#prev;
    this.#prev = { t: s.t, sys: s.sys, procs, proxy: proxyNow };
    if (!prev) return;
    const dt = Math.max(1, s.t - prev.t);

    const labels = this.#labelOf(s.procs);
    const acc = new Map<string, TargetPoint>();
    for (const label of this.targets) {
      acc.set(label, { t: s.t, dtMs: dt, cpu: 0, memMB: 0, wsMB: 0, ioReadBytes: 0, ioWriteBytes: 0, handles: 0, threads: 0, procs: 0 });
    }
    for (const p of s.procs) {
      const label = labels.get(p.pid);
      if (!label) continue;
      const a = acc.get(label)!;
      const was = prev.procs.get(p.pid);
      a.procs++;
      a.memMB += p.privBytes / 1048576;
      a.wsMB += p.wsBytes / 1048576;
      a.handles += p.handles ?? 0;
      a.threads += p.threads ?? 0;
      if (was) {
        a.cpu += Math.max(0, p.cpuMs - was.cpuMs) / dt * 100;
        a.ioReadBytes += Math.max(0, (p.ioReadBytes ?? 0) - (was.ioReadBytes ?? 0));
        a.ioWriteBytes += Math.max(0, (p.ioWriteBytes ?? 0) - (was.ioWriteBytes ?? 0));
        if (p.netRxBytes !== undefined) {
          a.netRxBytes = (a.netRxBytes ?? 0) + Math.max(0, p.netRxBytes - (was.netRxBytes ?? p.netRxBytes));
          a.netTxBytes = (a.netTxBytes ?? 0) + Math.max(0, (p.netTxBytes ?? 0) - (was.netTxBytes ?? p.netTxBytes ?? 0));
        }
      }
    }
    for (const [label, point] of acc) this.#series[label].push(point);

    const dBusy = s.sys.busyMs - prev.sys.busyMs;
    const dTotal = s.sys.totalMs - prev.sys.totalMs;
    const sys: SystemPoint = {
      t: s.t, dtMs: dt,
      cpu: dTotal > 0 ? Math.min(100, Math.max(0, (dBusy / dTotal) * 100)) : 0,
      memUsedMB: (s.sys.memTotal - s.sys.memAvail) / 1048576,
      memTotalMB: s.sys.memTotal / 1048576,
    };
    if (s.sys.netRx !== undefined && prev.sys.netRx !== undefined) {
      sys.netRxBytes = Math.max(0, s.sys.netRx - prev.sys.netRx);
      sys.netTxBytes = Math.max(0, (s.sys.netTx ?? 0) - (prev.sys.netTx ?? 0));
    }
    this.#system.push(sys);

    let proxyPt: ProxyPoint | undefined;
    if (proxyNow && prev.proxy) {
      proxyPt = {
        t: s.t, dtMs: dt,
        upBytes: proxyNow.bytesUp - prev.proxy.bytesUp,
        downBytes: proxyNow.bytesDown - prev.proxy.bytesDown,
        connections: proxyNow.connections - prev.proxy.connections,
        errors: proxyNow.errors - prev.proxy.errors,
      };
      this.#proxyPts.push(proxyPt);
    }

    this.#ndjson?.write(JSON.stringify({ t: s.t, targets: Object.fromEntries(acc), system: sys, proxy: proxyPt }) + '\n');
  }

  /** Stops sampling and writes `samples.ndjson`, `summary.json` and `report.html`. Idempotent. */
  async stop(): Promise<PerfReport> {
    if (this.#report) return this.#report;
    await this.#sampler?.stop();
    this.#sampler = null;
    const endedAt = Date.now();
    await new Promise<void>((r) => (this.#ndjson ? this.#ndjson.end(() => r()) : r()));

    const events = this.#timeline.events.slice(this.#eventsFrom).filter((e) => e.at <= endedAt);
    const phases: PerfData['phases'] = [];
    const open = new Map<string, number>();
    for (const e of events) {
      if (e.kind === 'phase-start') open.set(e.label, e.at);
      if (e.kind === 'phase-end' && open.has(e.label)) { phases.push({ name: e.label, start: open.get(e.label)!, end: e.at }); open.delete(e.label); }
    }
    for (const [name, start] of open) phases.push({ name, start, end: endedAt });

    const data: PerfData = {
      name: this.#name,
      startedAt: this.#startedAt,
      endedAt,
      intervalMs: this.#intervalMs,
      warmupMs: this.#warmupMs,
      cores: this.#cores,
      platform: `${process.platform}/${process.arch}`,
      targets: this.targets,
      phases,
      events,
      series: this.#series,
      system: this.#system,
      proxy: this.#proxy ? this.#proxyPts : null,
      proxyHosts: this.#proxy ? this.#proxy.hosts() : null,
    };
    const report = new PerfReport(data);
    const summaryPath = join(this.#outDir, 'summary.json');
    const htmlPath = join(this.#outDir, 'report.html');
    await writeFile(summaryPath, JSON.stringify({ ...report.summary, errors: this.#errors }, null, 2));
    await writeFile(join(this.#outDir, 'data.json'), JSON.stringify(data));
    await writeFile(htmlPath, renderHtml(data, report.summary));
    report.files = { samples: join(this.#outDir, 'samples.ndjson'), summary: summaryPath, html: htmlPath };
    this.#report = report;
    return report;
  }
}
