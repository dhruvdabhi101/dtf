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

// Run from `npm publish`'s prepublishOnly, the child would inherit the publish
// command's npm_config_* settings; give it a clean slate.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_(config|command|lifecycle)/i.test(k)));
const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8', env, shell: process.platform === 'win32',
});

// npm has printed this as `[{ files }]` and, in newer versions, as
// `{ "<name>": { files } }`. Accept either.
let parsed;
try { parsed = JSON.parse(out.slice(out.search(/[[{]/))); } catch { parsed = undefined; }
const entry = Array.isArray(parsed) ? parsed[0] : parsed?.files ? parsed : Object.values(parsed ?? {})[0];
if (!Array.isArray(entry?.files)) {
  console.error(`dtf: could not read the file list from \`npm pack --json\`. Output was:
${out}`);
  process.exit(1);
}
const files = new Set(entry.files.map((f) => f.path));
const missing = REQUIRED.filter((f) => !files.has(f));
if (missing.length) {
  console.error(`dtf: refusing to publish — the package is missing:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`dtf: package contents OK (${files.size} files).`);
