#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds this platform's fixture app — the small tray application the
 * framework's own suite drives. `npx dtf run tests` needs it; nothing else does.
 */
const FIXTURES = {
  darwin: () => run('/bin/bash', [join(ROOT, 'fixtures', 'tray-app', 'build.sh')]),
  win32: () => run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'fixtures', 'tray-app-win', 'build.ps1'),
  ], { windowsHide: true }),
};

const build = FIXTURES[process.platform];
if (!build) {
  console.error(`no fixture app for ${process.platform}`);
  process.exit(1);
}
try {
  const { stdout } = await build();
  process.stdout.write(stdout);
} catch (err) {
  console.error(`could not build the fixture app:\n${err.stderr ?? err.stdout ?? err.message}`);
  process.exit(1);
}
