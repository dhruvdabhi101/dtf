import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runUndo, type UndoOp } from './undo.ts';

/**
 * The restore journal: one file per active fault, listing how to undo it.
 *
 * A fault that changes the machine (a firewall rule, Wi-Fi off, a suspended
 * process, a CPU cap) must be undone even if the test runner crashes or is
 * killed. So the undo steps are written to disk *before* the fault is
 * injected, and removed only once it has been restored. Whatever is left
 * belongs to a run that died: `dtf chaos restore`, `dtf doctor` and the start
 * of every `dtf run` replay it.
 *
 * One file per entry, so the runner and the watchdog processes never race on
 * a shared file.
 */

export type JournalEntry = {
  id: string;
  kind: string;
  description: string;
  createdAt: number;
  /** When the watchdog restores it regardless of the runner. */
  deadline: number;
  /** The runner that created it; a live runner's entries are not "stale". */
  ownerPid: number;
  undo: UndoOp[];
};

export function journalDir(): string {
  return process.env.DTF_CHAOS_JOURNAL ?? join(tmpdir(), 'dtf-chaos');
}

const file = (id: string) => join(journalDir(), `${id}.json`);

export function writeEntry(e: JournalEntry): void {
  mkdirSync(journalDir(), { recursive: true });
  const tmp = `${file(e.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(e, null, 2));
  renameSync(tmp, file(e.id));
}

export function readEntry(id: string): JournalEntry | undefined {
  try { return JSON.parse(readFileSync(file(id), 'utf8')) as JournalEntry; } catch { return undefined; }
}

export function hasEntry(id: string): boolean {
  return existsSync(file(id));
}

export function removeEntry(id: string): void {
  rmSync(file(id), { force: true });
}

export function listEntries(): JournalEntry[] {
  if (!existsSync(journalDir())) return [];
  const out: JournalEntry[] = [];
  for (const f of readdirSync(journalDir())) {
    if (!f.endsWith('.json')) continue;
    const e = readEntry(f.slice(0, -5));
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Undoes one entry and removes it. Errors from individual steps are collected, not thrown, so every step gets its chance. */
export async function restoreEntry(e: JournalEntry): Promise<string[]> {
  const errors: string[] = [];
  // Undo in reverse order of doing.
  for (const op of [...e.undo].reverse()) {
    try { await runUndo(op); } catch (err) { errors.push(`${op.op}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  removeEntry(e.id);
  return errors;
}

/**
 * Restores every entry whose runner is gone (or every entry, with `all`).
 * Returns what was restored, for the caller to report.
 */
export async function restoreStale(opts: { all?: boolean } = {}): Promise<{ entry: JournalEntry; errors: string[] }[]> {
  const out: { entry: JournalEntry; errors: string[] }[] = [];
  for (const e of listEntries()) {
    if (!opts.all && e.ownerPid !== process.pid && alive(e.ownerPid)) continue;
    out.push({ entry: e, errors: await restoreEntry(e) });
  }
  return out;
}
