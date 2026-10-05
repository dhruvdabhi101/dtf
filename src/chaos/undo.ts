import { rmSync } from 'node:fs';

import { asRoot, powershell, psq, sh } from '../core/shell.ts';
import { WIN32_PRELUDE } from '../core/win32.ts';

/**
 * The undo steps a fault leaves in the journal. Plain data, so a separate
 * process (the watchdog, `dtf chaos restore`) can carry them out. Every step
 * is idempotent: undoing twice, or undoing something already gone, is fine.
 */
export type UndoOp =
  /** End a helper process dtf started (stress worker, clumsy, memory_pressure). `image` guards against pid reuse. */
  | { op: 'kill'; pid: number; image?: string }
  | { op: 'resume'; pid: number }
  | { op: 'uncap'; job: string }
  | { op: 'renice'; pid: number; nice: number }
  | { op: 'firewall'; group: string }
  | { op: 'wifi-connect'; iface: string; profile: string }
  | { op: 'adapter-enable'; name: string }
  | { op: 'mac-wifi-on'; device: string }
  | { op: 'mac-service-on'; service: string }
  | { op: 'pf'; anchor: string; token?: string }
  | { op: 'rm'; path: string };

async function imageOf(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const r = await sh('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = r.stdout.match(/^"([^"]+)"/m);
    return m?.[1];
  }
  const r = await sh('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
  return r.stdout.trim() || undefined;
}

export async function runUndo(op: UndoOp): Promise<void> {
  switch (op.op) {
    case 'kill': {
      const image = await imageOf(op.pid);
      if (!image) return; // already gone
      if (op.image && !image.toLowerCase().includes(op.image.toLowerCase())) return; // pid reused by something else
      try { process.kill(op.pid, 'SIGKILL'); } catch { /* gone */ }
      return;
    }
    case 'resume':
      if (process.platform === 'win32') {
        await powershell(`${WIN32_PRELUDE}try { [DtfNative]::Resume(${op.pid}) } catch { if ($_.Exception.Message -notmatch 'OpenProcess') { throw } }`);
      } else {
        try { process.kill(op.pid, 'SIGCONT'); } catch { /* gone */ }
      }
      return;
    case 'uncap':
      await powershell(`${WIN32_PRELUDE}[DtfNative]::Uncap(${psq(op.job)})`);
      return;
    case 'renice':
      await sh('/usr/bin/renice', ['-n', String(op.nice), '-p', String(op.pid)]);
      return;
    case 'firewall':
      await powershell(`Get-NetFirewallRule -Group ${psq(op.group)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
      return;
    case 'wifi-connect': {
      const r = await sh('netsh', ['wlan', 'connect', `name=${op.profile}`, `interface=${op.iface}`]);
      if (!r.ok) throw new Error(`netsh wlan connect: ${r.stdout || r.stderr}`);
      return;
    }
    case 'adapter-enable': {
      const r = await sh('netsh', ['interface', 'set', 'interface', `name=${op.name}`, 'admin=enabled']);
      if (!r.ok) throw new Error(`netsh interface enable: ${r.stdout || r.stderr}`);
      return;
    }
    case 'mac-wifi-on':
      await sh('/usr/sbin/networksetup', ['-setairportpower', op.device, 'on']);
      return;
    case 'mac-service-on':
      await asRoot('/usr/sbin/networksetup', ['-setnetworkserviceenabled', op.service, 'on']);
      return;
    case 'pf':
      await asRoot('/sbin/pfctl', ['-a', op.anchor, '-F', 'all']);
      await asRoot('/usr/sbin/dnctl', ['-q', 'flush']);
      if (op.token) await asRoot('/sbin/pfctl', ['-X', op.token]);
      return;
    case 'rm':
      rmSync(op.path, { force: true, recursive: true });
      return;
  }
}
