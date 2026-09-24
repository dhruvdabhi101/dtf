import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { DriverError } from './errors.ts';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  op: string;
  timer: NodeJS.Timeout;
};

export type RpcOptions = {
  /** Per-call ceiling. Native ops are fast; a hang means the UI is wedged. */
  defaultTimeoutMs?: number;
  onStderr?: (line: string) => void;
};

/** An unsolicited message from the helper, e.g. a recorded user action. */
export type HelperEvent = { event: string; data?: unknown; [k: string]: unknown };

/**
 * Newline-delimited JSON-RPC over a long-lived native helper process.
 *
 * One helper is shared by the whole run. Keeping it alive matters: element refs
 * are only meaningful inside the helper's memory, so restarting it invalidates
 * every handle a test is holding.
 */
export class NativeHelper {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #rl: Interface | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #ready: Promise<void> | null = null;
  #readySignal: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  #exePath: string;
  #opts: Required<Pick<RpcOptions, 'defaultTimeoutMs'>> & RpcOptions;

  #listeners = new Set<(e: HelperEvent) => void>();

  /** Set once the helper announces itself, so callers can surface a clear error. */
  trusted = false;
  /** What the helper reported in its `ready` event. */
  info: { version?: string; platform?: string; protocol?: number } = {};

  constructor(exePath: string, opts: RpcOptions = {}) {
    this.#exePath = exePath;
    this.#opts = { defaultTimeoutMs: 30_000, ...opts };
  }

  async start(): Promise<void> {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readySignal = { resolve, reject };
    });

    const proc = spawn(this.#exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#proc = proc;

    proc.on('error', (err) => this.#failAll(err));
    proc.on('exit', (code, signal) => {
      this.#failAll(new Error(`native helper exited (code=${code} signal=${signal})`));
      // Let the next call respawn it rather than failing forever. Refs held by
      // callers are gone either way; they surface as staleRef and get re-queried.
      if (this.#proc === proc) {
        this.#proc = null;
        this.#ready = null;
      }
    });

    createInterface({ input: proc.stderr }).on('line', (line) => {
      this.#opts.onStderr?.(line);
    });

    this.#rl = createInterface({ input: proc.stdout });
    this.#rl.on('line', (line) => this.#onLine(line));

    return this.#ready;
  }

  #onLine(line: string) {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#opts.onStderr?.(`unparseable helper output: ${line.slice(0, 200)}`);
      return;
    }

    if (msg.event === 'ready') {
      this.trusted = msg.trusted === true;
      this.info = {
        version: msg.version as string | undefined,
        platform: msg.platform as string | undefined,
        protocol: msg.protocol as number | undefined,
      };
      this.#readySignal?.resolve();
      return;
    }

    // Anything else carrying `event` and no `id` is pushed by the helper on its
    // own schedule (the recorder does this) rather than answering a call.
    if (typeof msg.event === 'string' && msg.id === undefined) {
      for (const fn of this.#listeners) {
        try { fn(msg as HelperEvent); } catch (err) { this.#opts.onStderr?.(`event listener threw: ${err}`); }
      }
      return;
    }

    const id = msg.id as number;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    if (msg.ok === true) {
      pending.resolve(msg.result);
    } else {
      const err = (msg.error ?? {}) as { code?: string; message?: string };
      pending.reject(new DriverError(err.code ?? 'unknown', err.message ?? 'native driver error', pending.op));
    }
  }

  #failAll(err: unknown) {
    this.#readySignal?.reject(err);
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.start();
    const proc = this.#proc;
    if (!proc || proc.killed) throw new Error('native helper is not running');

    const id = this.#nextId++;
    const ms = timeoutMs ?? this.#opts.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`native op '${op}' did not respond within ${ms}ms`));
      }, ms);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, op, timer });
      proc.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  /** Subscribes to unsolicited helper events. Returns an unsubscribe function. */
  onEvent(fn: (e: HelperEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Drops the helper's element-ref table. Cheap; call between test cases. */
  async gc(): Promise<void> {
    await this.call('gc').catch(() => {});
  }

  async stop(): Promise<void> {
    if (!this.#proc) return;
    await this.call('shutdown').catch(() => {});
    this.#rl?.close();
    this.#proc.kill();
    this.#proc = null;
    this.#ready = null;
  }
}
