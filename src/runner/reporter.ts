import { writeFile, mkdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  expected?: unknown;
  actual?: unknown;
};

export type TestResult = {
  name: string;
  file: string;
  line?: number;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  attempts?: number;
  error?: SerializedError;
  screenshot?: string;
  treeDump?: string;
  appLog?: string;
  attachments?: { name: string; body: string }[];
};

export type RunSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: TestResult[];
};

/**
 * Everything the runner reports, in order. Reporters, the Studio UI and CI
 * integrations all consume this one stream, so nothing has to scrape console
 * output to know what happened.
 */
export type RunEvent =
  | { type: 'run-start'; files: string[]; app?: string; lifecycle: string; platform: string; at: number }
  | { type: 'file-start'; file: string; tests: number }
  | { type: 'test-start'; name: string; file: string; line?: number }
  | { type: 'test-retry'; name: string; attempt: number; of: number }
  | { type: 'test-done'; result: TestResult }
  | { type: 'run-done'; summary: RunSummary; artifactsDir: string }
  | { type: 'error'; message: string };

export interface Reporter {
  onEvent(e: RunEvent): void | Promise<void>;
}

export function serializeError(err: unknown): SerializedError | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    const e = err as Error & { expected?: unknown; actual?: unknown };
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      ...(e.expected !== undefined ? { expected: e.expected instanceof RegExp ? String(e.expected) : e.expected } : {}),
      ...(e.actual !== undefined ? { actual: e.actual } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c('32'), red = c('31'), yellow = c('33'), dim = c('2'), bold = c('1'), cyan = c('36');

export class PrettyReporter implements Reporter {
  #cwd: string;
  constructor(cwd = process.cwd()) { this.#cwd = cwd; }

  onEvent(e: RunEvent) {
    switch (e.type) {
      case 'run-start':
        console.log(`\n${bold('dtf')} ${dim(`· ${e.platform} · ${e.files.length} file(s) · lifecycle=${e.lifecycle}`)}`);
        console.log(dim(`     app: ${e.app ?? '(no app configured — tests attach manually)'}\n`));
        break;
      case 'file-start':
        console.log(`${cyan(relative(this.#cwd, e.file))} ${dim(`(${e.tests})`)}`);
        break;
      case 'test-retry':
        console.log(`  ${yellow('↻')} ${dim(`retry ${e.attempt}/${e.of - 1}: ${e.name}`)}`);
        break;
      case 'test-done':
        this.#testDone(e.result);
        break;
      case 'run-done':
        this.#runDone(e.summary, e.artifactsDir);
        break;
      case 'error':
        console.log(red(e.message));
        break;
    }
  }

  #testDone(r: TestResult) {
    const ms = dim(`${r.durationMs}ms`);
    if (r.status === 'passed') {
      console.log(`  ${green('✓')} ${r.name} ${ms}`);
      return;
    }
    if (r.status === 'skipped') {
      console.log(`  ${yellow('○')} ${dim(r.name)}`);
      return;
    }
    console.log(`  ${red('✗')} ${r.name} ${ms}`);
    for (const line of (r.error?.message ?? '').split('\n')) console.log(`      ${red(line)}`);
    for (const [label, path] of [['screenshot', r.screenshot], ['ax tree', r.treeDump], ['app log', r.appLog]] as const) {
      if (path) console.log(`      ${dim(`${label}: ${path}`)}`);
    }
  }

  #runDone(s: RunSummary, artifactsDir: string) {
    if (s.total === 0) {
      console.log(`\n${yellow('no tests ran')}\n`);
      return;
    }
    const parts = [
      s.passed ? green(`${s.passed} passed`) : '',
      s.failed ? red(`${s.failed} failed`) : '',
      s.skipped ? yellow(`${s.skipped} skipped`) : '',
    ].filter(Boolean);
    console.log(`\n${bold('Summary')}  ${parts.join(dim(' · '))}  ${dim(`in ${(s.durationMs / 1000).toFixed(1)}s`)}`);

    if (s.failed) {
      console.log(`\n${bold(red('Failures'))}`);
      for (const r of s.results.filter((x) => x.status === 'failed')) {
        console.log(`\n  ${red('✗')} ${bold(r.name)}`);
        console.log(dim(`    ${relative(this.#cwd, r.file)}${r.line ? `:${r.line}` : ''}`));
        if (r.error?.stack) {
          const frames = r.error.stack.split('\n').slice(0, 6).join('\n      ');
          console.log(`      ${frames}`);
        }
      }
      console.log(dim(`\n  artifacts: ${artifactsDir}`));
    }
    console.log('');
  }
}

/** The prefix that marks a machine-readable event line on stdout. */
export const EVENT_PREFIX = '::dtf-event::';

/**
 * One JSON event per line on stdout, prefixed so it survives being interleaved
 * with whatever the tests themselves print. This is what the Studio UI reads
 * from the child process it spawns for each run.
 */
export class StreamReporter implements Reporter {
  onEvent(e: RunEvent) {
    process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(e)}\n`);
  }
}

export class JsonReporter implements Reporter {
  async onEvent(e: RunEvent) {
    if (e.type !== 'run-done') return;
    await mkdir(e.artifactsDir, { recursive: true });
    await writeFile(join(e.artifactsDir, 'results.json'), JSON.stringify(e.summary, null, 2));
  }
}

const xml = (s: string) =>
  s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!)
    // XML 1.0 forbids most control characters, and test output is full of ANSI codes.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** JUnit XML — the format every CI system (GitHub, GitLab, Jenkins, Azure) can render. */
export class JUnitReporter implements Reporter {
  #cwd: string;
  constructor(cwd = process.cwd()) { this.#cwd = cwd; }

  async onEvent(e: RunEvent) {
    if (e.type !== 'run-done') return;
    const byFile = new Map<string, TestResult[]>();
    for (const r of e.summary.results) {
      // Forward slashes on every OS, so CI report viewers group suites the same way.
      const key = relative(this.#cwd, r.file).split(sep).join('/');
      byFile.set(key, [...(byFile.get(key) ?? []), r]);
    }
    const suites = [...byFile].map(([file, results]) => {
      const time = results.reduce((a, r) => a + r.durationMs, 0) / 1000;
      const cases = results.map((r) => {
        const open = `    <testcase classname="${xml(file)}" name="${xml(r.name)}" time="${(r.durationMs / 1000).toFixed(3)}"`;
        if (r.status === 'skipped') return `${open}>\n      <skipped/>\n    </testcase>`;
        if (r.status === 'passed') return `${open}/>`;
        const artifacts = [r.screenshot, r.treeDump, r.appLog].filter(Boolean).map((p) => `[[ATTACHMENT|${p}]]`).join('\n');
        return `${open}>\n      <failure message="${xml(r.error?.message.split('\n')[0] ?? 'failed')}" type="${xml(r.error?.name ?? 'Error')}">${xml(r.error?.stack ?? r.error?.message ?? '')}</failure>` +
          (artifacts ? `\n      <system-out>${xml(artifacts)}</system-out>` : '') +
          `\n    </testcase>`;
      });
      const failures = results.filter((r) => r.status === 'failed').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      return `  <testsuite name="${xml(file)}" tests="${results.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">\n${cases.join('\n')}\n  </testsuite>`;
    });
    const s = e.summary;
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="dtf" tests="${s.total}" failures="${s.failed}" skipped="${s.skipped}" time="${(s.durationMs / 1000).toFixed(3)}">\n${suites.join('\n')}\n</testsuites>\n`;
    await mkdir(e.artifactsDir, { recursive: true });
    await writeFile(join(e.artifactsDir, 'junit.xml'), body);
  }
}

export type ReporterName = 'pretty' | 'json' | 'junit' | 'stream' | 'silent';

export function createReporters(names: ReporterName | ReporterName[] | undefined, cwd: string): Reporter[] {
  const list = (Array.isArray(names) ? names : [names ?? 'pretty']).flatMap((n) => String(n).split(','));
  return list.map((n) => n.trim()).filter(Boolean).flatMap((n): Reporter[] => {
    switch (n) {
      case 'pretty': return [new PrettyReporter(cwd)];
      case 'json': return [new JsonReporter()];
      case 'junit': return [new JUnitReporter(cwd)];
      case 'stream': return [new StreamReporter()];
      case 'silent': return [];
      default: throw new Error(`unknown reporter '${n}'; expected pretty, json, junit, stream or silent`);
    }
  });
}
