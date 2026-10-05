import { existsSync } from 'node:fs';

import type { PreflightCheck } from '../drivers/driver.ts';
import { isElevated, sh } from '../core/shell.ts';
import { listEntries } from './journal.ts';

/** What `dtf doctor` says about perf and chaos: leftover faults, and which faults this machine can run. */
export async function chaosPreflight(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const left = listEntries();
  checks.push({
    name: 'chaos journal',
    ok: left.length ? 'warn' : true,
    detail: left.length
      ? `${left.length} fault(s) from an earlier run still recorded: ${left.map((e) => e.description).join('; ')}. \`dtf chaos restore\` undoes them (\`dtf run\` does too)`
      : 'no faults left over from earlier runs',
  });

  const elevated = await isElevated();
  checks.push({
    name: 'chaos: elevated',
    ok: elevated ? true : 'warn',
    detail: elevated
      ? 'firewall blocks, adapter toggling and OS-level shaping are available'
      : process.platform === 'win32'
        ? 'not elevated: proxy faults, process faults, CPU/memory caps and Wi-Fi work; firewall, adapter and OS-level shaping need an administrator terminal'
        : 'no root: pf/dnctl shaping and network-service toggling need sudo',
  });

  if (process.platform === 'win32') {
    const configured = [process.env.DTF_CLUMSY].filter((p): p is string => !!p && existsSync(p));
    const onPath = configured.length ? true : (await sh('where', ['clumsy'], { timeoutMs: 5000 })).ok;
    checks.push({
      name: 'chaos: clumsy',
      ok: onPath ? true : 'warn',
      detail: onPath
        ? 'found: OS-level latency/loss (via: \'os\') available'
        : 'not found: OS-level shaping unavailable (proxy shaping still works). Get it from https://jagt.github.io/clumsy/ and set DTF_CLUMSY or chaos.clumsyPath',
    });
  }
  return checks;
}
