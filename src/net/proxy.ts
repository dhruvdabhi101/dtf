import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';

import { Rng } from '../core/random.ts';

/**
 * A local HTTP(S) proxy the app under test is launched through.
 *
 * It does two jobs. It measures: bytes and connections per host, which is the
 * only per-app network figure Windows gives without administrator rights. And
 * it breaks things on demand: offline, latency, jitter, bandwidth limits,
 * dropped connections, DNS failures and stalled TLS handshakes. Everything is
 * scoped to the app (other programs are untouched), needs no elevation, works
 * the same on every OS, and cannot outlive the test run.
 *
 * HTTPS is tunnelled (CONNECT) and never decrypted, so certificates and
 * pinning are unaffected; shaping works on the encrypted stream.
 *
 * Coverage caveat: traffic that ignores proxy settings bypasses it. Chromium
 * honours `--proxy-server`; Node, Rust (reqwest) and Go clients usually honour
 * HTTPS_PROXY. Anything else needs an OS-level fault instead (firewall, Wi-Fi).
 */

export type HostPattern = string | RegExp;

export type NetConditions = {
  /** `refuse` answers 502, `reset` drops the socket, `hang` never answers. Existing connections are cut. */
  offline?: false | 'refuse' | 'reset' | 'hang';
  /** Added round-trip time, ms. Half is applied each way, and all of it to connection setup. */
  latencyMs?: number;
  /** Random extra delay per chunk, 0..jitterMs. */
  jitterMs?: number;
  /** Bandwidth caps shared by all of the app's connections, kilobits per second. */
  downKbps?: number;
  upKbps?: number;
  /** Chance (0–100) that a new connection is cut at a random point in its first 5 s. */
  lossPercent?: number;
  /** Hosts whose lookup "fails": the proxy answers as if DNS had no record. */
  failHosts?: HostPattern[];
  /** Hosts whose connection is accepted and then never forwarded: a stalled TLS handshake. */
  stallHosts?: HostPattern[];
  /** Apply latency, bandwidth, loss and offline only to these hosts. All hosts when omitted. */
  hosts?: HostPattern[];
};

export type HostStats = { connections: number; bytesUp: number; bytesDown: number; errors: number };
export type ProxyTotals = HostStats & { at: number };

const matches = (host: string, pats: HostPattern[] | undefined) =>
  !!pats?.some((p) => (typeof p === 'string' ? host === p || host.endsWith(`.${p}`) : p.test(host)));

export class NetworkProxy {
  #server: Server | null = null;
  #port = 0;
  #cond: NetConditions = {};
  #sockets = new Set<Socket>();
  #hosts = new Map<string, HostStats>();
  #nextFree = { up: 0, down: 0 };
  #rng = new Rng(0x5eed);

  get port() { return this.#port; }
  get url() { return `http://127.0.0.1:${this.#port}`; }
  get conditions(): Readonly<NetConditions> { return this.#cond; }

  async start(port = 0): Promise<this> {
    const server = createServer((req, res) => this.#onRequest(req, res));
    server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => this.#onConnect(req, socket, head));
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    this.#server = server;
    this.#port = (server.address() as { port: number }).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Chromium switches that send an Electron app's traffic through the proxy.
   * Loopback is bypassed by Chromium's defaults, so the app's own local
   * services keep working.
   */
  launchArgs(): string[] {
    return [`--proxy-server=${this.url}`];
  }

  /** Environment for the app's non-Chromium clients (Node, Rust, Go sidecars). */
  launchEnv(): Record<string, string> {
    const u = this.url;
    return { HTTP_PROXY: u, HTTPS_PROXY: u, http_proxy: u, https_proxy: u, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
  }

  /** Replaces the conditions. Going offline cuts every open connection, as losing the network would. */
  set(cond: NetConditions): void {
    const wasOffline = !!this.#cond.offline;
    this.#cond = { ...cond };
    if (cond.offline && !wasOffline) {
      for (const s of this.#sockets) {
        const host = (s as Socket & { dtfHost?: string }).dtfHost;
        if (!cond.hosts || (host && matches(host, cond.hosts))) s.destroy();
      }
    }
  }

  /** Merges into the current conditions. */
  update(cond: NetConditions): void {
    this.set({ ...this.#cond, ...cond });
  }

  reset(): void {
    this.#cond = {};
  }

  hosts(): Record<string, HostStats> {
    return Object.fromEntries([...this.#hosts].map(([h, s]) => [h, { ...s }]));
  }

  totals(): ProxyTotals {
    const t: ProxyTotals = { connections: 0, bytesUp: 0, bytesDown: 0, errors: 0, at: Date.now() };
    for (const s of this.#hosts.values()) {
      t.connections += s.connections; t.bytesUp += s.bytesUp; t.bytesDown += s.bytesDown; t.errors += s.errors;
    }
    return t;
  }

  #stats(host: string): HostStats {
    let s = this.#hosts.get(host);
    if (!s) this.#hosts.set(host, (s = { connections: 0, bytesUp: 0, bytesDown: 0, errors: 0 }));
    return s;
  }

  #applies(host: string) {
    return !this.#cond.hosts || matches(host, this.#cond.hosts);
  }

  /** How a new connection to `host` is treated before it is forwarded, if it is not. */
  #gate(host: string): 'dns' | 'stall' | 'refuse' | 'reset' | 'hang' | undefined {
    if (matches(host, this.#cond.failHosts)) return 'dns';
    if (matches(host, this.#cond.stallHosts)) return 'stall';
    if (this.#cond.offline && this.#applies(host)) return this.#cond.offline;
    return undefined;
  }

  #track(s: Socket, host: string) {
    (s as Socket & { dtfHost?: string }).dtfHost = host;
    this.#sockets.add(s);
    s.once('close', () => this.#sockets.delete(s));
  }

  #shaper(dir: 'up' | 'down', host: string): Transform {
    const stats = this.#stats(host);
    const proxy = this;
    let last = 0;
    let pending = 0;
    let flushCb: TransformCallback | null = null;
    return new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (dir === 'up') stats.bytesUp += chunk.length; else stats.bytesDown += chunk.length;
        const c = proxy.#applies(host) ? proxy.#cond : {};
        const kbps = dir === 'up' ? c.upKbps : c.downKbps;
        if (!c.latencyMs && !c.jitterMs && !kbps) {
          cb(null, chunk);
          return;
        }
        const now = Date.now();
        let at = now + (c.latencyMs ?? 0) / 2 + (c.jitterMs ? proxy.#rng.next() * c.jitterMs : 0);
        if (kbps) {
          // Delivered once the link has had time to carry it: kbit/s = bits per ms.
          at = Math.max(at, proxy.#nextFree[dir]) + (chunk.length * 8) / kbps;
          proxy.#nextFree[dir] = at;
        }
        at = Math.max(at, last); // never reorder a stream
        last = at;
        pending++;
        setTimeout(() => {
          this.push(chunk);
          if (--pending === 0 && flushCb) flushCb();
        }, at - now);
        cb();
      },
      flush(cb) {
        if (pending === 0) cb(); else flushCb = cb;
      },
    });
  }

  #maybeLose(sockets: Socket[], host: string) {
    const p = this.#applies(host) ? this.#cond.lossPercent ?? 0 : 0;
    if (p > 0 && this.#rng.next() * 100 < p) {
      setTimeout(() => { this.#stats(host).errors++; for (const s of sockets) s.destroy(); }, this.#rng.int(0, 5000)).unref();
    }
  }

  #onConnect(req: IncomingMessage, client: Socket, head: Buffer) {
    const [host, portStr] = splitHostPort(req.url ?? '');
    const port = Number(portStr) || 443;
    const stats = this.#stats(host);
    stats.connections++;
    this.#track(client, host);
    client.on('error', () => {});

    const gate = this.#gate(host);
    if (gate) {
      if (gate !== 'stall') stats.errors++;
      if (gate === 'dns') { client.end('HTTP/1.1 502 Bad Gateway\r\nX-Dtf-Fault: dns\r\nContent-Length: 0\r\n\r\n'); return; }
      if (gate === 'refuse') { client.end('HTTP/1.1 502 Bad Gateway\r\nX-Dtf-Fault: offline\r\nContent-Length: 0\r\n\r\n'); return; }
      if (gate === 'reset') { client.destroy(); return; }
      if (gate === 'stall') { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); return; }
      return; // hang: say nothing
    }

    const setup = this.#applies(host) ? this.#cond.latencyMs ?? 0 : 0;
    setTimeout(() => {
      if (client.destroyed) return;
      const upstream = connect(port, host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(this.#shaper('up', host)).pipe(upstream);
        upstream.pipe(this.#shaper('down', host)).pipe(client);
      });
      this.#track(upstream, host);
      upstream.on('error', () => {
        stats.errors++;
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      });
      // A clean end travels through the pipes, after any delayed chunks; only
      // an error tears the other side down at once.
      client.on('close', (hadError) => { if (hadError || !client.readableEnded) upstream.destroy(); });
      upstream.on('close', (hadError) => { if (hadError) client.destroy(); });
      this.#maybeLose([client, upstream], host);
    }, setup);
  }

  #onRequest(req: IncomingMessage, res: ServerResponse) {
    let target: URL;
    try { target = new URL(req.url ?? ''); } catch { res.writeHead(400).end(); return; }
    const host = target.hostname;
    const stats = this.#stats(host);
    stats.connections++;
    const gate = this.#gate(host);
    if (gate && gate !== 'stall') {
      stats.errors++;
      if (gate === 'reset') { req.socket.destroy(); return; }
      if (gate === 'hang') return;
      res.writeHead(502, { 'X-Dtf-Fault': gate === 'dns' ? 'dns' : 'offline' }).end();
      return;
    }
    if (gate === 'stall') return;
    this.#track(req.socket, host);
    const setup = this.#applies(host) ? this.#cond.latencyMs ?? 0 : 0;
    setTimeout(() => {
      const up = httpRequest({
        host, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: req.headers,
      }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(this.#shaper('down', host)).pipe(res);
      });
      up.on('error', () => { stats.errors++; if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(this.#shaper('up', host)).pipe(up);
    }, setup);
  }
}

function splitHostPort(s: string): [string, string] {
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return [s.slice(1, end), s.slice(end + 2)];
  }
  const i = s.lastIndexOf(':');
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** Named network conditions, roughly matching Chrome DevTools' throttling presets. */
export const NETWORK_PROFILES = {
  'slow-3g': { latencyMs: 400, jitterMs: 100, downKbps: 400, upKbps: 400 },
  '3g': { latencyMs: 300, jitterMs: 80, downKbps: 1600, upKbps: 750 },
  'edge': { latencyMs: 850, jitterMs: 150, downKbps: 240, upKbps: 200 },
  'satellite': { latencyMs: 700, jitterMs: 50, downKbps: 5000, upKbps: 1000 },
  'lossy': { lossPercent: 10 },
  'flaky': { latencyMs: 150, jitterMs: 300, lossPercent: 3 },
  'extreme-latency': { latencyMs: 3000, jitterMs: 1000 },
} satisfies Record<string, NetConditions>;

export type NetworkProfile = keyof typeof NETWORK_PROFILES;
