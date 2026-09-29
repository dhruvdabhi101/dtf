import { glob, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { Driver } from '../drivers/driver.ts';
import { createDriver } from '../drivers/index.ts';
import { DesktopApp, appIdentity } from '../app.ts';
import { sleep } from '../core/wait.ts';
import { UnsupportedError } from '../core/errors.ts';
import {
  rootSuite, resetRegistry, setCurrentFile, hasOnly,
  type SuiteNode, type TestCase, type TestContext,
} from './registry.ts';
import { DEFAULTS, loadConfig, type DTFConfig, type ResolvedConfig } from './config.ts';
import {
  createReporters, serializeError,
  type Reporter, type RunEvent, type TestResult, type RunSummary,
} from './reporter.ts';

export { createDriver };

function flatten(suite: SuiteNode, chain: SuiteNode[] = []): { test: TestCase; chain: SuiteNode[] }[] {
  const here = [...chain, suite];
  return [
    ...suite.tests.map((test) => ({ test, chain: here })),
    ...suite.children.flatMap((c) => flatten(c, here)),
  ];
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded its ${ms}ms timeout`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

const safeName = (s: string) => s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 120);

export type RunOptions = {
  cwd?: string;
  dir?: string;
  /** Only run tests whose full name contains this (case-insensitive). */
  grep?: string;
  /** Only run these files (absolute or relative to cwd), whether or not they match `testMatch`. */
  files?: string[];
  /** Only run the test declared on this line (requires exactly one file). */
  line?: number;
  configOverrides?: Partial<DTFConfig>;
  /** Extra listeners on top of the configured reporters. */
  onEvent?: (e: RunEvent) => void;
  /** Aborting stops the run after the current test and tears the app down. */
  signal?: AbortSignal;
};

/** Finds test files the same way a run does, without importing them. */
export async function findTestFiles(cwd: string, cfg: ResolvedConfig, dir?: string, only?: string[]): Promise<string[]> {
  // Files named explicitly run even when they fall outside `testMatch`: asking
  // for a file by path is unambiguous, and silently running nothing is not.
  if (only?.length) return [...new Set(only.map((o) => resolve(cwd, o)))].filter((f) => existsSync(f)).sort();
  const searchRoot = dir ? resolve(cwd, dir) : cwd;
  // Glob from the project root and then narrow to the requested directory.
  // Matching inside `searchRoot` instead would silently find nothing whenever a
  // pattern is written root-relative (`tests/**/*.spec.ts`) and the user also
  // passes that directory on the command line.
  const files: string[] = [];
  for (const root of new Set([cwd, searchRoot])) {
    for (const pattern of cfg.testMatch ?? DEFAULTS.testMatch) {
      for await (const f of glob(pattern, { cwd: root })) {
        const abs = resolve(root, f);
        if (abs.includes(`${sep}node_modules${sep}`)) continue;
        if (abs !== searchRoot && !abs.startsWith(searchRoot + sep)) continue;
        if (!files.includes(abs)) files.push(abs);
      }
    }
  }
  return files.sort();
}

export type CollectedFile = {
  file: string;
  error?: string;
  tests: { name: string; fullName: string; line?: number; skip: boolean; only: boolean }[];
};

/**
 * Imports each test file and reports what it declares, without launching
 * anything or touching the OS. Used by `dtf list` and the Studio test explorer.
 */
export async function collectTests(opts: { cwd?: string; dir?: string } = {}): Promise<CollectedFile[]> {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = await loadConfig(cwd, opts.dir ? resolve(cwd, opts.dir) : cwd);
  const files = await findTestFiles(cwd, cfg, opts.dir);
  const out: CollectedFile[] = [];
  for (const file of files) {
    resetRegistry();
    setCurrentFile(file);
    try {
      await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      out.push({
        file,
        tests: flatten(rootSuite).map(({ test }) => ({
          name: test.name, fullName: test.fullName, line: test.line, skip: test.skip, only: test.only,
        })),
      });
    } catch (err) {
      out.push({ file, error: err instanceof Error ? err.message : String(err), tests: [] });
    }
  }
  resetRegistry();
  return out;
}

export async function runTests(opts: RunOptions = {}): Promise<RunSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const searchRoot = opts.dir ? resolve(cwd, opts.dir) : cwd;
  const loaded = await loadConfig(cwd, searchRoot);
  const cfg: ResolvedConfig = { ...DEFAULTS, ...loaded, ...(opts.configOverrides as Partial<ResolvedConfig>) };
  const reporters: Reporter[] = createReporters(cfg.reporter, cwd);
  const emit = async (e: RunEvent) => {
    for (const r of reporters) await r.onEvent(e);
    opts.onEvent?.(e);
  };

  const files = await findTestFiles(cwd, cfg, opts.dir, opts.files);
  const artifactsDir = resolve(cwd, cfg.artifactsDir ?? DEFAULTS.artifactsDir);
  const empty: RunSummary = { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, results: [] };

  if (files.length === 0) {
    await emit({ type: 'error', message: `no test files found under ${searchRoot} (patterns: ${(cfg.testMatch ?? []).join(', ')})` });
    await emit({ type: 'run-done', summary: empty, artifactsDir });
    return empty;
  }

  await mkdir(artifactsDir, { recursive: true });

  const baseDriver = await createDriver();
  const driver = cfg.slowMoMs ? withSlowMo(baseDriver, cfg.slowMoMs) : baseDriver;
  await driver.start();

  const perm = await driver.checkAutomationPermission();
  if (!perm.granted) {
    await driver.stop();
    throw new Error(`Cannot drive the OS: ${perm.detail}\nRun \`dtf doctor\` for a full preflight check.`);
  }

  const results: TestResult[] = [];
  const startedAt = Date.now();
  await emit({
    type: 'run-start', files, app: cfg.attach ? `attach ${JSON.stringify(cfg.attach)}` : cfg.app?.path, lifecycle: cfg.lifecycle ?? DEFAULTS.lifecycle,
    platform: driver.platformName, at: startedAt,
  });

  let app: DesktopApp | null = null;

  /** Launches the app under test, honouring any permission resets. */
  const launch = async (): Promise<DesktopApp | null> => {
    if (cfg.lifecycle === 'manual') return null;
    if (cfg.attach) return DesktopApp.attach(driver, cfg.attach);
    if (!cfg.app?.path) return null;
    if (cfg.resetPermissions?.length || cfg.grantPermissions?.length || cfg.denyPermissions?.length) {
      // Read the id without launching: the app checks its grants at boot, so
      // they must be in place before the first launch, not after a probe one.
      const id = await appIdentity(cfg.app.path);
      for (const svc of cfg.resetPermissions ?? []) await driver.resetPermission(svc, id);
      for (const [list, state] of [[cfg.grantPermissions, 'allowed'], [cfg.denyPermissions, 'denied']] as const) {
        if (!list?.length) continue;
        if (!driver.setPermission) {
          throw new UnsupportedError(`${state === 'allowed' ? 'grantPermissions' : 'denyPermissions'}`, driver.platformName);
        }
        for (const svc of list) await driver.setPermission(svc, id, state);
      }
    }
    await cfg.beforeLaunch?.();
    return DesktopApp.launch(driver, cfg.app);
  };

  const aborted = () => opts.signal?.aborted === true;

  try {
    for (const file of files) {
      if (aborted()) break;
      resetRegistry();
      setCurrentFile(file);
      // Cache-bust so a watch-mode rerun picks up edits.
      try {
        await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      } catch (err) {
        // A file that fails to import is a failed test, not a crashed run.
        const result: TestResult = {
          name: `(failed to load ${file})`, file, status: 'failed', durationMs: 0, error: serializeError(err),
        };
        results.push(result);
        await emit({ type: 'file-start', file, tests: 1 });
        await emit({ type: 'test-done', result });
        continue;
      }

      const collected = flatten(rootSuite).filter(({ test }) => {
        if (opts.grep && !test.fullName.toLowerCase().includes(opts.grep.toLowerCase())) return false;
        if (opts.line !== undefined && test.line !== opts.line) return false;
        return true;
      });
      const onlyMode = hasOnly();
      await emit({ type: 'file-start', file, tests: collected.length });

      // Launching is expensive and visible on screen; skip it entirely when a
      // filter left this file with nothing to run.
      if (collected.length === 0) continue;
      if (cfg.lifecycle === 'per-file') app = await launch();

      const ranSuites = new Set<SuiteNode>();

      for (const { test, chain } of collected) {
        if (aborted()) break;
        const skip = test.skip || (onlyMode && !test.only);
        if (skip) {
          const r: TestResult = { name: test.fullName, file, line: test.line, status: 'skipped', durationMs: 0 };
          results.push(r);
          await emit({ type: 'test-done', result: r });
          continue;
        }

        await emit({ type: 'test-start', name: test.fullName, file, line: test.line });
        if (cfg.lifecycle === 'per-test') app = await launch();

        const attachments: { name: string; body: string }[] = [];
        const ctx: TestContext = {
          app: app as DesktopApp,
          driver,
          screenshot: async (name: string) => {
            const path = join(artifactsDir, `${Date.now()}-${safeName(name)}.png`);
            await driver.screenshot({ outPath: path });
            return path;
          },
          attach: (name, body) => attachments.push({ name, body }),
        };

        if (cfg.cleanSlate && app) {
          // A menu left open by a previous test blocks the next interaction,
          // so closing menus is part of getting back to a known state.
          await driver.trayClose().catch(() => {});
          await app.notifications.dismissAll().catch(() => {});
          await app.dialogs.dismissAll().catch(() => {});
        }

        const attempts = (test.retries ?? cfg.retries ?? 0) + 1;
        const timeoutMs = test.timeoutMs ?? cfg.timeoutMs ?? DEFAULTS.timeoutMs;
        let lastError: unknown;
        let status: TestResult['status'] = 'failed';
        let attempt = 1;
        const t0 = Date.now();

        for (; attempt <= attempts; attempt++) {
          try {
            for (const suite of chain) {
              if (!ranSuites.has(suite)) {
                for (const hook of suite.beforeAll) await withTimeout(Promise.resolve(hook(ctx)), timeoutMs, 'beforeAll');
                ranSuites.add(suite);
              }
            }
            for (const suite of chain) {
              for (const hook of suite.beforeEach) await withTimeout(Promise.resolve(hook(ctx)), timeoutMs, 'beforeEach');
            }

            await withTimeout(Promise.resolve(test.fn(ctx)), timeoutMs, `test "${test.name}"`);

            for (const suite of [...chain].reverse()) {
              for (const hook of suite.afterEach) await withTimeout(Promise.resolve(hook(ctx)), timeoutMs, 'afterEach');
            }
            status = 'passed';
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            status = 'failed';
            if (attempt < attempts && !aborted()) {
              await emit({ type: 'test-retry', name: test.fullName, attempt, of: attempts });
              await sleep(500);
            } else {
              break;
            }
          }
        }

        const result: TestResult = {
          name: test.fullName,
          file,
          line: test.line,
          status,
          durationMs: Date.now() - t0,
          attempts: Math.min(attempt, attempts),
          error: serializeError(lastError),
          attachments,
        };
        const exit = app?.exited;
        if (status === 'failed' && exit && result.error) {
          // Otherwise this reads as an empty tray or a missing window.
          const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
          const when = exit.at < t0 ? 'before this test started' : `${Math.round((exit.at - t0) / 1000)}s into this test`;
          result.error.message += `\n(the app under test is not running: it exited with ${how} ${when}; see the app log)`;
        }

        if (status === 'failed' && cfg.screenshotOnFailure) {
          // Failure artifacts are the whole game in desktop testing: without the
          // screenshot and the tree you cannot tell "wrong state" from "wrong selector".
          const stem = `${Date.now()}-FAIL-${safeName(test.name)}`;
          result.screenshot = await ctx.screenshot(`FAIL-${test.name}`).catch(() => undefined);
          if (app) {
            const tree = await app.tree(10).catch(() => undefined);
            if (tree) {
              const path = join(artifactsDir, `${stem}-tree.json`);
              await writeFile(path, JSON.stringify(tree, null, 2));
              result.treeDump = path;
            }
            if (app.logs.length) {
              const path = join(artifactsDir, `${stem}-app.log`);
              await writeFile(path, app.logText());
              result.appLog = path;
            }
          }
        }

        results.push(result);
        await emit({ type: 'test-done', result });
        await driver.gc();

        if (cfg.lifecycle === 'per-test' && app) {
          await app.close().catch(() => {});
          app = null;
        }
      }

      for (const suite of [...ranSuites].reverse()) {
        for (const hook of suite.afterAll) {
          await Promise.resolve(hook({ app: app as DesktopApp, driver, screenshot: async () => '', attach: () => {} })).catch(() => {});
        }
      }

      if (cfg.lifecycle === 'per-file' && app) {
        await app.close().catch(() => {});
        app = null;
      }
    }
  } finally {
    if (app) await (app as DesktopApp).close().catch(() => {});
    await driver.stop();
  }

  const summary: RunSummary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    durationMs: Date.now() - startedAt,
    results,
  };

  await emit({ type: 'run-done', summary, artifactsDir });
  return summary;
}

export type { Driver };

/** Driver calls that act on the UI, and so get the `slowMoMs` pause after them. */
const INPUT_OPS = new Set<string>([
  'elementAction', 'elementSetValue', 'elementClick', 'elementHover', 'elementFocus',
  'trayOpen', 'trayClose', 'menuClick', 'windowSetBounds', 'windowSetMinimized',
  'notificationAct', 'dialogSetFilePath', 'key', 'type', 'click', 'move', 'drag', 'scroll', 'openUrl',
]);

/**
 * Wraps a driver so every input action is followed by a fixed pause. Queries
 * stay fast: only what changes the UI is slowed down, which is the part that
 * races an app still animating or loading.
 */
export function withSlowMo(driver: Driver, ms: number): Driver {
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !INPUT_OPS.has(prop)) return value.bind(target);
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        await sleep(ms);
        return result;
      };
    },
  });
}
