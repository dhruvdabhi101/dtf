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
 * install on a machine without the Xcode tools (or on a non-macOS box doing a
 * lockfile install), and `dtf doctor` will explain what is missing.
 */
if (process.platform !== 'darwin') {
  console.log('dtf: skipping native build — only the macOS driver is implemented today.');
  process.exit(0);
}

const script = join(ROOT, 'native', 'macos', 'build.sh');
if (!existsSync(script)) process.exit(0);

try {
  const { stdout } = await run('/bin/bash', [script]);
  process.stdout.write(stdout);
} catch (err) {
  console.warn(
    'dtf: could not build the native driver.\n' +
      '     Install the Xcode Command Line Tools (xcode-select --install), then run:\n' +
      `     bash ${script}\n` +
      `     ${err.stderr ?? err.message}`,
  );
}
