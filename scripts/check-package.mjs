#!/usr/bin/env node
// Refuses to publish a tarball that is missing a platform's prebuilt driver or
// the compiled JS. release.yml assembles both drivers from their own runners, so
// a publish from a single dev machine (which can build only its own) fails here
// instead of shipping a package that is broken on the other OS.
import { execFileSync } from 'node:child_process';

const REQUIRED = [
  'dist/cli.js',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/studio/ui/index.html',
  'native/macos/bin/dtfd-macos',
  'native/windows/bin/dtfd-windows.exe',
  'scripts/postinstall.mjs',
];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32' });
const files = new Set(JSON.parse(out)[0].files.map((f) => f.path));
const missing = REQUIRED.filter((f) => !files.has(f));
if (missing.length) {
  console.error(`dtf: refusing to publish — the package is missing:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`dtf: package contents OK (${files.size} files).`);
