/**
 * The chaos watchdog: a detached process, one per fault, that restores the
 * fault at its deadline if nothing else has.
 *
 * It exists for the cases the runner cannot handle itself: the runner hung,
 * crashed, or was killed with Ctrl+C mid-fault. It holds no state beyond the
 * journal entry's id, and it exits as soon as the entry is gone (restored
 * normally) or its runner is (then it restores at once rather than waiting).
 *
 * Usage: node watchdog.(ts|js) <entryId>
 */
import { hasEntry, readEntry, restoreEntry } from './journal.ts';

const id = process.argv[2];
const POLL_MS = 1000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function main() {
  if (!id) return;
  for (;;) {
    const entry = readEntry(id);
    if (!entry || !hasEntry(id)) return;
    if (Date.now() >= entry.deadline || !alive(entry.ownerPid)) {
      await restoreEntry(entry);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch(() => process.exit(1));
