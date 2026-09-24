#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds the native driver on install.
 *
 * A build failure is a warning, not an install failure: the package should still
 * install on a machine without the toolchain (or on an unsupported OS doing a
 * lockfile install), and `dtf doctor` will explain what is missing.
 */
const BUILDS = {
  darwin: {
    script: join(ROOT, 'native', 'macos', 'build.sh'),
    run: (script) => run('/bin/bash', [script]),
    hint: (script) => `Install the Xcode Command Line Tools (xcode-select --install), then run:\n     bash ${script}`,
  },
  win32: {
    script: join(ROOT, 'native', 'windows', 'build.ps1'),
    run: (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true }),
    hint: (script) => `Install the .NET 8 SDK (winget install Microsoft.DotNet.SDK.8), then run:\n     powershell -ExecutionPolicy Bypass -File ${script}`,
  },
};

const build = BUILDS[process.platform];
if (!build) {
  console.log(`dtf: skipping native build — no driver for ${process.platform} (see docs/WINDOWS.md for how one is added).`);
  process.exit(0);
}
if (!existsSync(build.script)) process.exit(0);

try {
  const { stdout } = await build.run(build.script);
  process.stdout.write(stdout);
} catch (err) {
  console.warn(
    'dtf: could not build the native driver.\n' +
      `     ${build.hint(build.script)}\n` +
      `     ${err.stderr ?? err.stdout ?? err.message}`,
  );
}
