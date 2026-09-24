#!/usr/bin/env node
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests, collectTests } from './runner/run.ts';
import { createDriver } from './drivers/index.ts';
import { loadConfig } from './runner/config.ts';
import { DesktopApp } from './app.ts';
import { aiCheck } from './ai/agent.ts';
import { runDoctor, doctorPassed, type PreflightCheck } from './doctor.ts';
import { RecordingSession } from './recorder/session.ts';
import { describeStep } from './recorder/steps.ts';
import { importSpecifierFor } from './recorder/project.ts';
import type { ReporterName } from './runner/reporter.ts';

const PKG = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string };

const HELP = `dtf ${PKG.version} — OS-level testing for desktop apps

Usage
  dtf run [dir]              Run the test suite (default: current directory)
  dtf studio                 Open the Studio UI: run, record and inspect tests
  dtf record [file]          Record a test from the terminal (Ctrl+C to finish)
  dtf list                   List the tests the suite declares, without running them
  dtf doctor                 Check that this machine can drive the OS
  dtf init                   Write a starter dtf.config.ts and example spec
  dtf inspect tray           List every tray icon on the system
  dtf inspect tree           Dump an app's accessibility tree
  dtf inspect notifications  Show notification banners currently on screen
  dtf inspect dialogs        Show open dialogs, sheets and file panels
  dtf inspect menu           Dump an app's menu bar
  dtf ask "<claim>"          Ask the AI checker to verify a claim about an app

Run options
  --grep <text>       Only run tests whose name contains <text>
  --file <path>       Only run this file (repeatable via commas)
  --line <n>          Only run the test declared on this line of --file
  --lifecycle <m>     per-file | per-test | manual
  --retries <n>       Retry failing tests n times
  --reporter <list>   pretty,json,junit,stream,silent (default: pretty)
  --json              Shorthand for --reporter pretty,json
  --attach-pid <pid>  Attach to a running app instead of launching one
  --attach-bundle <id>

Studio options
  --port <n>          Port to listen on (default 4417)
  --no-open           Do not open a browser

Targeting (inspect / ask / record)
  --bundle <id>       Target app by bundle identifier / app id
  --name <name>       Target app by name
  --pid <pid>         Target app by pid
  --launch            record: launch the app from dtf.config instead of attaching
  --depth <n>         Tree depth for inspect (default 8)

Examples
  dtf doctor
  dtf studio
  dtf run tests --grep tray --reporter pretty,junit
  dtf record tests/recorded.spec.ts --launch
  dtf inspect tree --bundle com.example.myapp --depth 6
`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) {
      flags[a.slice(5)] = false;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

async function targetApp(flags: Flags) {
  const driver = await createDriver();
  await driver.start();
  const app = await DesktopApp.attach(driver, {
    bundleId: str(flags.bundle),
    name: str(flags.name),
    pid: flags.pid ? Number(flags.pid) : undefined,
  });
  return { driver, app };
}

function printChecks(checks: PreflightCheck[]) {
  console.log('\ndtf doctor\n');
  for (const c of checks) {
    const icon = c.ok === true ? '\x1b[32m✓\x1b[0m' : c.ok === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon} ${c.name.padEnd(24)} ${c.detail}`);
  }
  console.log('');
}

async function doctor(flags: Flags): Promise<number> {
  const checks = await runDoctor();
  if (flags.json) console.log(JSON.stringify(checks, null, 2));
  else printChecks(checks);
  return doctorPassed(checks) ? 0 : 1;
}

const STARTER_CONFIG = `import { defineConfig } from 'dtf';

export default defineConfig({
  app: {
    // One path per platform lets the same suite run on macOS and Windows.
    path: {
      darwin: '/Applications/YourApp.app',
      win32: 'C:\\\\Program Files\\\\YourApp\\\\YourApp.exe',
    },
    // Electron: give each run a throwaway profile so tests start from zero.
    isolatedUserData: true,
    userDataArg: '--user-data-dir=',
  },
  lifecycle: 'per-file',
  retries: 1,
  screenshotOnFailure: true,
  reporter: ['pretty', 'junit'],
});
`;

const STARTER_SPEC = `import { describe, test } from 'dtf';

describe('OS surfaces', () => {
  test('registers a tray icon', async ({ app }) => {
    await app.tray.shouldExist();
  });

  test('the tray menu offers Quit', async ({ app }) => {
    const menu = await app.tray.open();
    await menu.shouldHaveItem('Quit');
    await menu.close();
  });
});
`;

async function init(): Promise<number> {
  const cwd = process.cwd();
  if (!existsSync(join(cwd, 'dtf.config.ts'))) {
    await writeFile(join(cwd, 'dtf.config.ts'), STARTER_CONFIG);
    console.log('created dtf.config.ts');
  }
  await mkdir(join(cwd, 'tests'), { recursive: true });
  if (!existsSync(join(cwd, 'tests', 'os.spec.ts'))) {
    await writeFile(join(cwd, 'tests', 'os.spec.ts'), STARTER_SPEC);
    console.log('created tests/os.spec.ts');
  }
  console.log('\nNext: edit the app path in dtf.config.ts, then run `dtf doctor` and `dtf studio`.\n');
  return 0;
}

async function inspect(what: string, flags: Flags): Promise<number> {
  const depth = flags.depth ? Number(flags.depth) : 8;
  const asJson = flags.json === true;

  if (what === 'tray' || what === 'notifications' || what === 'dialogs') {
    const driver = await createDriver();
    await driver.start();
    try {
      if (what === 'tray') {
        const items = await driver.trayList(flags.pid ? Number(flags.pid) : undefined);
        if (asJson) console.log(JSON.stringify(items, null, 2));
        else {
          console.log(`\n${items.length} tray item(s)\n`);
          for (const i of items) {
            console.log(`  ${(i.label || '(no label)').padEnd(34)} ${i.app}  ${i.bundleId}  pid=${i.pid}`);
          }
          console.log('');
        }
      } else if (what === 'notifications') {
        console.log(JSON.stringify(await driver.notificationList(), null, 2));
      } else {
        const list = await driver.dialogList(flags.pid ? Number(flags.pid) : undefined);
        console.log(JSON.stringify(list.map((d) => ({
          kind: d.kind, app: d.app, title: d.title, buttons: d.buttons.map((b) => b.title), texts: d.texts,
        })), null, 2));
      }
    } finally {
      await driver.stop();
    }
    return 0;
  }

  const { driver, app } = await targetApp(flags);
  try {
    if (what === 'menu') console.log(JSON.stringify(await app.menu.tree(depth), null, 2));
    else console.log(JSON.stringify(await app.tree(depth), null, 2));
  } finally {
    await driver.stop();
  }
  return 0;
}

/**
 * Terminal recorder: prints steps as they are captured and writes a spec on
 * Ctrl+C. The Studio is the richer way to do this; this exists for machines
 * reached over SSH/VNC and for scripting.
 */
async function record(file: string | undefined, flags: Flags): Promise<number> {
  const cwd = process.cwd();
  const driver = await createDriver();
  await driver.start();
  const perm = await driver.checkAutomationPermission();
  if (!perm.granted) {
    await driver.stop();
    throw new Error(perm.detail);
  }

  let app: DesktopApp;
  let launched = false;
  if (flags.launch || (!flags.bundle && !flags.name && !flags.pid)) {
    const cfg = await loadConfig(cwd);
    if (!cfg.app?.path) throw new Error('no app configured for this platform in dtf.config.ts; pass --bundle/--name/--pid to attach instead');
    app = await DesktopApp.launch(driver, cfg.app);
    launched = true;
  } else {
    app = await DesktopApp.attach(driver, {
      bundleId: str(flags.bundle), name: str(flags.name), pid: flags.pid ? Number(flags.pid) : undefined,
    });
  }

  const session = new RecordingSession(driver, app);
  session.on('step', ({ step }) => console.log(`  \x1b[36m●\x1b[0m ${describeStep(step)}`));
  session.on('suggestion', (s) => console.log(`  \x1b[2m  noticed: ${s.label}\x1b[0m`));
  session.on('error', (e) => console.error(`  \x1b[31m${e.message}\x1b[0m`));
  await session.start();
  console.log(`\nRecording ${app.name} (pid ${app.pid}). Use the app; press Ctrl+C to finish.\n`);

  await new Promise<void>((done) => process.once('SIGINT', () => done()));
  await session.stop();

  const target = resolve(cwd, file ?? `tests/recorded-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.spec.ts`);
  const testName = str(flags.test) ?? 'recorded flow';
  const code = session.code({
    testName,
    importFrom: importSpecifierFor(cwd, target),
    header: `Recorded with \`dtf record\` against ${app.name} on ${driver.platformName}.`,
  });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code);
  console.log(`\nwrote ${relative(cwd, target)} (${session.steps.length} step(s))\n`);

  if (launched) await app.close().catch(() => {});
  await driver.stop();
  return 0;
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (flags.version || cmd === 'version') {
    console.log(PKG.version);
    return 0;
  }
  if (flags.help || flags.h) {
    console.log(HELP);
    return 0;
  }

  switch (cmd) {
    case 'doctor':
      return doctor(flags);

    case 'init':
      return init();

    case 'inspect':
      return inspect(positional[1] ?? 'tree', flags);

    case 'list': {
      const files = await collectTests({ dir: positional[1] });
      if (flags.json) console.log(JSON.stringify(files, null, 2));
      else {
        for (const f of files) {
          console.log(`\n${relative(process.cwd(), f.file)}${f.error ? `  \x1b[31m${f.error}\x1b[0m` : ''}`);
          for (const t of f.tests) console.log(`  ${t.line ? `:${t.line}`.padEnd(6) : '      '}${t.fullName}${t.skip ? ' (skip)' : ''}`);
        }
        console.log('');
      }
      return 0;
    }

    case 'studio': {
      const { startStudio } = await import('./studio/server.ts');
      await startStudio({
        cwd: process.cwd(),
        port: flags.port ? Number(flags.port) : undefined,
        open: flags.open !== false,
      });
      // The server keeps the process alive until Ctrl+C.
      return new Promise<number>(() => {});
    }

    case 'record':
      return record(positional[1], flags);

    case 'ask': {
      const claim = positional[1];
      if (!claim) { console.error('dtf ask needs a claim, e.g. dtf ask "the tray has a Quit item"'); return 2; }
      const { driver, app } = await targetApp(flags);
      try {
        const result = await aiCheck(app, claim, {
          allowActions: flags.act === true,
          vision: flags.vision === true,
          onStep: (s) => console.error(`\x1b[2m  · ${s.tool}\x1b[0m`),
        });
        console.log(`\n${result.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${result.reason}\n`);
        return result.pass ? 0 : 1;
      } finally {
        await driver.stop();
      }
    }

    case 'run':
    case undefined: {
      const reporter = (str(flags.reporter) ?? (flags.json ? 'pretty,json' : undefined))
        ?.split(',').map((r) => r.trim()) as ReporterName[] | undefined;
      const controller = new AbortController();
      // First Ctrl+C finishes the current test and tears down cleanly; a second
      // one exits immediately.
      process.once('SIGINT', () => {
        console.error('\nstopping after the current test… (Ctrl+C again to force)');
        controller.abort();
        process.once('SIGINT', () => process.exit(130));
      });
      // The Studio runs this command as a child and cancels over IPC, which
      // works the same on every platform.
      if (process.send) {
        process.on('message', (m) => { if (m === 'cancel') controller.abort(); });
        process.channel?.unref();
      }
      const summary = await runTests({
        dir: positional[1],
        grep: str(flags.grep),
        files: str(flags.file)?.split(','),
        line: flags.line ? Number(flags.line) : undefined,
        signal: controller.signal,
        configOverrides: {
          ...(flags.lifecycle ? { lifecycle: flags.lifecycle as 'per-file' } : {}),
          ...(flags.retries ? { retries: Number(flags.retries) } : {}),
          ...(reporter ? { reporter } : {}),
          ...(flags['attach-pid'] || flags['attach-bundle']
            ? { attach: { pid: flags['attach-pid'] ? Number(flags['attach-pid']) : undefined, bundleId: str(flags['attach-bundle']) } }
            : {}),
        },
      });
      return summary.failed > 0 || controller.signal.aborted ? 1 : 0;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    default:
      console.error(`unknown command '${cmd}'\n`);
      console.log(HELP);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
    process.exit(1);
  });
