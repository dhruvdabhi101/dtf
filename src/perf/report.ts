import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { AssertionError } from '../core/errors.ts';
import { dist, round, slope, type Dist } from './stats.ts';
import type { TimelineEvent } from './timeline.ts';

/**
 * A finished perf recording: the processed series, per-phase statistics, and
 * the checks tests make against them (budgets, a saved baseline).
 */

/** One target (an app and its process tree) at one tick. */
export type TargetPoint = {
  t: number;
  dtMs: number;
  /** CPU as a percentage of one core: 200 means two cores fully busy. */
  cpu: number;
  memMB: number;
  wsMB: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  handles: number;
  threads: number;
  procs: number;
  /** Network bytes this interval, where the OS reports them per process (macOS). */
  netRxBytes?: number;
  netTxBytes?: number;
};

export type SystemPoint = { t: number; dtMs: number; cpu: number; memUsedMB: number; memTotalMB: number; netRxBytes?: number; netTxBytes?: number };

/** Traffic through dtf's proxy this interval: the app's own traffic, by host. */
export type ProxyPoint = { t: number; dtMs: number; upBytes: number; downBytes: number; connections: number; errors: number };

export type PerfData = {
  name: string;
  startedAt: number;
  endedAt: number;
  intervalMs: number;
  warmupMs: number;
  cores: number;
  platform: string;
  targets: string[];
  phases: { name: string; start: number; end: number }[];
  events: TimelineEvent[];
  series: Record<string, TargetPoint[]>;
  system: SystemPoint[];
  proxy: ProxyPoint[] | null;
  proxyHosts: Record<string, { bytesUp: number; bytesDown: number; connections: number; errors: number }> | null;
};

export type GrowthStats = Dist & { start: number; end: number; growth: number; slopePerHour: number };

export type TargetPhaseStats = {
  durationMs: number;
  samples: number;
  /** % of one core. */
  cpu: Dist;
  /** % of the whole machine (cpu / cores). */
  cpuMachine: Dist;
  memMB: GrowthStats;
  wsMB: Dist;
  ioReadMBps: Dist;
  ioWriteMBps: Dist;
  handles: GrowthStats;
  threads: GrowthStats;
  procsMax: number;
  net?: NetStats;
};

export type NetStats = { rxBytes: number; txBytes: number; bytesPerMin: number };

export type SystemPhaseStats = { cpu: Dist; memUsedMB: Dist; net?: NetStats };
export type ProxyPhaseStats = NetStats & { connections: number; errors: number };

export type PerfSummary = {
  name: string;
  platform: string;
  cores: number;
  startedAt: number;
  durationMs: number;
  phases: string[];
  targets: Record<string, Record<string, TargetPhaseStats>>;
  system: Record<string, SystemPhaseStats>;
  proxy: Record<string, ProxyPhaseStats> | null;
  proxyHosts: PerfData['proxyHosts'];
};

export type Budget = {
  /** A target label; every target when omitted. */
  target?: string;
  /** A phase name; `all` (the whole recording after warm-up) when omitted. */
  phase?: string;
  cpuMean?: number;
  cpuP95?: number;
  cpuMax?: number;
  memMaxMB?: number;
  memGrowthMB?: number;
  memSlopeMBPerHour?: number;
  handlesGrowth?: number;
  threadsGrowth?: number;
  ioWriteMBpsMean?: number;
  /** Per-process network where the OS reports it, else the app's traffic through dtf's proxy. */
  netBytesPerMin?: number;
  systemCpuMean?: number;
};

export type BudgetViolation = { target: string; phase: string; metric: string; limit: number; actual: number };

export type BaselineOptions = {
  /** Allowed relative increase, 0.2 = 20% worse. */
  tolerance?: number;
  /** Absolute slack under which a change is noise, per metric. */
  floors?: Partial<Record<BaselineMetric, number>>;
};

export type BaselineMetric = 'cpu.mean' | 'cpu.p95' | 'memMB.max' | 'memMB.slopePerHour' | 'net.bytesPerMin';
export type Regression = { target: string; phase: string; metric: BaselineMetric; baseline: number; current: number; change: string };

const DEFAULT_FLOORS: Record<BaselineMetric, number> = {
  'cpu.mean': 2, 'cpu.p95': 5, 'memMB.max': 25, 'memMB.slopePerHour': 20, 'net.bytesPerMin': 50_000,
};

function growth(ts: number[], vs: number[]): GrowthStats {
  const d = dist(vs);
  const start = vs[0] ?? 0;
  const end = vs[vs.length - 1] ?? 0;
  const hours = ts.map((t) => t / 3_600_000);
  return { ...d, start, end, growth: end - start, slopePerHour: slope(hours, vs) };
}

function netStats(points: { dtMs: number; netRxBytes?: number; netTxBytes?: number }[]): NetStats | undefined {
  if (!points.some((p) => p.netRxBytes !== undefined)) return undefined;
  const rx = points.reduce((a, p) => a + (p.netRxBytes ?? 0), 0);
  const tx = points.reduce((a, p) => a + (p.netTxBytes ?? 0), 0);
  const ms = points.reduce((a, p) => a + p.dtMs, 0);
  return { rxBytes: rx, txBytes: tx, bytesPerMin: ms ? ((rx + tx) / ms) * 60_000 : 0 };
}

export function summarize(data: PerfData): PerfSummary {
  const windows = [{ name: 'all', start: data.startedAt + data.warmupMs, end: data.endedAt }, ...data.phases];
  const inWin = <T extends { t: number }>(pts: T[], w: { start: number; end: number }) => pts.filter((p) => p.t >= w.start && p.t <= w.end);

  const targets: PerfSummary['targets'] = {};
  for (const label of data.targets) {
    targets[label] = {};
    for (const w of windows) {
      const pts = inWin(data.series[label] ?? [], w);
      const secs = (p: TargetPoint) => Math.max(p.dtMs, 1) / 1000;
      targets[label][w.name] = {
        durationMs: w.end - w.start,
        samples: pts.length,
        cpu: dist(pts.map((p) => p.cpu)),
        cpuMachine: dist(pts.map((p) => p.cpu / data.cores)),
        memMB: growth(pts.map((p) => p.t), pts.map((p) => p.memMB)),
        wsMB: dist(pts.map((p) => p.wsMB)),
        ioReadMBps: dist(pts.map((p) => p.ioReadBytes / 1048576 / secs(p))),
        ioWriteMBps: dist(pts.map((p) => p.ioWriteBytes / 1048576 / secs(p))),
        handles: growth(pts.map((p) => p.t), pts.map((p) => p.handles)),
        threads: growth(pts.map((p) => p.t), pts.map((p) => p.threads)),
        procsMax: Math.max(0, ...pts.map((p) => p.procs)),
        net: netStats(pts),
      };
    }
  }

  const system: PerfSummary['system'] = {};
  const proxy: PerfSummary['proxy'] = data.proxy ? {} : null;
  for (const w of windows) {
    const pts = inWin(data.system, w);
    system[w.name] = { cpu: dist(pts.map((p) => p.cpu)), memUsedMB: dist(pts.map((p) => p.memUsedMB)), net: netStats(pts) };
    if (data.proxy && proxy) {
      const pp = inWin(data.proxy, w);
      const up = pp.reduce((a, p) => a + p.upBytes, 0);
      const down = pp.reduce((a, p) => a + p.downBytes, 0);
      const ms = pp.reduce((a, p) => a + p.dtMs, 0);
      proxy[w.name] = {
        rxBytes: down, txBytes: up, bytesPerMin: ms ? ((up + down) / ms) * 60_000 : 0,
        connections: pp.reduce((a, p) => a + p.connections, 0), errors: pp.reduce((a, p) => a + p.errors, 0),
      };
    }
  }

  return {
    name: data.name, platform: data.platform, cores: data.cores, startedAt: data.startedAt,
    durationMs: data.endedAt - data.startedAt, phases: windows.map((w) => w.name),
    targets, system, proxy, proxyHosts: data.proxyHosts,
  };
}

/** Reads one metric off a phase's stats, for budgets and baselines. */
function metric(s: TargetPhaseStats, proxy: ProxyPhaseStats | undefined, key: string): number | undefined {
  switch (key) {
    case 'cpu.mean': case 'cpuMean': return s.cpu.mean;
    case 'cpu.p95': case 'cpuP95': return s.cpu.p95;
    case 'cpuMax': return s.cpu.max;
    case 'memMB.max': case 'memMaxMB': return s.memMB.max;
    case 'memGrowthMB': return s.memMB.growth;
    case 'memMB.slopePerHour': case 'memSlopeMBPerHour': return s.memMB.slopePerHour;
    case 'handlesGrowth': return s.handles.growth;
    case 'threadsGrowth': return s.threads.growth;
    case 'ioWriteMBpsMean': return s.ioWriteMBps.mean;
    case 'net.bytesPerMin': case 'netBytesPerMin': return (s.net ?? proxy)?.bytesPerMin;
    default: return undefined;
  }
}

export class PerfReport {
  readonly data: PerfData;
  readonly summary: PerfSummary;
  /** Where the artifacts were written, when they were. */
  files: { samples?: string; summary?: string; html?: string } = {};

  constructor(data: PerfData) {
    this.data = data;
    this.summary = summarize(data);
  }

  /** Stats for one target, by label (the app's name, or what you passed). Defaults to the first target. */
  of(target?: string | { name: string }): { phase(name?: string): TargetPhaseStats } & TargetPhaseStats {
    const label = typeof target === 'string' ? target : target?.name ?? this.data.targets[0];
    const phases = this.summary.targets[label];
    if (!phases) throw new Error(`no perf target '${label}'; targets are ${JSON.stringify(this.data.targets)}`);
    const phase = (name = 'all') => {
      const s = phases[name];
      if (!s) throw new Error(`no phase '${name}' in this recording; phases are ${JSON.stringify(Object.keys(phases))}`);
      return s;
    };
    return Object.assign(Object.create(null), phase('all'), { phase });
  }

  system(phase = 'all'): SystemPhaseStats { return this.summary.system[phase]; }
  proxy(phase = 'all'): ProxyPhaseStats | undefined { return this.summary.proxy?.[phase]; }

  check(budgets: Budget | Budget[]): BudgetViolation[] {
    const out: BudgetViolation[] = [];
    for (const b of [budgets].flat()) {
      const phase = b.phase ?? 'all';
      const labels = b.target ? [b.target] : this.data.targets;
      // A typo in a budget must not pass silently by matching nothing.
      if (b.target && !this.summary.targets[b.target]) throw new Error(`budget names target '${b.target}', but the recording has ${JSON.stringify(this.data.targets)}`);
      if (!this.summary.system[phase]) throw new Error(`budget names phase '${phase}', but the recording has ${JSON.stringify(this.summary.phases)}`);
      for (const [key, limit] of Object.entries(b)) {
        if (key === 'target' || key === 'phase' || typeof limit !== 'number') continue;
        if (key === 'systemCpuMean') {
          const actual = this.summary.system[phase]?.cpu.mean;
          if (actual !== undefined && actual > limit) out.push({ target: '(system)', phase, metric: key, limit, actual: round(actual) });
          continue;
        }
        for (const label of labels) {
          const s = this.summary.targets[label]?.[phase];
          if (!s) continue;
          const actual = metric(s, this.summary.proxy?.[phase], key);
          if (actual !== undefined && actual > limit) out.push({ target: label, phase, metric: key, limit, actual: round(actual) });
        }
      }
    }
    return out;
  }

  /** Fails with every budget the recording exceeded. */
  assertBudgets(budgets: Budget | Budget[]): void {
    const v = this.check(budgets);
    if (v.length) {
      throw new AssertionError(`perf budget exceeded:\n${v.map((x) => `  ${x.target} [${x.phase}] ${x.metric}: ${x.actual} > ${x.limit}`).join('\n')}${this.files.html ? `\n  report: ${this.files.html}` : ''}`);
    }
  }

  saveBaseline(path: string): void {
    writeFileSync(path, JSON.stringify(this.summary, null, 2));
  }

  /** Metrics that got worse than a saved baseline by more than the tolerance. A missing baseline file is saved and compares clean. */
  compareBaseline(path: string, opts: BaselineOptions = {}): Regression[] {
    if (!existsSync(path)) { this.saveBaseline(path); return []; }
    const base = JSON.parse(readFileSync(path, 'utf8')) as PerfSummary;
    const tol = opts.tolerance ?? 0.2;
    const floors = { ...DEFAULT_FLOORS, ...opts.floors };
    const out: Regression[] = [];
    for (const [label, phases] of Object.entries(this.summary.targets)) {
      for (const [phase, cur] of Object.entries(phases)) {
        const was = base.targets[label]?.[phase];
        if (!was) continue;
        for (const m of Object.keys(DEFAULT_FLOORS) as BaselineMetric[]) {
          const a = metric(was, base.proxy?.[phase], m);
          const b = metric(cur, this.summary.proxy?.[phase], m);
          if (a === undefined || b === undefined) continue;
          if (b > a * (1 + tol) && b - a > floors[m]) {
            out.push({ target: label, phase, metric: m, baseline: round(a), current: round(b), change: a ? `+${Math.round(((b - a) / Math.abs(a)) * 100)}%` : 'new' });
          }
        }
      }
    }
    return out;
  }

  assertNoRegression(path: string, opts: BaselineOptions = {}): void {
    const r = this.compareBaseline(path, opts);
    if (r.length) {
      throw new AssertionError(`perf regressed against ${path}:\n${r.map((x) => `  ${x.target} [${x.phase}] ${x.metric}: ${x.baseline} → ${x.current} (${x.change})`).join('\n')}`);
    }
  }

  /** A plain-text table of the headline numbers, for logs and test attachments. */
  table(phases?: string[]): string {
    const rows: string[][] = [['target', 'phase', 'cpu mean%', 'cpu p95%', 'cpu max%', 'mem MB (max)', 'mem MB/h', 'handles Δ', 'net KB/min']];
    for (const [label, byPhase] of Object.entries(this.summary.targets)) {
      for (const [phase, s] of Object.entries(byPhase)) {
        if (phases && !phases.includes(phase)) continue;
        const net = s.net ?? this.summary.proxy?.[phase];
        rows.push([label, phase, fmt(s.cpu.mean), fmt(s.cpu.p95), fmt(s.cpu.max), fmt(s.memMB.max, 0), fmt(s.memMB.slopePerHour, 1), fmt(s.handles.growth, 0), net ? fmt(net.bytesPerMin / 1024, 1) : '-']);
      }
    }
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
  }
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
