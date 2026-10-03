import { pathToFileURL } from 'node:url';
import type { DesktopApp } from '../app.ts';
import type { Driver } from '../drivers/driver.ts';
import type { PostHogServer } from '../fakes/posthog.ts';

export type TestContext = {
  app: DesktopApp;
  driver: Driver;
  /** Saves a PNG into the run's artifact directory and returns its path. */
  screenshot: (name: string) => Promise<string>;
  /** Attaches arbitrary text to the report for this test. */
  attach: (name: string, body: string) => void;
  /** The PostHog stand-in. Throws on use unless `posthog` is set in the config. */
  posthog: PostHogServer;
};

export type TestFn = (ctx: TestContext) => Promise<void> | void;
export type HookFn = (ctx: TestContext) => Promise<void> | void;

export type TestCase = {
  name: string;
  fullName: string;
  fn: TestFn;
  skip: boolean;
  only: boolean;
  timeoutMs?: number;
  retries?: number;
  file: string;
  /** 1-based line of the `test(...)` call, for editors and the Studio UI. */
  line?: number;
};

export type SuiteNode = {
  name: string;
  beforeAll: HookFn[];
  afterAll: HookFn[];
  beforeEach: HookFn[];
  afterEach: HookFn[];
  tests: TestCase[];
  children: SuiteNode[];
  parent: SuiteNode | null;
};

function newSuite(name: string, parent: SuiteNode | null): SuiteNode {
  return { name, beforeAll: [], afterAll: [], beforeEach: [], afterEach: [], tests: [], children: [], parent };
}

/**
 * Collection-time state.
 *
 * Test files register into this by side effect at import time, the same model
 * Jest/Vitest/node:test use — it keeps the authoring surface to three globals
 * and avoids making every file export boilerplate.
 */
export const rootSuite: SuiteNode = newSuite('', null);
let current: SuiteNode = rootSuite;
let currentFile = '';

export function setCurrentFile(file: string) { currentFile = file; }
export function hasOnly(): boolean {
  const walk = (s: SuiteNode): boolean => s.tests.some((t) => t.only) || s.children.some(walk);
  return walk(rootSuite);
}

export function describe(name: string, body: () => void): void {
  const suite = newSuite(name, current);
  current.children.push(suite);
  const prev = current;
  current = suite;
  try { body(); } finally { current = prev; }
}

function path(suite: SuiteNode, name: string): string {
  const parts: string[] = [name];
  for (let s: SuiteNode | null = suite; s && s.name; s = s.parent) parts.unshift(s.name);
  return parts.join(' › ');
}

type TestOptions = { timeoutMs?: number; retries?: number };

/** The line in the current test file that called `test()`, read off a stack trace. */
function callerLine(): number | undefined {
  if (!currentFile) return undefined;
  const stack = new Error().stack ?? '';
  // Frames name the file as a URL, which percent-encodes spaces and the like.
  const needles = [currentFile, pathToFileURL(currentFile).pathname];
  for (const frame of stack.split('\n')) {
    const needle = needles.find((n) => frame.includes(n));
    if (!needle) continue;
    const i = frame.indexOf(needle);
    const m = frame.slice(i + needle.length).match(/^(?:\?[^:]*)?:(\d+):\d+/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function register(name: string, fn: TestFn, opts: TestOptions, flags: { skip?: boolean; only?: boolean }) {
  current.tests.push({
    line: callerLine(),
    name,
    fullName: path(current, name),
    fn,
    skip: flags.skip ?? false,
    only: flags.only ?? false,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    file: currentFile,
  });
}

export function test(name: string, fn: TestFn, opts: TestOptions = {}): void {
  register(name, fn, opts, {});
}
test.skip = (name: string, fn: TestFn, opts: TestOptions = {}) => register(name, fn, opts, { skip: true });
test.only = (name: string, fn: TestFn, opts: TestOptions = {}) => register(name, fn, opts, { only: true });

export const it = test;

export function beforeAll(fn: HookFn) { current.beforeAll.push(fn); }
export function afterAll(fn: HookFn) { current.afterAll.push(fn); }
export function beforeEach(fn: HookFn) { current.beforeEach.push(fn); }
export function afterEach(fn: HookFn) { current.afterEach.push(fn); }

/** Clears registrations between files so each file gets an isolated tree. */
export function resetRegistry() {
  rootSuite.tests.length = 0;
  rootSuite.children.length = 0;
  rootSuite.beforeAll.length = 0;
  rootSuite.afterAll.length = 0;
  rootSuite.beforeEach.length = 0;
  rootSuite.afterEach.length = 0;
  current = rootSuite;
}
