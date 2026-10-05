import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Driver } from '../drivers/driver.ts';
import type { NetworkProxy } from '../net/proxy.ts';
import { sleep } from '../core/wait.ts';
import { PerfMonitor, type MonitorOptions, type PerfTarget } from './monitor.ts';
import { PerfReport, type Budget } from './report.ts';
import { median, round } from './stats.ts';
import { Timeline } from './timeline.ts';
import { BrowserWorkload } from './workload.ts';

export type PerfConfig = {
  /** Sampling interval. Default 1000 ms. */
  intervalMs?: number;
  /** Default warm-up excluded from the `all` phase. Default 0. */
  warmupMs?: number;
  /** Budgets `perf.assertBudgets(report)` checks when given none. */
  budgets?: Budget[];
};

export type AbVariant = {
  /** Put the system in this variant's state, e.g. start recording. */
  setup?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
};

export type AbOptions = {
  targets: PerfTarget[];
  variants: Record<string, AbVariant>;
  /** The work measured under every variant, e.g. a browsing workload. */
  run: (variant: string, round: number) => Promise<unknown>;
  /** Rounds per variant. Variants alternate (A B A B …) so drift hits them equally. Default 3. */
  repeat?: number;
  /** Pause after setup before measuring. Default 5000 ms. */
  settleMs?: number;
  intervalMs?: number;
};

export type AbRow = { variant: string; target: string; cpuMean: number; cpuP95: number; memMaxMB: number; netBytesPerMin: number | null; systemCpuMean: number };

export class AbResult {
  readonly rows: AbRow[];
  readonly reports: Record<string, PerfReport[]>;

  constructor(rows: AbRow[], reports: Record<string, PerfReport[]>) {
    this.rows = rows;
    this.reports = reports;
  }

  get(variant: string, target: string): AbRow {
    const r = this.rows.find((x) => x.variant === variant && x.target === target);
    if (!r) throw new Error(`no A/B row for ${variant} / ${target}`);
    return r;
  }

  /** How much `variant` costs over `baseline` for one target, as metric deltas. */
  delta(variant: string, baseline: string, target: string) {
    const a = this.get(variant, target);
    const b = this.get(baseline, target);
    return {
      cpuMean: round(a.cpuMean - b.cpuMean),
      cpuP95: round(a.cpuP95 - b.cpuP95),
      memMaxMB: round(a.memMaxMB - b.memMaxMB),
      systemCpuMean: round(a.systemCpuMean - b.systemCpuMean),
    };
  }

  table(): string {
    const rows = [['variant', 'target', 'cpu mean%', 'cpu p95%', 'mem max MB', 'net KB/min', 'system cpu%'],
      ...this.rows.map((r) => [r.variant, r.target, r.cpuMean.toFixed(1), r.cpuP95.toFixed(1), r.memMaxMB.toFixed(0), r.netBytesPerMin === null ? '-' : (r.netBytesPerMin / 1024).toFixed(1), r.systemCpuMean.toFixed(1)])];
    const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ')).join('\n');
  }
}

const safe = (s: string) => s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80);

/**
 * `ctx.perf`: performance measurement for one test.
 *
 * ```ts
 * const mon = await perf.monitor([app]);
 * await perf.phase('idle', () => sleep(60_000));
 * await perf.phase('browsing', () => browser.run({ preset: 'browse-news', durationMs: 600_000 }));
 * const report = await mon.stop();
 * report.assertBudgets({ phase: 'browsing', cpuP95: 15, memSlopeMBPerHour: 50 });
 * ```
 *
 * Monitors still running when the test ends are stopped by the runner, and
 * every report's HTML is attached to the test result.
 */
export class Perf {
  readonly timeline: Timeline;
  readonly config: PerfConfig;
  #driver: Driver;
  #proxy: NetworkProxy | null;
  #outDir: string;
  #monitors: PerfMonitor[] = [];
  #workloads: BrowserWorkload[] = [];
  #seq = 0;
  readonly reports: PerfReport[] = [];

  constructor(opts: { driver: Driver; timeline?: Timeline; proxy?: NetworkProxy | null; outDir: string; config?: PerfConfig }) {
    this.#driver = opts.driver;
    this.timeline = opts.timeline ?? new Timeline();
    this.#proxy = opts.proxy ?? null;
    this.#outDir = opts.outDir;
    this.config = opts.config ?? {};
  }

  /** The run's network proxy, when `networkProxy` is on in the config. */
  get proxy(): NetworkProxy | null { return this.#proxy; }

  /** Starts sampling CPU, memory, I/O, handles and network for these targets. */
  async monitor(targets: PerfTarget | PerfTarget[], opts: MonitorOptions = {}): Promise<PerfMonitor> {
    const name = opts.name ?? `monitor-${++this.#seq}`;
    const mon = new PerfMonitor([targets].flat(), {
      intervalMs: opts.intervalMs ?? this.config.intervalMs,
      warmupMs: opts.warmupMs ?? this.config.warmupMs,
      name,
      timeline: this.timeline,
      proxy: this.#proxy,
      outDir: join(this.#outDir, `${Date.now()}-${safe(name)}`),
    });
    this.#monitors.push(mon);
    await mon.start();
    return mon;
  }

  /** Runs `fn` as a named phase: every running monitor reports stats for it separately. */
  async phase<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    this.timeline.add('phase-start', name);
    try {
      return await fn();
    } finally {
      this.timeline.add('phase-end', name);
    }
  }

  /** A named phase of doing nothing: the baseline to compare the rest against. */
  idle(name: string, ms: number): Promise<void> {
    return this.phase(name, () => sleep(ms));
  }

  /** A vertical marker on the report's charts. */
  mark(label: string): void {
    this.timeline.add('mark', label);
  }

  /** Opens a browser for a scripted "normal usage" workload. Closed by the runner after the test. */
  async openBrowser(opts: { bundleId?: string; extraArgs?: string[] } = {}): Promise<BrowserWorkload> {
    const w = await BrowserWorkload.open(this.#driver, { ...opts, timeline: this.timeline });
    this.#workloads.push(w);
    return w;
  }

  /** Checks a report against budgets, by default those in the config's `perf.budgets`. */
  assertBudgets(report: PerfReport, budgets: Budget | Budget[] | undefined = this.config.budgets): void {
    if (!budgets) throw new Error('no budgets given and none configured in perf.budgets');
    report.assertBudgets(budgets);
  }

  /**
   * Runs the same work under several variants and compares them, e.g. the app
   * recording against the app stopped, to isolate what recording costs.
   * Rounds alternate between variants and each result is the median across
   * rounds.
   */
  async ab(opts: AbOptions): Promise<AbResult> {
    const names = Object.keys(opts.variants);
    if (names.length < 2) throw new Error('perf.ab needs at least two variants');
    const reports: Record<string, PerfReport[]> = Object.fromEntries(names.map((n) => [n, []]));
    const repeat = opts.repeat ?? 3;
    for (let round = 0; round < repeat; round++) {
      const order = round % 2 === 0 ? names : [...names].reverse();
      for (const v of order) {
        const variant = opts.variants[v];
        await variant.setup?.();
        try {
          await sleep(opts.settleMs ?? 5000);
          const mon = await this.monitor(opts.targets, { name: `ab-${v}-r${round + 1}`, intervalMs: opts.intervalMs });
          try {
            await this.phase(v, () => opts.run(v, round));
          } finally {
            reports[v].push(await mon.stop());
          }
        } finally {
          await variant.teardown?.();
        }
      }
    }
    const rows: AbRow[] = [];
    for (const v of names) {
      const rs = reports[v];
      for (const target of rs[0]?.data.targets ?? []) {
        const stats = rs.map((r) => r.of(target).phase(v));
        const net = rs.map((r, i) => (stats[i].net ?? r.proxy(v))?.bytesPerMin).filter((x): x is number => x !== undefined);
        rows.push({
          variant: v,
          target,
          cpuMean: round(median(stats.map((s) => s.cpu.mean))),
          cpuP95: round(median(stats.map((s) => s.cpu.p95))),
          memMaxMB: round(median(stats.map((s) => s.memMB.max))),
          netBytesPerMin: net.length ? round(median(net)) : null,
          systemCpuMean: round(median(rs.map((r) => r.system(v)?.cpu.mean ?? 0))),
        });
      }
    }
    const result = new AbResult(rows, reports);
    await mkdir(this.#outDir, { recursive: true });
    await writeFile(join(this.#outDir, `${Date.now()}-ab.json`), JSON.stringify({ rows, reports: Object.fromEntries(Object.entries(reports).map(([k, v]) => [k, v.map((r) => r.files.html)])) }, null, 2));
    return result;
  }

  /** Stops every monitor and closes every workload browser. The runner calls this after each test. */
  async dispose(): Promise<PerfReport[]> {
    for (const m of this.#monitors) {
      const r = await m.stop().catch(() => undefined);
      if (r && !this.reports.includes(r)) this.reports.push(r);
    }
    for (const w of this.#workloads) await w.close();
    this.#workloads = [];
    return this.reports;
  }
}

export { PerfMonitor, PerfReport, BrowserWorkload, Timeline };
