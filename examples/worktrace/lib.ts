import { rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { sleep, type DesktopApp } from '../../src/index.ts';

/**
 * Shared helpers for the Worktrace perf and chaos suites.
 */

/**
 * Worktrace writes a global `screenpipe-app.lock` in the temp dir and removes
 * it only on a clean quit. After a force-kill (which chaos tests do on
 * purpose) a relaunch within ~30 s sees the lock and quits by itself. Wired in
 * as `beforeLaunch`, so `app.relaunch()` clears it too.
 */
export function clearStaleInstanceLock(): void {
  const lock = join(process.env.TEMP ?? tmpdir(), 'screenpipe-app.lock');
  if (existsSync(lock)) rmSync(lock, { force: true });
}

/** Where Worktrace keeps its recordings and database. Override with DTF_WORKTRACE_DATA. */
export function worktraceDataDir(): string {
  return process.env.DTF_WORKTRACE_DATA ?? join(homedir(), '.screenpipe');
}

/** The tray entry that turns recording ("AI Workflow Discovery") on or off, as the shipped build labels it. */
async function discoveryItem(app: DesktopApp): Promise<{ label: string; on: boolean } | undefined> {
  const menu = await app.tray.open();
  try {
    const items = menu.items({ nested: true });
    const off = items.find((i) => i.startsWith('Turn off'));
    if (off) return { label: off, on: true };
    const on = items.find((i) => i.startsWith('Turn on'));
    return on ? { label: on, on: false } : undefined;
  } finally {
    await menu.close();
  }
}

export async function isRecording(app: DesktopApp): Promise<boolean> {
  return (await discoveryItem(app))?.on ?? false;
}

/** Turns recording on or off through the tray, and waits until the menu shows the new state. */
export async function setRecording(app: DesktopApp, on: boolean): Promise<void> {
  const item = await discoveryItem(app);
  if (!item) throw new Error('the tray menu has no "Turn on/off …" entry; is Worktrace signed in?');
  if (item.on === on) return;
  await app.tray.click(item.label);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if ((await isRecording(app)) === on) return;
  }
  throw new Error(`recording did not turn ${on ? 'on' : 'off'} from the tray`);
}

/** Log lines that mean the app hit something it did not handle. */
export const CRASH_LOG = /Uncaught Exception|UnhandledPromiseRejection|unhandledRejection|FATAL|SQLITE_CORRUPT|database disk image is malformed|panicked at/i;

/**
 * The invariants every chaos test ends with: the app is (still, or again)
 * running, its tray icon is back and its menu opens, and it logged nothing
 * that looks like an unhandled failure since `since`.
 */
export async function assertHealthy(app: DesktopApp, opts: { since?: number; timeoutMs?: number } = {}): Promise<void> {
  if (!(await app.isRunning())) {
    throw new Error(`Worktrace is not running. Log tail:\n${app.logText().split('\n').slice(-25).join('\n')}`);
  }
  await app.tray.shouldExist({}, { timeoutMs: opts.timeoutMs ?? 30_000 });
  const menu = await app.tray.open();
  await menu.close();
  await app.shouldNotLog(CRASH_LOG, { since: opts.since });
}

/** How long opening the tray menu takes: a user-visible responsiveness measure. */
export async function trayLatencyMs(app: DesktopApp): Promise<number> {
  const t = Date.now();
  const menu = await app.tray.open();
  const ms = Date.now() - t;
  await menu.close();
  return ms;
}

export const minutes = (env: string | undefined, fallback: number) => (env ? Number(env) : fallback) * 60_000;
