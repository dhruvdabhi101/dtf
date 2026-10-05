import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, statfs, rm } from 'node:fs/promises';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { UnsupportedError } from '../core/errors.ts';
import { Rng } from '../core/random.ts';
import { asRoot, isElevated, powershell, psq, sh } from '../core/shell.ts';
import { WIN32_PRELUDE } from '../core/win32.ts';
import { sleep } from '../core/wait.ts';
import { NETWORK_PROFILES, type NetConditions, type NetworkProfile, type NetworkProxy } from '../net/proxy.ts';
import { Timeline } from '../perf/timeline.ts';
import { removeEntry, writeEntry, type JournalEntry } from './journal.ts';
import { runUndo, type UndoOp } from './undo.ts';
import { pick, processTree, type ProcInfo, type ProcSelector } from './procs.ts';

/**
 * `ctx.chaos`: fault injection for one test.
 *
 * Every fault is injected, then restored: by `fault.restore()`, at the end of
 * `chaos.with(...)`, after its `durationMs`, when the test ends, and — if the
 * runner itself dies — by a detached watchdog at the fault's deadline or by
 * the journal replay at the start of the next run. A test cannot leave the
 * machine offline or pinned at 100% CPU.
 *
 * Faults that affect the whole machine rather than just the app (Wi-Fi,
 * adapters, OS-level packet shaping, memory and disk exhaustion) refuse to run
 * unless `chaos.allowDestructive` is set in the config, `--allow-destructive`
 * is passed, or DTF_CHAOS_DESTRUCTIVE=1. Run those on a machine you can lose
 * the network on, not over a remote session.
 */

export type ChaosConfig = {
  /** Allow machine-wide faults. Also `--allow-destructive` or DTF_CHAOS_DESTRUCTIVE=1. */
  allowDestructive?: boolean;
  /** Hard limit on any fault: the watchdog restores it after this long. Default 10 minutes. */
  maxFaultMs?: number;
  /** clumsy.exe, for OS-level latency and loss on Windows. Also DTF_CLUMSY, or on PATH. */
  clumsyPath?: string;
};

export type Fault = {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  readonly startedAt: number;
  readonly active: boolean;
  restore(): Promise<void>;
};

/** An app (anything with a pid, like `DesktopApp`) or a pid. */
export type ProcessTarget = number | { readonly pid: number; readonly executable?: string | null };

type Undo = { journal: UndoOp[]; local?: () => Promise<void> | void };

const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const script = (name: string) => fileURLToPath(new URL(`./${name}${EXT}`, import.meta.url));

const pidOf = (t: ProcessTarget) => (typeof t === 'number' ? t : t.pid);

/** Exit codes that make a Windows process look like it crashed rather than was closed. */
const WIN_CRASH_CODES = { crash: 0xC0000005, abort: 0xC0000409, kill: 1 } as const;

export class Chaos {
  readonly timeline: Timeline;
  readonly rng: Rng;
  #config: ChaosConfig;
  #proxy: NetworkProxy | null;
  #active = new Map<string, Fault>();
  #seq = 0;
  /** Everything this instance did, for the test report. */
  readonly log: { at: number; event: 'inject' | 'restore' | 'action'; kind: string; description: string }[] = [];

  constructor(opts: { timeline?: Timeline; proxy?: NetworkProxy | null; config?: ChaosConfig; seed?: number } = {}) {
    this.timeline = opts.timeline ?? new Timeline();
    this.#proxy = opts.proxy ?? null;
    this.#config = opts.config ?? {};
    this.rng = new Rng(opts.seed);
  }

  get allowDestructive(): boolean {
    return !!this.#config.allowDestructive || process.env.DTF_CHAOS_DESTRUCTIVE === '1';
  }

  get active(): Fault[] { return [...this.#active.values()]; }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  #guardDestructive(what: string) {
    if (!this.allowDestructive) {
      throw new UnsupportedError(what, process.platform, 'it affects the whole machine; set chaos.allowDestructive in dtf.config, pass --allow-destructive, or set DTF_CHAOS_DESTRUCTIVE=1');
    }
  }

  async #guardElevated(what: string) {
    if (!(await isElevated())) {
      throw new UnsupportedError(what, process.platform, process.platform === 'win32'
        ? 'it needs an elevated (Run as administrator) terminal'
        : 'it needs root; run with sudo or allow passwordless sudo for pfctl/dnctl/networksetup');
    }
  }

  /**
   * Records the undo steps, starts the watchdog, then injects. The journal is
   * written first: a crash between injecting and journaling would leave a
   * fault nothing knows to undo.
   */
  async #inject(kind: string, description: string, opts: { durationMs?: number }, doIt: () => Promise<Undo>): Promise<Fault> {
    const id = `${Date.now().toString(36)}-${(++this.#seq).toString(36)}-${process.pid}`;
    const maxMs = this.#config.maxFaultMs ?? 10 * 60_000;
    const deadline = Date.now() + Math.min(maxMs, (opts.durationMs ?? maxMs) + 30_000);
    const entry: JournalEntry = { id, kind, description, createdAt: Date.now(), deadline, ownerPid: process.pid, undo: [] };
    writeEntry(entry);
    let undo: Undo;
    try {
      undo = await doIt();
    } catch (err) {
      removeEntry(id);
      throw err;
    }
    if (undo.journal.length) {
      writeEntry({ ...entry, undo: undo.journal });
      this.#spawnWatchdog(id);
    } else {
      removeEntry(id);
    }

    let active = true;
    let timer: NodeJS.Timeout | undefined;
    const startedAt = Date.now();
    const fault: Fault = {
      id, kind, description, startedAt,
      get active() { return active; },
      restore: async () => {
        if (!active) return;
        active = false;
        if (timer) clearTimeout(timer);
        this.#active.delete(id);
        const errors: string[] = [];
        try { await undo.local?.(); } catch (err) { errors.push(String(err)); }
        for (const op of [...undo.journal].reverse()) {
          try { await runUndo(op); } catch (err) { errors.push(`${op.op}: ${err instanceof Error ? err.message : String(err)}`); }
        }
        removeEntry(id);
        this.timeline.add('fault-end', description);
        this.log.push({ at: Date.now(), event: 'restore', kind, description });
        if (errors.length) throw new Error(`restoring "${description}" partly failed:\n  ${errors.join('\n  ')}`);
      },
    };
    this.#active.set(id, fault);
    this.timeline.add('fault-start', description);
    this.log.push({ at: startedAt, event: 'inject', kind, description });
    if (opts.durationMs) timer = setTimeout(() => { void fault.restore().catch(() => {}); }, opts.durationMs);
    return fault;
  }

  #spawnWatchdog(id: string) {
    const child = spawn(process.execPath, ['--no-warnings', script('watchdog'), id], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  }

  #action(kind: string, description: string) {
    this.timeline.add('mark', description);
    this.log.push({ at: Date.now(), event: 'action', kind, description });
  }

  /** Injects a fault, runs `fn`, and restores the fault whatever `fn` does. */
  async with<T>(fault: Fault | Promise<Fault>, fn: (fault: Fault) => Promise<T> | T): Promise<T> {
    const f = await fault;
    try {
      return await fn(f);
    } finally {
      await f.restore();
    }
  }

  /** Restores every fault still active. The runner calls this after each test. */
  async restoreAll(): Promise<void> {
    const errors: string[] = [];
    for (const f of [...this.#active.values()].reverse()) {
      try { await f.restore(); } catch (err) { errors.push(err instanceof Error ? err.message : String(err)); }
    }
    if (errors.length) throw new Error(errors.join('\n'));
  }

  // ── Processes ─────────────────────────────────────────────────────────────

  readonly process = {
    /** The target's process tree, each process classified (main, renderer, gpu, utility, sidecar). */
    tree: (target: ProcessTarget): Promise<ProcInfo[]> => processTree(pidOf(target)),

    /**
     * Ends processes abruptly. `how`: `kill` (plain termination), `crash`
     * (an access-violation exit / SIGSEGV, so crash handling runs as it would
     * for a real crash), `abort` (a fail-fast exit / SIGABRT).
     *
     * Not a restorable fault: to come back from it, relaunch the app
     * (`app.relaunch()`) or assert that it restarts itself.
     */
    kill: async (target: ProcessTarget, opts: { which?: ProcSelector; how?: 'kill' | 'crash' | 'abort' } = {}): Promise<ProcInfo[]> => {
      const tree = await processTree(pidOf(target));
      if (!tree.length) throw new Error(`process ${pidOf(target)} is not running`);
      const victims = pick(tree, opts.which ?? 'main', this.rng);
      if (!victims.length) throw new Error(`no ${String(opts.which)} process in the tree of ${pidOf(target)}: ${tree.map((p) => `${p.pid}:${p.kind}`).join(', ')}`);
      const how = opts.how ?? 'kill';
      if (process.platform === 'win32') {
        const code = WIN_CRASH_CODES[how];
        await powershell(`${WIN32_PRELUDE}${victims.map((v) => `try { [DtfNative]::Terminate(${v.pid}, [uint32]${code}) } catch { }`).join('\n')}`);
      } else {
        const sig = how === 'crash' ? 'SIGSEGV' : how === 'abort' ? 'SIGABRT' : 'SIGKILL';
        for (const v of victims) { try { process.kill(v.pid, sig); } catch { /* already gone */ } }
      }
      this.#action('process', `${how} ${victims.map((v) => `${v.kind} ${v.pid}`).join(', ')}`);
      return victims;
    },

    /** Freezes processes: the app is alive but unresponsive, as in a hang or a debugger stop. */
    suspend: (target: ProcessTarget, opts: { which?: ProcSelector; durationMs?: number } = {}): Promise<Fault> =>
      this.#inject('process-suspend', `suspend ${String(opts.which ?? 'main')} of ${pidOf(target)}`, opts, async () => {
        const victims = pick(await processTree(pidOf(target)), opts.which ?? 'main', this.rng);
        if (!victims.length) throw new Error(`no ${String(opts.which ?? 'main')} process to suspend in the tree of ${pidOf(target)}`);
        if (process.platform === 'win32') {
          await powershell(`${WIN32_PRELUDE}${victims.map((v) => `[DtfNative]::Suspend(${v.pid})`).join('\n')}`);
        } else {
          for (const v of victims) process.kill(v.pid, 'SIGSTOP');
        }
        return { journal: victims.map((v) => ({ op: 'resume', pid: v.pid }) as UndoOp) };
      }),

    /**
     * Kills the app at seeded random moments, `iterations` times, calling
     * `recover` after each (relaunch it, or wait for it to restart itself)
     * and then `check` (the invariants: data intact, no duplicates, …).
     */
    killLoop: async (opts: {
      target: () => ProcessTarget;
      iterations: number;
      /** Wait before each kill, [min, max] ms. */
      betweenMs?: [number, number];
      which?: ProcSelector;
      how?: 'kill' | 'crash' | 'abort';
      recover: (i: number) => Promise<void>;
      check?: (i: number) => Promise<void>;
    }): Promise<{ i: number; afterMs: number; victims: ProcInfo[] }[]> => {
      const [min, max] = opts.betweenMs ?? [5_000, 60_000];
      const out: { i: number; afterMs: number; victims: ProcInfo[] }[] = [];
      for (let i = 0; i < opts.iterations; i++) {
        const wait = this.rng.int(min, max);
        await sleep(wait);
        const victims = await this.process.kill(opts.target(), { which: opts.which, how: opts.how });
        out.push({ i, afterMs: wait, victims });
        await opts.recover(i);
        await opts.check?.(i);
      }
      return out;
    },
  };

  // ── Network ───────────────────────────────────────────────────────────────

  #requireProxy(what: string): NetworkProxy {
    if (!this.#proxy) {
      throw new UnsupportedError(what, process.platform,
        "it goes through dtf's network proxy, which is off; set `networkProxy: true` in dtf.config so the app is launched through it, or use `via: 'firewall' | 'wifi' | 'adapter' | 'os'`");
    }
    return this.#proxy;
  }

  /** Proxy conditions stack: each fault merges its conditions in and takes exactly them back out. */
  async #proxyFault(kind: string, description: string, given: NetConditions, opts: { durationMs?: number }): Promise<Fault> {
    const proxy = this.#requireProxy(description);
    // Unset options must not clear what another active fault set.
    const cond = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as NetConditions;
    return this.#inject(kind, description, opts, async () => {
      const before = { ...proxy.conditions };
      proxy.update(cond);
      return {
        journal: [],
        local: () => {
          // Remove only what this fault set, keeping any other active fault's conditions.
          const now: NetConditions = { ...proxy.conditions };
          for (const k of Object.keys(cond) as (keyof NetConditions)[]) {
            (now as Record<string, unknown>)[k] = (before as Record<string, unknown>)[k];
            if (now[k] === undefined) delete now[k];
          }
          proxy.set(now);
        },
      };
    });
  }

  readonly network = {
    /**
     * Takes the network away.
     *
     * - `proxy` (default when the proxy is on): only the app loses the
     *   network; no admin, no effect on the machine. `style` picks how
     *   connections fail: `refuse`, `reset` or `hang`.
     * - `firewall` (Windows, admin): outbound and inbound blocked for the
     *   app's executables, including traffic that ignores the proxy.
     * - `wifi`: disconnects Wi-Fi for real, so the OS reports "offline" and
     *   the app sees network-change events. Destructive.
     * - `adapter` (admin): disables the adapter with the default route. Destructive.
     */
    offline: async (opts: {
      via?: 'proxy' | 'firewall' | 'wifi' | 'adapter';
      style?: 'refuse' | 'reset' | 'hang';
      target?: ProcessTarget;
      /** For `wifi`/`adapter`: the interface. Defaults to the Wi-Fi interface / the default-route adapter. */
      iface?: string;
      durationMs?: number;
    } = {}): Promise<Fault> => {
      const via = opts.via ?? (this.#proxy ? 'proxy' : 'firewall');
      if (via === 'proxy') return this.#proxyFault('network-offline', `offline (proxy, ${opts.style ?? 'refuse'})`, { offline: opts.style ?? 'refuse' }, opts);
      if (via === 'firewall') return this.#firewallBlock(opts);
      if (via === 'wifi') return this.#wifiOff(opts);
      return this.#adapterOff(opts);
    },

    /** Adds latency (and optionally jitter). `via: 'os'` shapes every program's traffic (clumsy on Windows, dummynet on macOS). */
    latency: (opts: { ms: number; jitterMs?: number; via?: 'proxy' | 'os'; hosts?: (string | RegExp)[]; durationMs?: number }): Promise<Fault> => {
      if ((opts.via ?? 'proxy') === 'os') return this.#osShape({ latencyMs: opts.ms, jitterMs: opts.jitterMs }, opts);
      return this.#proxyFault('network-latency', `latency ${opts.ms}ms${opts.jitterMs ? ` ±${opts.jitterMs}` : ''}`, { latencyMs: opts.ms, jitterMs: opts.jitterMs, hosts: opts.hosts }, opts);
    },

    /** Caps bandwidth, kilobits per second. */
    throttle: (opts: { downKbps?: number; upKbps?: number; via?: 'proxy' | 'os'; durationMs?: number }): Promise<Fault> => {
      if ((opts.via ?? 'proxy') === 'os') return this.#osShape({ downKbps: opts.downKbps, upKbps: opts.upKbps }, opts);
      return this.#proxyFault('network-throttle', `throttle ↓${opts.downKbps ?? '∞'} ↑${opts.upKbps ?? '∞'} kbps`, { downKbps: opts.downKbps, upKbps: opts.upKbps }, opts);
    },

    /** Loss. Through the proxy, a share of connections is cut mid-stream; at the OS level, packets are dropped. */
    loss: (opts: { percent: number; via?: 'proxy' | 'os'; durationMs?: number }): Promise<Fault> => {
      if ((opts.via ?? 'proxy') === 'os') return this.#osShape({ lossPercent: opts.percent }, opts);
      return this.#proxyFault('network-loss', `loss ${opts.percent}%`, { lossPercent: opts.percent }, opts);
    },

    /** These hosts fail to resolve. */
    dnsFail: (opts: { hosts: (string | RegExp)[]; durationMs?: number }): Promise<Fault> =>
      this.#proxyFault('network-dns', `DNS failure for ${opts.hosts.join(', ')}`, { failHosts: opts.hosts }, opts),

    /** Connections to these hosts open and then never progress: a stalled TLS handshake. */
    stall: (opts: { hosts: (string | RegExp)[]; durationMs?: number }): Promise<Fault> =>
      this.#proxyFault('network-stall', `stalled connections to ${opts.hosts.join(', ')}`, { stallHosts: opts.hosts }, opts),

    /** A named condition set: `slow-3g`, `3g`, `edge`, `satellite`, `lossy`, `flaky`, `extreme-latency`. */
    profile: async (name: NetworkProfile, opts: { via?: 'proxy' | 'os'; durationMs?: number } = {}): Promise<Fault> => {
      const cond = NETWORK_PROFILES[name];
      if (!cond) throw new Error(`unknown network profile '${name}'; known: ${Object.keys(NETWORK_PROFILES).join(', ')}`);
      if ((opts.via ?? 'proxy') === 'os') return this.#osShape(cond, opts);
      return this.#proxyFault('network-profile', `network profile ${name}`, cond, opts);
    },

    /** Drops and restores the network `cycles` times. Resolves when done, with the network back. */
    flap: async (opts: { downMs: number; upMs: number; cycles: number; via?: 'proxy' | 'firewall' | 'wifi' | 'adapter'; target?: ProcessTarget; onCycle?: (i: number, state: 'down' | 'up') => Promise<void> | void }): Promise<void> => {
      for (let i = 0; i < opts.cycles; i++) {
        const f = await this.network.offline({ via: opts.via, target: opts.target, durationMs: opts.downMs + 60_000 });
        await opts.onCycle?.(i, 'down');
        await sleep(opts.downMs);
        await f.restore();
        await opts.onCycle?.(i, 'up');
        await sleep(opts.upMs);
      }
    },

    /** Replaces all proxy conditions at once, as a fault. For combinations the helpers above do not cover. */
    conditions: (cond: NetConditions, opts: { durationMs?: number } = {}): Promise<Fault> =>
      this.#proxyFault('network-conditions', `network ${JSON.stringify(cond)}`, cond, opts),
  };

  async #firewallBlock(opts: { target?: ProcessTarget; durationMs?: number }): Promise<Fault> {
    if (process.platform !== 'win32') {
      throw new UnsupportedError("network.offline({ via: 'firewall' })", process.platform, "use via: 'proxy' or via: 'wifi' on macOS");
    }
    if (!opts.target) throw new Error("network.offline({ via: 'firewall' }) needs a `target`: the app whose traffic to block");
    await this.#guardElevated('a firewall block');
    const target = opts.target;
    const tree = await processTree(pidOf(target));
    const exes = [...new Set([...tree.map((p) => p.path), typeof target === 'object' ? target.executable ?? undefined : undefined].filter((p): p is string => !!p))];
    if (!exes.length) throw new Error(`could not find the executables of process ${pidOf(target)}`);
    const group = `dtf-chaos-${Date.now().toString(36)}`;
    return this.#inject('network-offline', `offline (firewall: ${exes.map((e) => e.split(/[\\/]/).pop()).join(', ')})`, opts, async () => {
      await powershell(exes.map((exe) => ['Outbound', 'Inbound'].map((dir) =>
        `New-NetFirewallRule -DisplayName ${psq(`${group} ${dir}`)} -Group ${psq(group)} -Direction ${dir} -Program ${psq(exe)} -Action Block | Out-Null`).join('\n')).join('\n'));
      // A block rule stops new connections; established ones carry on until they
      // next send. That is what a real network loss looks like to the app too.
      return { journal: [{ op: 'firewall', group }] };
    });
  }

  async #wifiOff(opts: { iface?: string; durationMs?: number }): Promise<Fault> {
    this.#guardDestructive('turning Wi-Fi off');
    if (process.platform === 'win32') {
      const info = (await sh('netsh', ['wlan', 'show', 'interfaces'])).stdout;
      const blocks = info.split(/\r?\n\s*\r?\n/).filter((b) => /^\s*Name\s*:/m.test(b));
      const block = blocks.find((b) => !opts.iface || new RegExp(`^\\s*Name\\s*:\\s*${opts.iface}\\s*$`, 'mi').test(b)) ?? blocks[0];
      const iface = block?.match(/^\s*Name\s*:\s*(.+?)\s*$/m)?.[1];
      const profile = block?.match(/^\s*Profile\s*:\s*(.+?)\s*$/m)?.[1];
      if (!iface) throw new Error('no Wi-Fi interface found (netsh wlan show interfaces)');
      if (!profile) throw new Error(`Wi-Fi interface "${iface}" is not connected, so there is nothing to disconnect`);
      return this.#inject('network-offline', `Wi-Fi off (${iface})`, opts, async () => {
        const r = await sh('netsh', ['wlan', 'disconnect', `interface=${iface}`]);
        if (!r.ok) throw new Error(`netsh wlan disconnect: ${r.stdout || r.stderr}`);
        return { journal: [{ op: 'wifi-connect', iface, profile }] };
      });
    }
    if (process.platform === 'darwin') {
      const ports = (await sh('/usr/sbin/networksetup', ['-listallhardwareports'])).stdout;
      const device = opts.iface ?? ports.match(/Hardware Port: Wi-Fi\s*\nDevice: (\S+)/)?.[1];
      if (!device) throw new Error('no Wi-Fi device found (networksetup -listallhardwareports)');
      return this.#inject('network-offline', `Wi-Fi off (${device})`, opts, async () => {
        const r = await sh('/usr/sbin/networksetup', ['-setairportpower', device, 'off']);
        if (!r.ok) throw new Error(`networksetup: ${r.stderr}`);
        return { journal: [{ op: 'mac-wifi-on', device }] };
      });
    }
    throw new UnsupportedError('turning Wi-Fi off', process.platform);
  }

  async #adapterOff(opts: { iface?: string; durationMs?: number }): Promise<Fault> {
    this.#guardDestructive('disabling a network adapter');
    await this.#guardElevated('disabling a network adapter');
    if (process.platform === 'win32') {
      const name = opts.iface ?? (await powershell(
        `(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 | Get-NetAdapter).Name`,
      )).trim();
      if (!name) throw new Error('no adapter with a default route');
      return this.#inject('network-offline', `adapter "${name}" disabled`, opts, async () => {
        const r = await sh('netsh', ['interface', 'set', 'interface', `name=${name}`, 'admin=disabled']);
        if (!r.ok) throw new Error(`netsh: ${r.stdout || r.stderr}`);
        return { journal: [{ op: 'adapter-enable', name }] };
      });
    }
    if (process.platform === 'darwin') {
      const service = opts.iface ?? 'Wi-Fi';
      return this.#inject('network-offline', `network service "${service}" disabled`, opts, async () => {
        const r = await asRoot('/usr/sbin/networksetup', ['-setnetworkserviceenabled', service, 'off']);
        if (!r.ok) throw new Error(`networksetup: ${r.stderr}`);
        return { journal: [{ op: 'mac-service-on', service }] };
      });
    }
    throw new UnsupportedError('disabling a network adapter', process.platform);
  }

  async #findClumsy(): Promise<string | undefined> {
    const candidates = [this.#config.clumsyPath, process.env.DTF_CLUMSY].filter((p): p is string => !!p);
    for (const c of candidates) if (existsSync(c)) return c;
    const r = await sh('where', ['clumsy']);
    return r.ok ? r.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
  }

  /** OS-level shaping for every program: clumsy (WinDivert) on Windows, dummynet on macOS. */
  async #osShape(cond: NetConditions, opts: { durationMs?: number }): Promise<Fault> {
    this.#guardDestructive('OS-level network shaping');
    await this.#guardElevated('OS-level network shaping');
    const desc = `OS network ${[cond.latencyMs && `latency ${cond.latencyMs}ms`, cond.lossPercent && `loss ${cond.lossPercent}%`, (cond.downKbps || cond.upKbps) && `bw ${cond.downKbps ?? cond.upKbps}kbps`].filter(Boolean).join(', ')}`;
    if (process.platform === 'win32') {
      const clumsy = await this.#findClumsy();
      if (!clumsy) throw new UnsupportedError('OS-level network shaping', 'Windows', 'clumsy.exe was not found; download it from https://jagt.github.io/clumsy/ and set chaos.clumsyPath or DTF_CLUMSY');
      const args = ['--filter', 'outbound and !loopback'];
      if (cond.latencyMs) args.push('--lag', 'on', '--lag-time', String(cond.latencyMs));
      if (cond.lossPercent) args.push('--drop', 'on', '--drop-chance', String(cond.lossPercent));
      const kbps = cond.upKbps ?? cond.downKbps;
      if (kbps) args.push('--bandwidth', 'on', '--bandwidth-bandwidth', String(Math.max(1, Math.round(kbps / 8))));
      return this.#inject('network-os', desc, opts, async () => {
        const child = spawn(clumsy, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        await sleep(1500);
        if (child.exitCode !== null || !child.pid) throw new Error(`clumsy exited at once (code ${child.exitCode}); it needs admin and WinDivert beside it`);
        return { journal: [{ op: 'kill', pid: child.pid, image: 'clumsy' }] };
      });
    }
    if (process.platform === 'darwin') {
      const anchor = 'com.apple/dtf-chaos';
      return this.#inject('network-os', desc, opts, async () => {
        const pipe = ['pipe', '1', 'config'];
        if (cond.latencyMs) pipe.push('delay', String(cond.latencyMs));
        if (cond.lossPercent) pipe.push('plr', String(cond.lossPercent / 100));
        const kbps = cond.downKbps ?? cond.upKbps;
        if (kbps) pipe.push('bw', `${kbps}Kbit/s`);
        let r = await asRoot('/usr/sbin/dnctl', pipe);
        if (!r.ok) throw new Error(`dnctl: ${r.stderr}`);
        r = await asRoot('/bin/sh', ['-c', `echo 'dummynet out quick proto {tcp,udp} from any to ! 127.0.0.1 pipe 1' | /sbin/pfctl -a ${anchor} -f -`]);
        if (!r.ok) throw new Error(`pfctl: ${r.stderr}`);
        const en = await asRoot('/sbin/pfctl', ['-E']);
        const token = (en.stderr + en.stdout).match(/Token : (\d+)/)?.[1];
        return { journal: [{ op: 'pf', anchor, token }] };
      });
    }
    throw new UnsupportedError('OS-level network shaping', process.platform);
  }

  // ── CPU ───────────────────────────────────────────────────────────────────

  #stress(mode: 'cpu' | 'mem', args: (string | number)[], maxMs: number): ChildProcess {
    return spawn(process.execPath, ['--no-warnings', '--expose-gc', script('stress-worker'), mode, ...args.map(String), String(process.pid), String(maxMs)], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
  }

  readonly cpu = {
    /**
     * Keeps `threads` cores (default: all) busy at `load` (0–1, default 1).
     * `priority: 'low'` makes a busy machine the app can still preempt;
     * `normal` makes one that competes with it.
     */
    stress: (opts: { load?: number; threads?: number; priority?: 'low' | 'normal'; durationMs?: number } = {}): Promise<Fault> => {
      const threads = opts.threads ?? cpus().length;
      const load = opts.load ?? 1;
      return this.#inject('cpu-stress', `CPU ${Math.round(load * 100)}% × ${threads} threads (${opts.priority ?? 'normal'} priority)`, opts, async () => {
        const maxMs = this.#config.maxFaultMs ?? 10 * 60_000;
        const child = this.#stress('cpu', [threads, load], Math.min(maxMs, opts.durationMs ?? maxMs));
        if (!child.pid) throw new Error('could not start the CPU stress worker');
        if (opts.priority === 'low') {
          const { setPriority, constants } = await import('node:os');
          try { setPriority(child.pid, constants.priority.PRIORITY_LOW); } catch { /* best effort */ }
        }
        return { journal: [{ op: 'kill', pid: child.pid, image: 'node' }], local: () => { child.kill(); } };
      });
    },

    /**
     * Caps the app's whole process tree at `percent` of the machine's CPU
     * (fractions allowed, down to 0.01)
     * (Windows: a job object hard cap, which also binds processes it starts
     * later). On macOS the tree is reniced to the lowest priority instead;
     * there is no hard cap there.
     */
    cap: (target: ProcessTarget, opts: { percent: number; durationMs?: number }): Promise<Fault> =>
      this.#capTree('cpu-cap', `CPU capped at ${opts.percent}% for ${pidOf(target)}`, target, { cpuPercent: opts.percent }, opts),
  };

  async #capTree(kind: string, desc: string, target: ProcessTarget, limits: { cpuPercent?: number; memoryBytes?: number }, opts: { durationMs?: number }): Promise<Fault> {
    const tree = await processTree(pidOf(target));
    if (!tree.length) throw new Error(`process ${pidOf(target)} is not running`);
    if (process.platform === 'win32') {
      const job = `Local\\dtf-chaos-${Date.now().toString(36)}-${this.#seq + 1}`;
      return this.#inject(kind, desc, opts, async () => {
        const failed = JSON.parse((await powershell(`${WIN32_PRELUDE}[DtfNative]::Cap(${psq(job)}, [int[]]@(${tree.map((p) => p.pid).join(',')}), ${limits.cpuPercent ?? 0}, ${Math.round(limits.memoryBytes ?? 0)})`)).trim() || '[]') as number[];
        if (failed.length === tree.length) throw new Error(`could not put any process of ${pidOf(target)} into a job object`);
        if (failed.length) this.#action(kind, `not capped (in a job that forbids nesting): ${failed.join(', ')}`);
        return { journal: [{ op: 'uncap', job }] };
      });
    }
    if (process.platform === 'darwin' && limits.cpuPercent !== undefined) {
      return this.#inject(kind, `${desc} (renice +20; macOS has no hard cap)`, opts, async () => {
        for (const p of tree) await sh('/usr/bin/renice', ['-n', '20', '-p', String(p.pid)]);
        return { journal: tree.map((p) => ({ op: 'renice', pid: p.pid, nice: 0 }) as UndoOp) };
      });
    }
    throw new UnsupportedError(`${kind} for an app`, process.platform, 'macOS has no per-process memory limit; use chaos.memory.stress or chaos.memory.pressure');
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  readonly memory = {
    /**
     * Fills the machine's memory until `usedFraction` of it is in use
     * (default 0.95), never leaving less than `minFreeMB` (default 300).
     * Holds that level, giving memory back if something else needs it.
     */
    stress: async (opts: { usedFraction?: number; minFreeMB?: number; durationMs?: number } = {}): Promise<Fault> => {
      this.#guardDestructive('memory stress');
      const used = opts.usedFraction ?? 0.95;
      return this.#inject('memory-stress', `memory held at ${Math.round(used * 100)}% used`, opts, async () => {
        const maxMs = this.#config.maxFaultMs ?? 10 * 60_000;
        const child = this.#stress('mem', [used, opts.minFreeMB ?? 300], Math.min(maxMs, opts.durationMs ?? maxMs));
        if (!child.pid) throw new Error('could not start the memory stress worker');
        // Let it reach the level before the test goes on.
        await new Promise<void>((resolve) => {
          let last = -1;
          let still = 0;
          const done = () => { child.off('message', onMsg); resolve(); };
          const onMsg = (m: { heldMB: number }) => { if (m.heldMB === last && ++still >= 4) done(); else { still = 0; last = m.heldMB; } };
          child.on('message', onMsg);
          setTimeout(done, 60_000).unref();
        });
        return { journal: [{ op: 'kill', pid: child.pid, image: 'node' }], local: () => { child.kill(); } };
      });
    },

    /** Limits the app's committed memory (Windows job object): its allocations past `mb` fail. */
    cap: (target: ProcessTarget, opts: { mb: number; durationMs?: number }): Promise<Fault> =>
      this.#capTree('memory-cap', `memory capped at ${opts.mb} MB for ${pidOf(target)}`, target, { memoryBytes: opts.mb * 1048576 }, opts),

    /** macOS: system memory-pressure notifications via `memory_pressure`. Elsewhere, memory stress. */
    pressure: async (level: 'warn' | 'critical' = 'critical', opts: { durationMs?: number } = {}): Promise<Fault> => {
      if (process.platform !== 'darwin') return this.memory.stress({ usedFraction: level === 'critical' ? 0.97 : 0.9, durationMs: opts.durationMs });
      this.#guardDestructive('memory pressure');
      return this.#inject('memory-pressure', `memory pressure ${level}`, opts, async () => {
        const child = spawn('/usr/bin/memory_pressure', ['-l', level], { stdio: 'ignore' });
        if (!child.pid) throw new Error('could not start memory_pressure');
        return { journal: [{ op: 'kill', pid: child.pid, image: 'memory_pressure' }], local: () => { child.kill(); } };
      });
    },
  };

  // ── Disk ──────────────────────────────────────────────────────────────────

  readonly disk = {
    /**
     * Fills the volume holding `path` until only `leaveMB` (default 50) is
     * free, with one file that is deleted on restore. Point it at the app's
     * data directory to test "disk full" while recording.
     */
    fill: async (opts: { path: string; leaveMB?: number; durationMs?: number }): Promise<Fault> => {
      this.#guardDestructive('filling the disk');
      const file = join(opts.path, `dtf-chaos-fill-${Date.now().toString(36)}.bin`);
      return this.#inject('disk-fill', `disk full (${opts.path}, ${opts.leaveMB ?? 50} MB left)`, opts, async () => {
        const st = await statfs(opts.path);
        const free = st.bavail * st.bsize;
        const size = free - (opts.leaveMB ?? 50) * 1048576;
        if (size <= 0) return { journal: [] };
        const fh = await open(file, 'w');
        try {
          if (process.platform === 'win32') {
            // NTFS reserves the clusters for the new length at once.
            await fh.truncate(size);
          } else {
            // APFS would make a truncated file sparse, so write it.
            const chunk = Buffer.alloc(64 * 1048576);
            for (let written = 0; written < size;) {
              const n = Math.min(chunk.length, size - written);
              await fh.write(chunk, 0, n);
              written += n;
            }
          }
        } catch (err) {
          await fh.close();
          await rm(file, { force: true });
          throw err;
        }
        await fh.close();
        return { journal: [{ op: 'rm', path: file }] };
      });
    },
  };

  // ── Randomized soak ───────────────────────────────────────────────────────

  /**
   * Injects faults from `faults` at seeded random times for `durationMs`,
   * one at a time, each for a random length, then calls `invariant` after
   * every restore. The seed replays the exact same sequence.
   */
  async random(opts: {
    faults: Record<string, () => Promise<Fault>>;
    durationMs: number;
    gapMs?: [number, number];
    faultMs?: [number, number];
    invariant?: (after: string) => Promise<void>;
  }): Promise<{ seed: number; events: { at: number; fault: string; forMs: number }[] }> {
    const names = Object.keys(opts.faults);
    if (!names.length) throw new Error('chaos.random needs at least one fault');
    const [gmin, gmax] = opts.gapMs ?? [5_000, 30_000];
    const [fmin, fmax] = opts.faultMs ?? [5_000, 30_000];
    const end = Date.now() + opts.durationMs;
    const events: { at: number; fault: string; forMs: number }[] = [];
    while (Date.now() < end) {
      await sleep(Math.min(this.rng.int(gmin, gmax), Math.max(0, end - Date.now())));
      if (Date.now() >= end) break;
      const name = this.rng.pick(names);
      const forMs = Math.min(this.rng.int(fmin, fmax), Math.max(1000, end - Date.now()));
      const f = await opts.faults[name]();
      events.push({ at: Date.now(), fault: name, forMs });
      await sleep(forMs);
      await f.restore();
      await opts.invariant?.(name);
    }
    return { seed: this.rng.seed, events };
  }
}
