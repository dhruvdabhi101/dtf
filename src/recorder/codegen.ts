import { compactSteps, type Check, type Scope, type Step, type Target } from './steps.ts';

/**
 * Turns recorded steps into a spec file.
 *
 * The output is meant to be read and kept, not regenerated: plain framework
 * calls, one line per step, no helper layer. A recorded test should look like
 * one a person would have written.
 */

/** A single-quoted TypeScript string literal. */
export function lit(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

function regexLiteral(pattern: string): string {
  try {
    new RegExp(pattern);
  } catch {
    return `new RegExp(${lit(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`;
  }
  return `/${pattern.replace(/(?<!\\)\//g, '\\/')}/`;
}

function objectLit(o: Record<string, string | undefined>): string {
  const parts = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${lit(v!)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '';
}

type Ctx = {
  lines: string[];
  indent: string;
  /** Variable names already declared in this test body. */
  names: Set<string>;
  /** The variable holding the currently open tray popup, if any. */
  popupVar?: string;
  /** The currently open dialog: its variable and the identity it was matched by. */
  dialog?: { name: string; key: string };
};

function fresh(ctx: Ctx, base: string): string {
  let name = base;
  for (let i = 2; ctx.names.has(name); i++) name = `${base}${i}`;
  ctx.names.add(name);
  return name;
}

function emit(ctx: Ctx, line: string) {
  ctx.lines.push(`${ctx.indent}${line}`);
}

function dialogQuery(d: { title?: string; text?: string; kind?: string }): string {
  const parts: string[] = [];
  if (d.title) parts.push(`title: ${lit(d.title)}`);
  else if (d.text) parts.push(`text: ${lit(d.text)}`);
  // File panels are frequently served by another process (a sandboxed app's
  // save panel on macOS), so they are matched across every app.
  if (d.kind === 'filePanel') parts.push(`kind: 'filePanel'`, 'anyApp: true');
  return parts.length ? `{ ${parts.join(', ')} }` : '';
}

/** Declares the dialog variable a dialog-scoped step needs, once per dialog. */
function ensureDialog(ctx: Ctx, d: { title?: string; text?: string; kind?: string }): string {
  const key = JSON.stringify(d);
  if (ctx.dialog?.key === key) return ctx.dialog.name;
  const name = fresh(ctx, 'dialog');
  emit(ctx, `const ${name} = await app.dialogs.shouldAppear(${dialogQuery(d)});`);
  ctx.dialog = { name, key };
  return name;
}

function ensurePopup(ctx: Ctx): string {
  if (ctx.popupVar) return ctx.popupVar;
  const name = fresh(ctx, 'popup');
  emit(ctx, `const ${name} = await app.tray.open();`);
  ctx.popupVar = name;
  return name;
}

function scopeExpr(ctx: Ctx, scope: Scope): string {
  switch (scope.kind) {
    case 'app': return 'app';
    case 'window': return scope.title ? `app.windows.get({ title: ${lit(scope.title)} })` : 'app.windows.main()';
    case 'trayPopup': return ensurePopup(ctx);
    case 'dialog': return ensureDialog(ctx, { title: scope.title, text: scope.text, kind: scope.dialogKind });
  }
}

function locator(ctx: Ctx, t: Target): string {
  return `${scopeExpr(ctx, t.scope)}.find(${lit(t.selector)})`;
}

function checkLine(ctx: Ctx, c: Check): string {
  switch (c.type) {
    case 'visible': return `await ${locator(ctx, c.target)}.shouldExist();`;
    case 'hidden': return `await ${locator(ctx, c.target)}.shouldNotExist();`;
    case 'enabled': return `await ${locator(ctx, c.target)}.shouldBeEnabled();`;
    case 'disabled': return `await ${locator(ctx, c.target)}.shouldBeDisabled();`;
    case 'text': return `await ${locator(ctx, c.target)}.shouldHaveText(${lit(c.text)});`;
    case 'notification': return `await app.notifications.shouldHave(${objectLit({ title: c.title, body: c.body }) || '{}'});`;
    case 'dialog': return `await app.dialogs.shouldAppear(${dialogQuery(c)});`;
    case 'window': return `await app.windows.shouldExist({ title: ${lit(c.title)} });`;
    case 'noWindows': return 'await app.windows.shouldHaveNone();';
    case 'trayItem': return `await app.tray.shouldExist(${c.label ? `{ label: ${lit(c.label)} }` : ''});`;
    case 'menuItem': return `await app.menu.shouldHave(${c.path.map(lit).join(', ')});`;
    case 'log': return `await app.waitForLog(${regexLiteral(c.pattern)});`;
    case 'running': return `if (!(await app.isRunning())) throw new Error('expected the app to still be running');`;
  }
}

function stepLines(ctx: Ctx, s: Step) {
  // A popup or dialog only stays "current" while consecutive steps use it.
  const usesPopup = ('target' in s && s.target.scope.kind === 'trayPopup')
    || (s.kind === 'expect' && 'target' in s.check && s.check.target.scope.kind === 'trayPopup');
  if (!usesPopup && s.kind !== 'trayOpen' && s.kind !== 'trayMenu') ctx.popupVar = undefined;
  const usesDialog = s.kind === 'dialogButton'
    || ('target' in s && s.target.scope.kind === 'dialog')
    || (s.kind === 'expect' && 'target' in s.check && s.check.target.scope.kind === 'dialog');
  if (!usesDialog) ctx.dialog = undefined;

  switch (s.kind) {
    case 'trayOpen':
      ctx.popupVar = undefined;
      {
        const name = fresh(ctx, 'popup');
        const query = s.label ? `{ label: ${lit(s.label)} }` : '';
        const args = s.button === 'right' ? `${query || '{}'}, { button: 'right' }` : query;
        emit(ctx, `const ${name} = await app.tray.open(${args});`);
        ctx.popupVar = name;
      }
      return;
    case 'trayMenu':
      if (ctx.popupVar) emit(ctx, `await ${ctx.popupVar}.click(${s.path.map(lit).join(', ')});`);
      else emit(ctx, `await app.tray.click(${s.path.map(lit).join(', ')});`);
      ctx.popupVar = undefined;
      return;
    case 'menu':
      emit(ctx, `await app.menu.click(${s.path.map(lit).join(', ')});`);
      return;
    case 'click': {
      const loc = locator(ctx, s.target);
      if (s.count === 2) emit(ctx, `await ${loc}.doubleClick();`);
      else if (s.button === 'right') emit(ctx, `await ${loc}.rightClick();`);
      else if (s.count > 2 || s.modifiers?.length) {
        const opts = [s.count > 1 ? `count: ${s.count}` : '', s.modifiers?.length ? `modifiers: [${s.modifiers.map(lit).join(', ')}]` : '']
          .filter(Boolean).join(', ');
        emit(ctx, `await ${loc}.click({ ${opts} });`);
      } else emit(ctx, `await ${loc}.click();`);
      return;
    }
    case 'fill':
      emit(ctx, `await ${locator(ctx, s.target)}.fill(${lit(s.text)});`);
      return;
    case 'type':
      emit(ctx, `await app.type(${lit(s.text)});`);
      return;
    case 'press':
      emit(ctx, `await app.key(${lit(s.combo)});`);
      return;
    case 'dialogButton': {
      const name = ensureDialog(ctx, s.dialog);
      emit(ctx, `await ${name}.click(${lit(s.button)});`);
      ctx.dialog = undefined;
      return;
    }
    case 'notificationClick': {
      const q = objectLit({ title: s.title });
      if (s.action) emit(ctx, `await app.notifications.clickAction(${lit(s.action)}${q ? `, ${q}` : ''});`);
      else emit(ctx, `await app.notifications.click(${q});`);
      return;
    }
    case 'expect':
      emit(ctx, checkLine(ctx, s.check));
      return;
    case 'wait':
      emit(ctx, `await new Promise((r) => setTimeout(r, ${Math.max(0, Math.round(s.ms))}));`);
      return;
    case 'comment':
      for (const line of s.text.split('\n')) emit(ctx, `// ${line}`);
      return;
  }
}

/** The statements of a test body, indented by `indent`. */
export function generateBody(steps: Step[], indent = '    '): string {
  const ctx: Ctx = { lines: [], indent, names: new Set() };
  for (const s of compactSteps(steps)) stepLines(ctx, s);
  return ctx.lines.join('\n');
}

export type SpecOptions = {
  testName: string;
  describeName?: string;
  /** Module specifier for the framework import. */
  importFrom?: string;
  /** A note placed above the test, e.g. which app it was recorded against. */
  header?: string;
};

function testBlock(steps: Step[], testName: string, indent: string): string {
  const body = generateBody(steps, `${indent}  `) || `${indent}  // (no steps recorded)`;
  return `${indent}test(${lit(testName)}, async ({ app }) => {\n${body}\n${indent}});`;
}

/** A complete, self-contained spec file. */
export function generateSpec(steps: Step[], opts: SpecOptions): string {
  const from = opts.importFrom ?? 'dtf';
  const header = opts.header ? `${opts.header.split('\n').map((l) => `// ${l}`).join('\n')}\n` : '';
  if (opts.describeName) {
    return `${header}import { describe, test } from ${lit(from)};\n\n` +
      `describe(${lit(opts.describeName)}, () => {\n${testBlock(steps, opts.testName, '  ')}\n});\n`;
  }
  return `${header}import { test } from ${lit(from)};\n\n${testBlock(steps, opts.testName, '')}\n`;
}

/**
 * Appends a recorded test to an existing spec file's source.
 *
 * The test goes at the end of the file, at top level, so it never has to parse
 * or rewrite anything already there. `test` is added to the framework import
 * when the file does not import it yet.
 */
export function appendToSpec(source: string, steps: Step[], testName: string, importFrom = 'dtf'): string {
  const block = testBlock(steps, testName, '');
  const importsTest = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['"][^'"]+['"]/.test(source);
  let out = source;
  if (!importsTest) {
    const fw = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${importFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2`);
    if (fw.test(out)) out = out.replace(fw, (_m, names: string, q: string) => `import { ${names.trim().replace(/,\s*$/, '')}, test } from ${q}${importFrom}${q}`);
    else out = `import { test } from ${lit(importFrom)};\n${out}`;
  }
  return `${out.replace(/\s*$/, '')}\n\n${block}\n`;
}
