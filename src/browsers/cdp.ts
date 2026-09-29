import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A minimal Chrome DevTools Protocol connection to one page of a browser dtf
 * launched with `--remote-debugging-port=0`.
 *
 * Only what the OS-level flows need that accessibility cannot give: a
 * navigation that is guaranteed to happen (a URL on the command line sometimes
 * leaves the first tab on about:blank), and the URL of a custom-scheme
 * navigation (`myapp://callback?…`) before the browser hands it to the OS.
 */
export class CdpPage {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #listeners = new Map<string, Set<(params: any) => void>>();
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
    ws.onclose = () => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(new Error('browser connection closed'));
      this.#pending.clear();
    };
  }

  /**
   * Connects to the first page of the browser whose profile is `userDataDir`.
   * Chromium writes the port it picked to `DevToolsActivePort` there.
   */
  static async connect(userDataDir: string, timeoutMs = 15_000): Promise<CdpPage> {
    const file = join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    let port = '';
    while (!port) {
      if (existsSync(file)) port = readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim() ?? '';
      if (port) break;
      if (Date.now() > deadline) throw new Error(`the browser never opened its debugging port (${file})`);
      await new Promise((r) => setTimeout(r, 150));
    }
    let page: { type: string; webSocketDebuggerUrl?: string } | undefined;
    while (!page?.webSocketDebuggerUrl) {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []) as typeof page[];
      page = targets.find((t) => t?.type === 'page');
      if (page?.webSocketDebuggerUrl) break;
      if (Date.now() > deadline) throw new Error('the browser has no page to control');
      await new Promise((r) => setTimeout(r, 150));
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('could not connect to the browser page'));
    });
    return new CdpPage(ws);
  }

  get closed() { return this.#closed; }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('browser connection closed'));
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, fn: (params: any) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.value;
  }

  close(): void {
    this.#closed = true;
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}
