import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { EVENT_PREFIX, type RunEvent, type RunSummary, type TestResult } from '../runner/reporter.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js');

export type RunRequest = {
  files?: string[];
  grep?: string;
  line?: number;
  /** Shown in the run history, e.g. "tests/tray.spec.ts › opens the menu". */
  label?: string;
  attach?: { pid?: number };
};

export type RunRecord = {
  id: string;
  label: string;
  request: RunRequest;
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'errored';
  startedAt: number;
  finishedAt?: number;
  platform?: string;
  summary?: Omit<RunSummary, 'results'>;
  results: TestResult[];
  /** Tests currently executing (normally one). */
  current?: string;
  /** Everything the run printed that was not an event: test console output, crashes. */
  output: string[];
};

const MAX_OUTPUT_LINES = 5000;
const HISTORY_LIMIT = 50;

export type RunStreamEvent = RunEvent | { type: 'output'; line: string } | { type: 'status'; record: RunRecord };

/**
 * Runs the suite in a child process, one run at a time.
 *
 * A child rather than an in-process call because a test run imports user code:
 * a hung test, a leaked handle or a crash must not take the Studio down with
 * it, and cancelling has to be able to kill it outright.
 */
export class RunManager extends EventEmitter<{ event: [{ runId: string; event: RunStreamEvent }] }> {
  #cwd: string;
  #dir: string;
  #child: ChildProcess | null = null;
  #active: RunRecord | null = null;
  #cancelRequested = false;

  constructor(cwd: string, historyDir: string) {
    super();
    this.#cwd = cwd;
    this.#dir = historyDir;
  }

  get active(): RunRecord | null { return this.#active; }

  async start(req: RunRequest): Promise<RunRecord> {
    if (this.#active) throw Object.assign(new Error('a run is already in progress'), { status: 409 });
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const record: RunRecord = {
      id,
      label: req.label ?? (req.files?.length ? req.files.join(', ') : 'All tests'),
      request: req,
      status: 'running',
      startedAt: Date.now(),
      results: [],
      output: [],
    };
    this.#active = record;
    this.#cancelRequested = false;

    const args = ['--no-warnings', CLI, 'run', '--reporter', 'stream,junit'];
    if (req.files?.length) args.push('--file', req.files.join(','));
    if (req.grep) args.push('--grep', req.grep);
    if (req.line) args.push('--line', String(req.line));
    if (req.attach?.pid) args.push('--attach-pid', String(req.attach.pid));

    const child = spawn(process.execPath, args, {
      cwd: this.#cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      // The IPC channel carries cancellation. Signals cannot: Windows has no
      // SIGINT to deliver to another process, only termination.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.#child = child;
    const publish = (event: RunStreamEvent) => this.emit('event', { runId: id, event });

    const onLine = (line: string) => {
      if (line.startsWith(EVENT_PREFIX)) {
        let e: RunEvent;
        try { e = JSON.parse(line.slice(EVENT_PREFIX.length)) as RunEvent; } catch { return; }
        this.#apply(record, e);
        publish(e);
        return;
      }
      if (!line.trim()) return;
      record.output.push(line);
      if (record.output.length > MAX_OUTPUT_LINES) record.output.splice(0, record.output.length - MAX_OUTPUT_LINES);
      publish({ type: 'output', line });
    };
    createInterface({ input: child.stdout! }).on('line', onLine);
    createInterface({ input: child.stderr! }).on('line', onLine);

    child.on('exit', (code) => {
      record.finishedAt = Date.now();
      record.current = undefined;
      if (this.#cancelRequested) record.status = 'cancelled';
      else if (record.summary) record.status = record.summary.failed > 0 ? 'failed' : 'passed';
      else record.status = code === 0 ? 'passed' : 'errored';
      // Persist before announcing, so a client that reloads history on the
      // status event finds this run in it.
      void this.#save(record).catch(() => {}).finally(() => {
        this.#active = null;
        this.#child = null;
        publish({ type: 'status', record });
      });
    });

    publish({ type: 'status', record });
    return record;
  }

  /** Asks the run to stop after the current test; kills it if it has not within 15s. */
  cancel(): boolean {
    const child = this.#child;
    if (!child) return false;
    this.#cancelRequested = true;
    // Graceful first: the run finishes its current test and closes the app.
    try { child.send('cancel'); } catch { child.kill(); }
    setTimeout(() => { if (this.#child === child) child.kill('SIGKILL'); }, 15_000).unref();
    return true;
  }

  #apply(record: RunRecord, e: RunEvent) {
    switch (e.type) {
      case 'run-start': record.platform = e.platform; break;
      case 'test-start': record.current = e.name; break;
      case 'test-done': record.results.push(e.result); record.current = undefined; break;
      case 'run-done': {
        const { results: _r, ...rest } = e.summary;
        record.summary = rest;
        break;
      }
      case 'error': record.output.push(e.message); break;
    }
  }

  async #save(record: RunRecord) {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, `${record.id}.json`), JSON.stringify(record));
    // Keep history bounded; artifacts from pruned runs stay on disk.
    const files = (await readdir(this.#dir)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
      await unlink(join(this.#dir, f)).catch(() => {});
    }
  }

  async list(): Promise<Omit<RunRecord, 'results' | 'output'>[]> {
    const out: Omit<RunRecord, 'results' | 'output'>[] = [];
    if (this.#active) {
      const { results: _r, output: _o, ...rest } = this.#active;
      out.push(rest);
    }
    let files: string[] = [];
    try { files = (await readdir(this.#dir)).filter((f) => f.endsWith('.json')); } catch { /* no history yet */ }
    for (const f of files.sort().reverse()) {
      try {
        const { results: _r, output: _o, ...rest } = JSON.parse(await readFile(join(this.#dir, f), 'utf8')) as RunRecord;
        out.push(rest);
      } catch { /* skip unreadable */ }
    }
    return out;
  }

  async get(id: string): Promise<RunRecord | undefined> {
    if (this.#active?.id === id) return this.#active;
    if (!/^[a-z0-9]+$/.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.#dir, `${id}.json`), 'utf8')) as RunRecord;
    } catch {
      return undefined;
    }
  }

  /** The latest result for every test, across history — drives the explorer's status dots. */
  async latestResults(): Promise<Record<string, TestResult['status']>> {
    const out: Record<string, TestResult['status']> = {};
    const runs = await this.list();
    for (const r of [...runs].reverse()) {
      const full = await this.get(r.id);
      for (const t of full?.results ?? []) out[`${t.file}::${t.name}`] = t.status;
    }
    return out;
  }

  async dispose() {
    this.cancel();
  }
}
