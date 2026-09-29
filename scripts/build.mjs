#!/usr/bin/env node
// Builds the publishable JS: compiles src/ to dist/ and copies the Studio's
// static UI, which tsc does not touch.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync(DIST, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json')], { stdio: 'inherit' });
cpSync(join(ROOT, 'src', 'studio', 'ui'), join(DIST, 'studio', 'ui'), { recursive: true });
console.log('built dist/');
