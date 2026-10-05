import { basename } from 'node:path';

import { powershell, sh } from '../core/shell.ts';
import { Rng } from '../core/random.ts';

/**
 * An app's process tree, with each process classified the way Electron and
 * Chromium launch them, so a fault can target "the GPU process" or "a
 * renderer" rather than a pid.
 */

export type ProcKind = 'main' | 'renderer' | 'gpu' | 'utility' | 'crashpad' | 'sidecar';
export type ProcInfo = { pid: number; ppid: number; name: string; path?: string; kind: ProcKind; commandLine: string };

/** Which processes of a tree a process fault hits. `random-child` is any non-main one, chosen by the seeded RNG. */
export type ProcSelector = ProcKind | 'tree' | 'random-child' | 'child' | number;

export function classify(commandLine: string, isRoot: boolean, rootName: string, name: string): ProcKind {
  if (isRoot) return 'main';
  const type = commandLine.match(/--type=([\w-]+)/)?.[1];
  if (type === 'renderer') return 'renderer';
  if (type === 'gpu-process') return 'gpu';
  if (type === 'crashpad-handler') return 'crashpad';
  if (type) return 'utility';
  // A child that is not a Chromium helper: a bundled binary the app spawned.
  return name.toLowerCase() === rootName.toLowerCase() ? 'utility' : 'sidecar';
}

async function allProcesses(): Promise<{ pid: number; ppid: number; name: string; path?: string; commandLine: string }[]> {
  if (process.platform === 'win32') {
    const out = await powershell(
      `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
    );
    const rows = JSON.parse(out) as { ProcessId: number; ParentProcessId: number; Name: string; ExecutablePath?: string; CommandLine?: string }[];
    return rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, path: r.ExecutablePath ?? undefined, commandLine: r.CommandLine ?? '' }));
  }
  const r = await sh('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command=']);
  return r.stdout.split('\n').flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) return [];
    const cmd = m[3];
    // The executable is the command line up to the first " -" switch; paths contain spaces on macOS.
    const exe = cmd.split(/\s+--?[a-z]/i)[0];
    return [{ pid: Number(m[1]), ppid: Number(m[2]), name: basename(exe), path: exe, commandLine: cmd }];
  });
}

/** The tree rooted at `rootPid`, root first. */
export async function processTree(rootPid: number): Promise<ProcInfo[]> {
  const all = await allProcesses();
  const root = all.find((p) => p.pid === rootPid);
  if (!root) return [];
  const inTree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!inTree.has(p.pid) && inTree.has(p.ppid) && p.pid !== p.ppid) { inTree.add(p.pid); grew = true; }
  }
  return all.filter((p) => inTree.has(p.pid))
    .map((p) => ({ ...p, kind: classify(p.commandLine, p.pid === rootPid, root.name, p.name) }))
    .sort((a, b) => (a.pid === rootPid ? -1 : b.pid === rootPid ? 1 : 0));
}

export function pick(tree: ProcInfo[], which: ProcSelector, rng: Rng): ProcInfo[] {
  if (typeof which === 'number') return tree.filter((p) => p.pid === which);
  if (which === 'tree') return tree;
  const children = tree.filter((p) => p.kind !== 'main');
  if (which === 'child') return children;
  if (which === 'random-child') return children.length ? [rng.pick(children)] : [];
  return tree.filter((p) => p.kind === which);
}
