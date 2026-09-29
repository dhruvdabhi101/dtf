import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { LaunchOptions } from '../types.ts';
import type { ReporterName } from './reporter.ts';

/**
 * An app path, either one string or one per platform. The per-platform form is
 * what lets a single suite target the `.app` on macOS and the `.exe` on Windows.
 */
export type AppPath = string | Partial<Record<'darwin' | 'win32' | 'linux', string>>;

export type AppConfig = Omit<LaunchOptions, 'path'> & { path: AppPath };

export type DTFConfig = {
  /** The app under test. Omit to write tests that attach to running apps instead. */
  app?: AppConfig;
  /**
   * `per-file` relaunches the app once per test file (fast, but state leaks
   * between tests in the file). `per-test` is slower and fully isolated.
   * `manual` launches nothing and hands tests the driver only.
   */
  lifecycle?: 'per-file' | 'per-test' | 'manual';
  testMatch?: string[];
  artifactsDir?: string;
  timeoutMs?: number;
  retries?: number;
  /** Capture a screenshot automatically whenever a test fails. */
  screenshotOnFailure?: boolean;
  /**
   * Pause this long after every input action (clicks, key presses, typing,
   * menu and tray interactions, scrolls, drags). Off by default. Useful when
   * the app animates or loads between steps, and for watching a run.
   */
  slowMoMs?: number;
  /** Clear stray notifications and modals before each test. */
  cleanSlate?: boolean;
  /**
   * Runs before every launch of the app (once per file or per test, by
   * `lifecycle`). For state outside the user-data dir that a force-killed
   * previous instance can leave behind: lock files, sockets, named pipes.
   */
  beforeLaunch?: () => void | Promise<void>;
  /** Reset these privacy grants before each launch, to test first-run flows. */
  resetPermissions?: string[];
  /**
   * Grant these before each launch, with no prompt. Works on Windows, and on
   * macOS only where TCC.db is writable (SIP off and root, as on GitHub's
   * hosted runners). Elsewhere the run fails up front and says why.
   */
  grantPermissions?: string[];
  /** Deny these before each launch, to test the app's denied path. Same limits as `grantPermissions`. */
  denyPermissions?: string[];
  /**
   * Attach to an app that is already running instead of launching one. Useful
   * for login items and apps started by an installer. An attached app is left
   * running when the tests finish.
   */
  attach?: { pid?: number; bundleId?: string; name?: string };
  /** One reporter or several: `['pretty', 'junit']`. */
  reporter?: ReporterName | ReporterName[];
};

/** The config after loading: the app path is resolved for this platform. */
export type ResolvedConfig = Omit<DTFConfig, 'app'> & { app?: LaunchOptions; configFile?: string };

export const DEFAULTS: Required<Omit<DTFConfig, 'app' | 'resetPermissions' | 'grantPermissions' | 'denyPermissions' | 'attach' | 'slowMoMs' | 'beforeLaunch'>> = {
  lifecycle: 'per-file',
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  artifactsDir: 'dtf-artifacts',
  timeoutMs: 60_000,
  retries: 0,
  screenshotOnFailure: true,
  cleanSlate: true,
  reporter: 'pretty',
};

const CONFIG_NAMES = ['dtf.config.ts', 'dtf.config.mjs', 'dtf.config.js'];

/**
 * Loads the config from `dir`, or returns undefined if there is none.
 *
 * Relative app paths resolve against the config file's own directory, so a test
 * directory can be moved without rewriting its paths.
 */
export async function loadConfigFrom(dir: string): Promise<ResolvedConfig | undefined> {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const mod = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
    const cfg = (mod.default ?? mod.config ?? {}) as DTFConfig;
    return { ...DEFAULTS, ...cfg, app: resolveApp(cfg.app, dir), configFile: path };
  }
  return undefined;
}

/** Picks this platform's app path, expands variables in it and makes it absolute. */
export function resolveApp(
  app: AppConfig | undefined, dir: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env,
): LaunchOptions | undefined {
  if (!app) return undefined;
  const raw = typeof app.path === 'string' ? app.path : app.path[platform as 'darwin' | 'win32' | 'linux'];
  if (!raw) return undefined;
  return { ...app, path: resolve(dir, expandPath(raw, env)) };
}

/**
 * Expands `~`, `%VAR%` and `$VAR` / `${VAR}` in an app path, so a config can
 * point at a per-user install (`%LOCALAPPDATA%\\Programs\\…`, `~/Applications/…`)
 * without hard-coding a user name. An unset variable is an error rather than
 * a literal, because the resulting "app not found" would hide the real cause.
 */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const lookup = (name: string) => {
    const v = env[name] ?? env[Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase()) ?? ''];
    if (v === undefined) throw new Error(`app.path '${p}' uses ${name}, which is not set in the environment`);
    return v;
  };
  return p
    .replace(/^~(?=$|[\\/])/, () => env.HOME ?? env.USERPROFILE ?? homedir())
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, n: string) => lookup(n))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a?: string, b?: string) => lookup((a ?? b)!));
}

/**
 * Resolves the config for a run.
 *
 * A config next to the tests wins over one in the working directory, so a suite
 * can live beside the app it tests and still be run from anywhere.
 */
export async function loadConfig(cwd = process.cwd(), testDir?: string): Promise<ResolvedConfig> {
  if (testDir && testDir !== cwd) {
    const local = await loadConfigFrom(testDir);
    if (local) return local;
  }
  return (await loadConfigFrom(cwd)) ?? { ...DEFAULTS };
}

/** Identity helper that gives editors full type-checking on the config file. */
export function defineConfig(cfg: DTFConfig): DTFConfig {
  return cfg;
}
