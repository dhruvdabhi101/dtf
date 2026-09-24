import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { join, resolve, relative, dirname, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';

import { loadConfig, DEFAULTS, type ResolvedConfig } from '../runner/config.ts';
import { isPlatformSupported } from '../drivers/index.ts';
import { runDoctor } from '../doctor.ts';
import { generateSpec, appendToSpec } from '../recorder/codegen.ts';
import { importSpecifierFor } from '../recorder/project.ts';
import type { StepInput } from '../recorder/steps.ts';
import { RunManager, type RunRequest } from './runs.ts';
import { LiveManager } from './live.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, 'ui');
const CLI = join(HERE, '..', 'cli.ts');
const PKG_VERSION = (JSON.parse(await readFile(join(HERE, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

export type StudioOptions = {
  cwd: string;
  port?: number;
  host?: string;
  open?: boolean;
  /** Called with the URL once listening (tests use this instead of opening a browser). */
  onListening?: (url: string) => void;
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** True when `child` is `parent` or inside it. Guards every path taken from a request. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function readBody(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  execFile(cmd, args as string[], () => {});
}

/**
 * dtf Studio: a local web UI for running, recording and inspecting tests.
 *
 * It is a plain HTTP server bound to loopback, serving a static single-page UI
 * and a small JSON API, with live updates over Server-Sent Events. Nothing in
 * it is platform-specific — everything OS-facing goes through the same Driver
 * the CLI uses — so the Studio works on any platform that has a driver.
 *
 * The API can launch apps, write files and run code, so it is locked down the
 * way a local dev server should be: loopback only, a Host-header check against
 * DNS rebinding, and a per-launch token on every API call.
 */
export async function startStudio(opts: StudioOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const cwd = resolve(opts.cwd);
  const host = opts.host ?? '127.0.0.1';
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);

  let config: ResolvedConfig = await loadConfig(cwd).catch(() => ({ ...DEFAULTS }));
  const artifactsDir = () => resolve(cwd, config.artifactsDir ?? DEFAULTS.artifactsDir);
  const runs = new RunManager(cwd, join(artifactsDir(), '.studio', 'runs'));
  const live = new LiveManager();

  // ── Server-sent events ──────────────────────────────────────────────────
  const clients = new Set<ServerResponse>();
  const broadcast = (type: string, data: unknown) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };
  runs.on('event', (e) => broadcast('run', e));
  live.on('event', (e) => broadcast('live', e));
  const heartbeat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20_000);

  const projectInfo = async () => {
    config = await loadConfig(cwd).catch(() => config);
    let name = cwd.split(sep).pop() ?? 'project';
    try { name = (JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { name?: string }).name ?? name; } catch { /* no package.json */ }
    return {
      name,
      cwd,
      version: PKG_VERSION,
      platform: process.platform,
      platformSupported: isPlatformSupported(),
      configFile: config.configFile ? relative(cwd, config.configFile) : undefined,
      app: config.app?.path,
      attach: config.attach,
      lifecycle: config.lifecycle,
      testMatch: config.testMatch,
      artifactsDir: relative(cwd, artifactsDir()) || '.',
    };
  };

  /** Resolves a project-relative path from a request, refusing anything outside the project. */
  const projectPath = (p: unknown): string => {
    if (typeof p !== 'string' || !p) throw new HttpError(400, 'missing path');
    const abs = resolve(cwd, p);
    if (!within(cwd, abs)) throw new HttpError(403, 'path is outside the project');
    if (abs.split(sep).includes('node_modules')) throw new HttpError(403, 'refusing to touch node_modules');
    return abs;
  };

  const listTests = () => new Promise<unknown>((resolveList, reject) => {
    // Collected in a child so importing user test files never touches the
    // Studio's own module graph.
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'list', '--json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new HttpError(500, err.trim() || `dtf list exited with ${code}`));
      try { resolveList(JSON.parse(out)); } catch { reject(new HttpError(500, `could not parse test list: ${out.slice(0, 200)}`)); }
    });
  });

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<unknown> => {
    const m = req.method ?? 'GET';
    const p = url.pathname;
    const body = m === 'POST' || m === 'PUT' || m === 'PATCH' ? ((await readBody(req)) as Record<string, unknown>) : {};
    let match: RegExpMatchArray | null;

    // Project & environment
    if (m === 'GET' && p === '/api/project') return projectInfo();
    if (m === 'GET' && p === '/api/doctor') {
      return runDoctor(isPlatformSupported() ? await live.driver().catch(() => undefined) : undefined);
    }
    if (m === 'GET' && p === '/api/state') {
      return { project: await projectInfo(), run: runs.active, recorder: live.state() };
    }

    // Tests & files
    if (m === 'GET' && p === '/api/tests') {
      const [files, latest] = await Promise.all([listTests(), runs.latestResults()]);
      return { files, latest };
    }
    if (m === 'GET' && p === '/api/file') {
      const abs = projectPath(url.searchParams.get('path'));
      if (!existsSync(abs)) throw new HttpError(404, 'no such file');
      return { path: relative(cwd, abs), content: await readFile(abs, 'utf8') };
    }
    if (m === 'PUT' && p === '/api/file') {
      const abs = projectPath(body.path);
      if (!/\.(ts|mts|js|mjs)$/.test(abs)) throw new HttpError(400, 'only .ts/.js test files can be written');
      if (typeof body.content !== 'string') throw new HttpError(400, 'missing content');
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body.content);
      return { path: relative(cwd, abs) };
    }

    // Runs
    if (m === 'GET' && p === '/api/runs') return runs.list();
    if (m === 'POST' && p === '/api/runs') {
      if (live.busy) throw new HttpError(409, 'stop recording before running tests — the recorder would capture the run\'s own clicks');
      const req: RunRequest = {
        files: Array.isArray(body.files) ? (body.files as string[]).map((f) => relative(cwd, projectPath(f))) : undefined,
        grep: typeof body.grep === 'string' ? body.grep : undefined,
        line: typeof body.line === 'number' ? body.line : undefined,
        label: typeof body.label === 'string' ? body.label : undefined,
      };
      return runs.start(req);
    }
    if (m === 'POST' && p === '/api/runs/cancel') return { cancelled: runs.cancel() };
    if (m === 'GET' && (match = p.match(/^\/api\/runs\/([a-z0-9]+)$/))) {
      const r = await runs.get(match[1]);
      if (!r) throw new HttpError(404, 'no such run');
      return r;
    }

    // Apps & inspector
    if (m === 'GET' && p === '/api/apps') return live.apps();
    if (m === 'GET' && p === '/api/inspect/tree') {
      const pid = Number(url.searchParams.get('pid'));
      if (!pid) throw new HttpError(400, 'missing pid');
      return live.tree(pid, Number(url.searchParams.get('depth') ?? 8));
    }
    if (m === 'POST' && p === '/api/inspect/query') {
      if (typeof body.pid !== 'number' || typeof body.selector !== 'string') throw new HttpError(400, 'need pid and selector');
      try {
        return await live.query(body.pid, body.selector);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }
    if (m === 'POST' && p === '/api/inspect/pick') { await live.inspectPick(); return { ok: true }; }

    // Recorder
    if (m === 'GET' && p === '/api/recorder') return live.state();
    if (m === 'POST' && p === '/api/recorder/start') {
      if (runs.active) throw new HttpError(409, 'a test run is in progress');
      if (body.mode === 'attach') {
        if (typeof body.pid !== 'number') throw new HttpError(400, 'attach needs a pid');
        return live.startRecording({ pid: body.pid }, body.keepSteps === true);
      }
      config = await loadConfig(cwd).catch(() => config);
      if (!config.app?.path) throw new HttpError(400, `no app is configured for ${process.platform} in dtf.config — attach to a running app instead`);
      return live.startRecording({ launch: config.app }, body.keepSteps === true);
    }
    if (m === 'POST' && p === '/api/recorder/stop') return live.stopRecording();
    if (m === 'POST' && p === '/api/recorder/close-app') { await live.closeApp(); return live.state(); }
    if (m === 'POST' && p === '/api/recorder/pick') { await live.pick(); return { ok: true }; }
    if (m === 'POST' && p === '/api/recorder/cancel-pick') { await live.cancelPick(); return { ok: true }; }
    if (m === 'POST' && p === '/api/recorder/clear') { live.clear(); return live.state(); }
    if (m === 'POST' && p === '/api/recorder/steps') {
      return live.addStep(body.step as StepInput, typeof body.index === 'number' ? body.index : undefined);
    }
    if ((match = p.match(/^\/api\/recorder\/steps\/([\w-]+)(\/move)?$/))) {
      if (m === 'PATCH') return live.updateStep(match[1], body.patch as Partial<StepInput>);
      if (m === 'DELETE') { live.removeStep(match[1]); return { ok: true }; }
      if (m === 'POST' && match[2]) { live.moveStep(match[1], Number(body.to)); return { ok: true }; }
    }
    if ((match = p.match(/^\/api\/recorder\/suggestions\/([\w-]+)\/(accept|dismiss)$/)) && m === 'POST') {
      if (match[2] === 'accept') return live.acceptSuggestion(match[1]) ?? {};
      live.dismissSuggestion(match[1]);
      return { ok: true };
    }
    if (m === 'POST' && p === '/api/recorder/code') {
      const target = typeof body.path === 'string' && body.path ? projectPath(body.path) : join(cwd, 'tests', 'recorded.spec.ts');
      const code = generateSpec(live.steps(), {
        testName: String(body.testName || 'recorded flow'),
        describeName: typeof body.describeName === 'string' && body.describeName ? body.describeName : undefined,
        importFrom: importSpecifierFor(cwd, target),
      });
      return { code };
    }
    if (m === 'POST' && p === '/api/recorder/save') {
      const abs = projectPath(body.path);
      if (!/\.(spec|test)\.(ts|mts|js|mjs)$/.test(abs)) throw new HttpError(400, 'save to a *.spec.ts or *.test.ts file');
      const testName = String(body.testName || 'recorded flow');
      const importFrom = importSpecifierFor(cwd, abs);
      const exists = existsSync(abs);
      if (exists && body.mode !== 'append' && body.overwrite !== true) {
        throw new HttpError(409, `${relative(cwd, abs)} already exists — append to it or choose another name`);
      }
      const content = exists && body.mode === 'append'
        ? appendToSpec(await readFile(abs, 'utf8'), live.steps(), testName, importFrom)
        : generateSpec(live.steps(), {
          testName,
          describeName: typeof body.describeName === 'string' && body.describeName ? body.describeName : undefined,
          importFrom,
        });
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      return { path: relative(cwd, abs), appended: exists && body.mode === 'append' };
    }
    if (m === 'POST' && p === '/api/recorder/replay') {
      if (live.busy) throw new HttpError(409, 'stop recording before replaying');
      if (runs.active) throw new HttpError(409, 'a test run is in progress');
      const dir = join(artifactsDir(), '.studio');
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'replay.spec.ts');
      await writeFile(file, generateSpec(live.steps(), { testName: 'replay', importFrom: importSpecifierFor(cwd, file) }));
      const state = live.state();
      // An attached app is replayed against itself rather than a fresh launch.
      const attach = state.app && !state.app.launched ? { pid: state.app.pid } : undefined;
      if (state.app?.launched) await live.closeApp();
      return runs.start({ files: [relative(cwd, file)], label: 'Replay of recording', attach });
    }

    throw new HttpError(404, `no route for ${m} ${p}`);
  };

  const serveStatic = async (res: ServerResponse, file: string, injectToken = false) => {
    const ext = extname(file);
    if (injectToken) {
      const html = (await readFile(file, 'utf8')).replace('__DTF_TOKEN__', token);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    const info = await stat(file);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  };

  const checkToken = (supplied: string | null | undefined) => {
    if (!supplied) return false;
    const b = Buffer.from(supplied);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  let port = opts.port ?? 4417;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      // DNS-rebinding guard: a hostile page that resolves its own domain to
      // 127.0.0.1 still sends its own Host header.
      const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new HttpError(403, 'bad host');

      if (url.pathname === '/' || url.pathname === '/index.html') {
        await serveStatic(res, join(UI_DIR, 'index.html'), true);
        return;
      }
      if (url.pathname.startsWith('/ui/')) {
        const file = resolve(UI_DIR, `.${url.pathname.slice(3)}`);
        if (!within(UI_DIR, file) || !existsSync(file)) throw new HttpError(404, 'not found');
        await serveStatic(res, file);
        return;
      }

      const supplied = (req.headers['x-dtf-token'] as string | undefined) ?? url.searchParams.get('token');
      if (!checkToken(supplied)) throw new HttpError(401, 'missing or invalid token — reload the Studio');

      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ run: runs.active, recorder: live.state() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (url.pathname === '/artifacts') {
        // Failure screenshots, tree dumps and app logs, by absolute path.
        const file = resolve(cwd, url.searchParams.get('path') ?? '');
        if (!within(artifactsDir(), file) || !existsSync(file)) throw new HttpError(404, 'no such artifact');
        await serveStatic(res, file);
        return;
      }

      send(res, 200, await route(req, res, url));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error(`[studio] ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    const tryListen = (attemptsLeft: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0 && opts.port === undefined) {
          port += 1;
          tryListen(attemptsLeft - 1);
        } else reject(err);
      });
      server.listen(port, host, () => resolveListen());
    };
    tryListen(20);
  });

  // Read the port back: with `port: 0` the OS picks one.
  const address = server.address();
  if (address && typeof address === 'object') port = address.port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
  console.log(`\n  dtf studio ${PKG_VERSION}  ·  ${url}\n  project: ${cwd}\n  Ctrl+C to stop\n`);
  opts.onListening?.(url);
  if (opts.open) openBrowser(url);

  const close = async () => {
    clearInterval(heartbeat);
    for (const c of clients) c.end();
    await runs.dispose();
    await live.dispose();
    await new Promise<void>((r) => server.close(() => r()));
  };

  let closing = false;
  const onSignal = () => {
    if (closing) process.exit(130);
    closing = true;
    console.log('\n  shutting down…');
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { url, close };
}
