import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Small helpers for the OS commands the perf and chaos modules shell out to.
 *
 * Those modules run PowerShell (with inline C# through `Add-Type`) rather than
 * adding ops to the native daemon, so that they work from a watchdog process
 * that outlives the runner and need no rebuild of the helper.
 */

let scriptDir: string | undefined;

/** Writes a PowerShell script to a temp file. `-File` avoids every quoting problem `-Command` has. */
function scriptFile(script: string): string {
  scriptDir ??= mkdtempSync(join(tmpdir(), 'dtf-ps-'));
  const file = join(scriptDir, `s${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  // A BOM, so Windows PowerShell 5.1 reads the file as UTF-8 and not the ANSI code page.
  writeFileSync(file, '﻿' + script, 'utf8');
  return file;
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

/** Runs a PowerShell script and returns its stdout. Throws with stderr on a non-zero exit. */
export async function powershell(script: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await run('powershell.exe', [...PS_ARGS, scriptFile(script)], {
      windowsHide: true, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`PowerShell failed: ${(e.stderr || e.message).trim().split('\n').slice(0, 6).join('\n')}`);
  }
}

/** Starts a long-running PowerShell script, e.g. a sampler loop that prints one line per tick. */
export function spawnPowershell(script: string): ChildProcess {
  return spawn('powershell.exe', [...PS_ARGS, scriptFile(script)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Runs a command, resolving with its output. Never throws: the exit code is in the result. */
export async function sh(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { windowsHide: true, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr || e.message, code: typeof e.code === 'number' ? e.code : -1 };
  }
}

let elevated: Promise<boolean> | undefined;

/**
 * Whether this process can do what needs an administrator (Windows) or root
 * (macOS): firewall rules, disabling adapters, pf/dummynet, WinDivert.
 */
export function isElevated(): Promise<boolean> {
  elevated ??= (async () => {
    if (process.platform === 'win32') return (await sh('net', ['session'], { timeoutMs: 10_000 })).ok;
    if (process.getuid?.() === 0) return true;
    // Passwordless sudo counts: the macOS commands below go through `sudo -n`.
    return (await sh('sudo', ['-n', 'true'], { timeoutMs: 5000 })).ok;
  })();
  return elevated;
}

/** Runs a command as root on macOS: directly when already root, through `sudo -n` otherwise. */
export function asRoot(cmd: string, args: string[], opts: { timeoutMs?: number } = {}) {
  if (process.getuid?.() === 0) return sh(cmd, args, opts);
  return sh('sudo', ['-n', cmd, ...args], opts);
}

/** Quotes a string for a single-quoted PowerShell literal. */
export const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
