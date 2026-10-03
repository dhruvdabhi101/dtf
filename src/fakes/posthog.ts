import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { waitFor, sleep } from '../core/wait.ts';
import { AssertionError } from '../core/errors.ts';

/** One analytics event, as the app sent it, whichever endpoint it came through. */
export type CapturedEvent = {
  /** Position in the server's event list; pass a `cursor()` as `since` to ignore earlier ones. */
  seq: number;
  event: string;
  distinctId?: string;
  properties: Record<string, unknown>;
  timestamp?: string;
  uuid?: string;
  apiKey?: string;
  /** The request path it arrived on, e.g. `/batch/` or `/capture/`. */
  path: string;
  receivedAt: number;
};

/** Every request the server saw, events or not. The thing to read when an event never shows up. */
export type CapturedRequest = {
  method: string;
  path: string;
  status: number;
  events: number;
  at: number;
  /** Why the body could not be read as events, when it could not. */
  error?: string;
};

/**
 * Which events to match: a name, a name pattern, or a fuller query.
 * `properties` values match by equality, or by `test()` for a RegExp.
 */
export type EventQuery =
  | string
  | RegExp
  | {
    event?: string | RegExp;
    distinctId?: string;
    properties?: Record<string, unknown>;
    where?: (e: CapturedEvent) => boolean;
  };

export type FlagValue = boolean | string;

export type PostHogServerOptions = {
  /** Default 0: any free port. A build with the host baked in needs that exact port. */
  port?: number;
  /** Default 127.0.0.1. Only bind wider if the app really runs on another machine. */
  host?: string;
  /** Feature flags answered on `/flags` and `/decide`. Everything else is off. */
  flags?: Record<string, FlagValue>;
  /** Append each event to this file as one JSON line, as it arrives. Truncated on start. */
  logFile?: string;
};

const MAX_BODY = 20 * 1024 * 1024;

/**
 * A stand-in for PostHog's ingestion API, for tests.
 *
 * Point the app's PostHog host at `url` and its analytics land here instead of
 * in a real project: nothing from CI pollutes production numbers, and the
 * events become something a test can assert on. Covers what the official
 * SDKs send: `/batch/` (posthog-node, gzipped by default), `/capture/`, `/e/`
 * and `/i/v0/e/` (posthog-js, plain, gzip or base64), plus `/flags` and
 * `/decide` so an SDK that asks for feature flags gets an answer instead of
 * logging an error. Any other request gets a 200, so an app's health probe of
 * its analytics host passes.
 */
export class PostHogServer {
  #server: Server;
  #events: CapturedEvent[] = [];
  #requests: CapturedRequest[] = [];
  #flags: Record<string, FlagValue>;
  #logFile: string | undefined;
  #listeners = new Set<(e: CapturedEvent) => void>();

  private constructor(server: Server, opts: PostHogServerOptions) {
    this.#server = server;
    this.#flags = { ...(opts.flags ?? {}) };
    this.#logFile = opts.logFile;
  }

  static async start(opts: PostHogServerOptions = {}): Promise<PostHogServer> {
    // The handler needs the instance and the instance needs the server, so
    // the handler is attached after construction.
    const server = createServer();
    const ph = new PostHogServer(server, opts);
    server.on('request', (req, res) => { void ph.#handle(req, res); });
    if (opts.logFile) writeFileSync(opts.logFile, '');
    const host = opts.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`cannot start the PostHog stand-in: ${host}:${opts.port} is already in use (is \`dtf posthog\` or another run still going?)`)
          : err);
      });
      server.listen(opts.port ?? 0, host, () => resolve());
    });
    return ph;
  }

  get port(): number { return (this.#server.address() as AddressInfo).port; }

  /** What to set the app's PostHog host to. */
  get url(): string {
    const { address, port } = this.#server.address() as AddressInfo;
    return `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
  }

  get events(): CapturedEvent[] { return [...this.#events]; }
  get requests(): CapturedRequest[] { return [...this.#requests]; }

  /** A marker for "every event so far", for `since`. Same idea as `app.logCursor()`. */
  cursor(): number { return this.#events.length; }

  clear(): void {
    this.#events = [];
    this.#requests = [];
  }

  /** Replaces the feature flags answered from now on. */
  setFlags(flags: Record<string, FlagValue>): void {
    this.#flags = { ...flags };
  }

  /** Called for every event as it arrives. Returns an unsubscribe function. */
  onEvent(fn: (e: CapturedEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  find(query: EventQuery, opts: { since?: number } = {}): CapturedEvent[] {
    return this.#events.slice(opts.since ?? 0).filter((e) => matches(e, query));
  }

  /** Resolves with the first matching event, waiting for it if it has not arrived. */
  async waitForEvent(query: EventQuery, opts: { since?: number; timeoutMs?: number } = {}): Promise<CapturedEvent> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    try {
      return await waitFor(async () => this.find(query, opts)[0], { timeoutMs, intervalMs: 100 });
    } catch {
      throw new AssertionError(
        `no analytics event matching ${describe(query)} within ${timeoutMs}ms.\n${this.#seen(opts.since)}`,
        describe(query),
      );
    }
  }

  /**
   * Fails if a matching event arrives. With `withinMs`, waits that long first,
   * which is what makes a negative check mean anything: SDKs batch and flush on
   * a timer (posthog-node every 10 s by default), so "not yet" is not "never".
   */
  async shouldNotHaveEvent(query: EventQuery, opts: { since?: number; withinMs?: number } = {}): Promise<void> {
    if (opts.withinMs) await sleep(opts.withinMs);
    const hit = this.find(query, opts)[0];
    if (hit) {
      throw new AssertionError(
        `expected no analytics event matching ${describe(query)}, but got '${hit.event}' ${JSON.stringify(hit.properties)}`,
      );
    }
  }

  /** A short listing of what did arrive, for failure messages. */
  #seen(since = 0): string {
    const events = this.#events.slice(since);
    const failed = this.#requests.filter((r) => r.error);
    const lines = [
      events.length
        ? `events received (${events.length}): ${events.slice(-30).map((e) => e.event).join(', ')}`
        : `no events received${this.#requests.length ? '' : ', and no requests at all: is the app pointed at ' + this.url + '?'}`,
    ];
    if (failed.length) lines.push(`unreadable requests: ${failed.slice(-5).map((r) => `${r.method} ${r.path}: ${r.error}`).join('; ')}`);
    return lines.join('\n');
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    const record: CapturedRequest = { method: req.method ?? 'GET', path: url.pathname, status: 200, events: 0, at: Date.now() };
    this.#requests.push(record);

    // posthog-js runs in a renderer, whose origin is never this server's.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204, '');

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      record.status = 413;
      record.error = (err as Error).message;
      return send(res, 413, { error: record.error });
    }

    if (/^\/(flags|decide)\//.test(path)) return send(res, 200, this.#flagsResponse());
    if (path.startsWith('/api/feature_flag/local_evaluation/')) {
      return send(res, 200, { flags: [], group_type_mapping: {}, cohorts: {} });
    }
    if (path.startsWith('/api/surveys/')) return send(res, 200, { surveys: [] });
    if (req.method !== 'POST' || body.length === 0) return send(res, 200, { status: 1 });

    try {
      const payload = decode(body, req, url);
      const now = Date.now();
      for (const raw of eventsIn(payload)) {
        const e = normalise(raw, payload, url.pathname, this.#events.length, now);
        if (!e) continue;
        this.#events.push(e);
        record.events++;
        if (this.#logFile) appendFileSync(this.#logFile, `${JSON.stringify(e)}\n`);
        for (const fn of this.#listeners) fn(e);
      }
    } catch (err) {
      // Still a 200: a real SDK retrying a body we cannot read only adds noise.
      record.error = (err as Error).message;
    }
    send(res, 200, { status: 1 });
  }

  #flagsResponse() {
    const flags = Object.fromEntries(Object.entries(this.#flags).map(([key, value]) => [key, {
      key,
      enabled: value !== false,
      variant: typeof value === 'string' ? value : undefined,
      reason: { code: 'condition_match', description: 'set by dtf', condition_index: 0 },
      metadata: { id: 0, version: 1 },
    }]));
    return {
      // `/flags?v=2` (current SDKs) …
      flags,
      errorsWhileComputingFlags: false,
      requestId: randomUUID(),
      // … and the `/decide` shape older ones read.
      featureFlags: { ...this.#flags },
      featureFlagPayloads: {},
    };
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, typeof body === 'string' ? {} : { 'Content-Type': 'application/json' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error(`body over ${MAX_BODY} bytes`));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Turns a request body into JSON, however the SDK packed it: gzip by header
 * (posthog-node) or by `?compression=gzip-js` (posthog-js), base64 in a
 * `data=` form field (older posthog-js), or plain.
 */
export function decode(body: Buffer, req: Pick<IncomingMessage, 'headers'>, url: URL): unknown {
  const compression = url.searchParams.get('compression') ?? '';
  const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
  let buf = body;
  if (encoding === 'gzip' || compression === 'gzip-js' || compression === 'gzip' || isGzip(buf)) buf = gunzipSync(buf);
  if (compression === 'lz64') throw new Error('lz64-compressed body: set the SDK\'s compression to gzip, or disable it');

  let text = buf.toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/x-www-form-urlencoded') || /^data=/.test(text)) {
    const data = new URLSearchParams(text).get('data');
    if (data === null) throw new Error('form body without a data field');
    text = compression === 'base64' || !/^\s*[[{]/.test(data) ? Buffer.from(data, 'base64').toString('utf8') : data;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`body is not JSON: ${JSON.stringify(text.slice(0, 80))}`);
  }
}

const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

function eventsIn(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.batch)) return p.batch;
    if (Array.isArray(p.data)) return p.data;
    return [payload];
  }
  return [];
}

function normalise(raw: unknown, payload: unknown, path: string, seq: number, receivedAt: number): CapturedEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.event !== 'string') return undefined;
  const properties = (r.properties && typeof r.properties === 'object' ? r.properties : {}) as Record<string, unknown>;
  const outer = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const str = (...vs: unknown[]) => vs.find((v): v is string => typeof v === 'string' && v.length > 0);
  return {
    seq,
    event: r.event,
    distinctId: str(r.distinct_id, properties.distinct_id, r.distinctId),
    properties,
    timestamp: str(r.timestamp),
    uuid: str(r.uuid),
    apiKey: str(r.api_key, outer.api_key, properties.token, r.token),
    path,
    receivedAt,
  };
}

export function matches(e: CapturedEvent, query: EventQuery): boolean {
  if (typeof query === 'string') return e.event === query;
  if (query instanceof RegExp) return query.test(e.event);
  if (query.event !== undefined && !(typeof query.event === 'string' ? e.event === query.event : query.event.test(e.event))) return false;
  if (query.distinctId !== undefined && e.distinctId !== query.distinctId) return false;
  for (const [k, want] of Object.entries(query.properties ?? {})) {
    const got = e.properties[k];
    if (want instanceof RegExp ? !want.test(String(got)) : JSON.stringify(got) !== JSON.stringify(want)) return false;
  }
  return query.where ? query.where(e) : true;
}

function describe(q: EventQuery): string {
  if (typeof q === 'string') return `'${q}'`;
  if (q instanceof RegExp) return String(q);
  const parts: string[] = [];
  if (q.event !== undefined) parts.push(`event ${typeof q.event === 'string' ? `'${q.event}'` : q.event}`);
  if (q.distinctId) parts.push(`distinct_id '${q.distinctId}'`);
  if (q.properties) parts.push(`properties ${JSON.stringify(q.properties, (_, v) => (v instanceof RegExp ? String(v) : v))}`);
  if (q.where) parts.push('a custom condition');
  return parts.join(', ') || 'anything';
}
