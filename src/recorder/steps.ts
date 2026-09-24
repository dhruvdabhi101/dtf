import type { ElementContext, MouseButton, RecordedClick, RecordedKey } from '../types.ts';
import { describeElement } from './selectors.ts';

/**
 * The recorded test, as data.
 *
 * Steps are what the Studio shows and edits and what codegen turns into a spec.
 * They describe intent in the framework's own vocabulary (open the tray, click
 * this menu path, fill this field) rather than raw input, which is what keeps
 * a recorded test readable and portable across platforms.
 */

/** Where a target element is looked up. */
export type Scope =
  | { kind: 'app' }
  | { kind: 'window'; title: string }
  | { kind: 'trayPopup' }
  | { kind: 'dialog'; title?: string; text?: string; dialogKind?: string };

export type Target = {
  scope: Scope;
  /** The chosen selector, in the string DSL. */
  selector: string;
  /** Other selectors that also matched, best first — offered in the editor. */
  alternatives?: string[];
  /** Human description, e.g. `button “Save”`. */
  label: string;
  /** False when the selector could not be checked against the live UI. */
  verified?: boolean;
};

export type Check =
  | { type: 'visible' | 'hidden' | 'enabled' | 'disabled'; target: Target }
  | { type: 'text'; target: Target; text: string }
  | { type: 'notification'; title?: string; body?: string }
  | { type: 'dialog'; title?: string; text?: string }
  | { type: 'window'; title: string }
  | { type: 'noWindows' }
  | { type: 'trayItem'; label?: string }
  | { type: 'menuItem'; path: string[] }
  | { type: 'log'; pattern: string }
  | { type: 'running' };

export type StepInput =
  | { kind: 'trayOpen'; button: MouseButton; label?: string }
  | { kind: 'trayMenu'; path: string[]; label?: string }
  | { kind: 'menu'; path: string[] }
  | { kind: 'click'; target: Target; button: MouseButton; count: number; modifiers?: string[] }
  | { kind: 'fill'; target: Target; text: string }
  | { kind: 'type'; text: string }
  | { kind: 'press'; combo: string }
  | { kind: 'dialogButton'; dialog: { title?: string; text?: string; kind?: string }; button: string }
  | { kind: 'notificationClick'; title?: string; action?: string }
  | { kind: 'expect'; check: Check }
  | { kind: 'wait'; ms: number }
  | { kind: 'comment'; text: string };

export type Step = StepInput & { id: string; at?: number };

/** A recorded event after the session has resolved its element to a Target. */
export type ResolvedAction =
  | { type: 'click'; event: RecordedClick; target?: Target }
  | { type: 'key'; event: RecordedKey; target?: Target };

let counter = 0;
export const newStepId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Double-clicks arrive as two clicks; the second within this window is merged. */
const MULTI_CLICK_MS = 500;

/** Keys that mean something other than inserting their character. */
const COMMAND_KEYS = new Set([
  'enter', 'return', 'tab', 'escape', 'esc', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'forwarddelete',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

/**
 * `cmd` on macOS and `ctrl` on Windows are the same intent; record both as the
 * portable `mod` so a recorded shortcut replays on either platform.
 */
export function portableCombo(modifiers: string[], key: string, platform: string = process.platform): string {
  const primary = platform === 'darwin' ? 'cmd' : 'ctrl';
  const mods = modifiers.map((m) => (m === primary ? 'mod' : m));
  const order = ['mod', 'ctrl', 'alt', 'shift', 'cmd'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...new Set(mods), key].join('+');
}

function sameTarget(a: Target | undefined, b: Target | undefined): boolean {
  return !!a && !!b && a.selector === b.selector && JSON.stringify(a.scope) === JSON.stringify(b.scope);
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((p, i) => path[i] === p);
}

/**
 * Turns resolved input into steps, one action at a time.
 *
 * Coalescing rules, because raw input is far noisier than intent:
 *  - a tray click followed by a click in its menu becomes one `tray.click(...)`;
 *  - clicking through a menu (File, then File › Export) keeps only the leaf;
 *  - keystrokes into one field become a single `fill`, with backspace applied;
 *  - a second click on the same target within 500ms becomes a double-click.
 */
export class StepBuilder {
  steps: Step[] = [];
  #platform: string;
  #popupOpen = false;
  #popupWindow: string | undefined;
  #lastClickAt = 0;

  constructor(opts: { platform?: string; steps?: Step[] } = {}) {
    this.#platform = opts.platform ?? process.platform;
    if (opts.steps) this.steps = [...opts.steps];
  }

  get last(): Step | undefined { return this.steps[this.steps.length - 1]; }

  push(input: StepInput, at?: number): Step {
    const step = { ...input, id: newStepId(), at } as Step;
    this.steps.push(step);
    return step;
  }

  #replaceLast(input: StepInput, at?: number): Step {
    const prev = this.steps.pop();
    const step = { ...input, id: prev?.id ?? newStepId(), at } as Step;
    this.steps.push(step);
    return step;
  }

  /** Applies one action. Returns the step it created or changed, if any. */
  apply(action: ResolvedAction): Step | undefined {
    return action.type === 'click' ? this.#click(action.event, action.target) : this.#key(action.event, action.target);
  }

  #click(e: RecordedClick, target: Target | undefined): Step | undefined {
    const last = this.last;
    const at = e.at;
    const sinceLast = at - this.#lastClickAt;
    this.#lastClickAt = at;

    if (e.surface !== 'window') {
      this.#popupOpen = false;
      this.#popupWindow = undefined;
    }

    switch (e.surface) {
      case 'tray': {
        const label = e.trayItem ? describeLabel(e.trayItem) : undefined;
        // Clicking the icon again just closes the menu it opened.
        if (last?.kind === 'trayOpen' && sinceLast < 1500) return undefined;
        this.#popupOpen = e.button === 'left';
        return this.push({ kind: 'trayOpen', button: e.button, label }, at);
      }

      case 'trayMenu': {
        const path = (e.menuPath ?? []).filter(Boolean);
        if (!path.length) return undefined;
        if (last?.kind === 'trayOpen' && last.button === 'left') {
          return this.#replaceLast({ kind: 'trayMenu', path, label: last.label }, at);
        }
        if (last?.kind === 'trayMenu' && startsWith(path, last.path)) {
          return this.#replaceLast({ kind: 'trayMenu', path, label: last.label }, at);
        }
        return this.push({ kind: 'trayMenu', path }, at);
      }

      case 'menuBar': {
        const path = (e.menuPath ?? []).filter(Boolean);
        if (!path.length) return undefined;
        if (last?.kind === 'menu' && startsWith(path, last.path)) {
          return this.#replaceLast({ kind: 'menu', path }, at);
        }
        return this.push({ kind: 'menu', path }, at);
      }

      case 'notification': {
        const title = e.notification?.texts[0];
        const isButton = e.element?.role === 'AXButton' || e.element?.role === 'Button';
        const action = isButton ? (e.element?.title ?? e.element?.description) : undefined;
        return this.push({ kind: 'notificationClick', title, action }, at);
      }

      case 'dialog': {
        const el = e.element;
        const isButton = el && (el.role === 'AXButton' || el.role === 'Button');
        const name = el?.title ?? el?.description;
        if (isButton && name && e.button === 'left' && e.count === 1) {
          return this.push({
            kind: 'dialogButton',
            dialog: dialogIdentity(e),
            button: name,
          }, at);
        }
        break;
      }

      case 'window': {
        const title = e.window?.title ?? '';
        if (this.#popupOpen && last?.kind === 'trayOpen') this.#popupWindow = title;
        else if (this.#popupOpen && this.#popupWindow !== title) this.#popupOpen = false;
        break;
      }

      case 'unknown':
        if (!target) return undefined;
        break;
    }

    if (!target) return undefined;
    const scoped: Target = this.#popupOpen && e.surface === 'window' ? { ...target, scope: { kind: 'trayPopup' } } : target;

    // AppKit reports each click of a double-click as its own mouse-down, with a
    // rising click count.
    if (last?.kind === 'click' && sameTarget(last.target, scoped) && e.count > 1 && sinceLast < MULTI_CLICK_MS) {
      return this.#replaceLast({ ...last, count: e.count }, at);
    }

    // Clicking into a field to focus it is implied by filling it; the click is
    // kept anyway (it can open pickers and autocompletes) and a following fill
    // targets the same element.
    return this.push({
      kind: 'click', target: scoped, button: e.button, count: e.count,
      ...(e.modifiers.length ? { modifiers: e.modifiers } : {}),
    }, at);
  }

  #key(e: RecordedKey, target: Target | undefined): Step | undefined {
    const last = this.last;
    const commandMods = e.modifiers.filter((m) => m !== 'shift');
    const at = e.at;

    // Shortcuts: anything with a non-shift modifier is a command, not text.
    if (commandMods.length) {
      return this.push({ kind: 'press', combo: portableCombo(e.modifiers, e.key, this.#platform) }, at);
    }

    if (e.key === 'backspace' || e.key === 'delete') {
      if (last?.kind === 'fill' || last?.kind === 'type') {
        const text = [...last.text].slice(0, -1).join('');
        if (!text) {
          this.steps.pop();
          return undefined;
        }
        return this.#replaceLast({ ...last, text }, at);
      }
      return this.push({ kind: 'press', combo: 'backspace' }, at);
    }

    if (COMMAND_KEYS.has(e.key) || !e.text || /[\u0000-\u001F\u007F]/.test(e.text)) {
      return this.push({ kind: 'press', combo: portableCombo(e.modifiers.filter((m) => m !== 'shift'), e.key, this.#platform) }, at);
    }

    // Printable text.
    if (last?.kind === 'fill' && sameTarget(last.target, target)) {
      return this.#replaceLast({ ...last, text: last.text + e.text }, at);
    }
    if (last?.kind === 'type' && !target) {
      return this.#replaceLast({ ...last, text: last.text + e.text }, at);
    }
    if (target) {
      // A click that only focused this field is subsumed by the fill.
      if (last?.kind === 'click' && sameTarget(last.target, target) && last.count === 1 && last.button === 'left') {
        return this.#replaceLast({ kind: 'fill', target, text: e.text }, at);
      }
      return this.push({ kind: 'fill', target, text: e.text }, at);
    }
    return this.push({ kind: 'type', text: e.text }, at);
  }

  /**
   * Final clean-up before codegen: drops menu clicks that only opened a menu
   * (a lone top-level `File` with nothing chosen from it).
   */
  compact(): Step[] {
    return compactSteps(this.steps);
  }
}

export function compactSteps(steps: Step[]): Step[] {
  return steps.filter((s) => !(s.kind === 'menu' && s.path.length === 1));
}

function describeLabel(el: { title?: string; description?: string; help?: string }): string | undefined {
  return el.title || el.description || el.help || undefined;
}

/** What identifies a dialog in `app.dialogs.shouldAppear(...)`. */
export function dialogIdentity(ctx: ElementContext): { title?: string; text?: string; kind?: string } {
  const d = ctx.dialog;
  if (!d) return {};
  if (d.kind === 'filePanel') return { kind: 'filePanel' };
  const text = d.texts.find((t) => t.length > 3 && t.length < 120);
  return {
    ...(d.title ? { title: d.title } : {}),
    ...(!d.title && text ? { text } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
  };
}

/** One line of text per step, for logs and the step list. */
export function describeStep(s: StepInput): string {
  switch (s.kind) {
    case 'trayOpen': return `Open tray${s.label ? ` “${s.label}”` : ''}${s.button === 'right' ? ' (right-click)' : ''}`;
    case 'trayMenu': return `Tray menu › ${s.path.join(' › ')}`;
    case 'menu': return `Menu › ${s.path.join(' › ')}`;
    case 'click': return `${s.count > 1 ? 'Double-click' : s.button === 'right' ? 'Right-click' : 'Click'} ${s.target.label}`;
    case 'fill': return `Fill ${s.target.label} with “${s.text}”`;
    case 'type': return `Type “${s.text}”`;
    case 'press': return `Press ${s.combo}`;
    case 'dialogButton': return `Dialog › ${s.button}`;
    case 'notificationClick': return s.action ? `Notification › ${s.action}` : `Click notification${s.title ? ` “${s.title}”` : ''}`;
    case 'wait': return `Wait ${s.ms}ms`;
    case 'comment': return `// ${s.text}`;
    case 'expect': {
      const c = s.check;
      switch (c.type) {
        case 'visible': return `Expect ${c.target.label} visible`;
        case 'hidden': return `Expect ${c.target.label} gone`;
        case 'enabled': return `Expect ${c.target.label} enabled`;
        case 'disabled': return `Expect ${c.target.label} disabled`;
        case 'text': return `Expect ${c.target.label} to have “${c.text}”`;
        case 'notification': return `Expect notification${c.title ? ` “${c.title}”` : ''}`;
        case 'dialog': return `Expect dialog${c.title ? ` “${c.title}”` : c.text ? ` with “${c.text}”` : ''}`;
        case 'window': return `Expect window “${c.title}”`;
        case 'noWindows': return 'Expect no windows';
        case 'trayItem': return 'Expect tray icon';
        case 'menuItem': return `Expect menu ${c.path.join(' › ')}`;
        case 'log': return `Expect log /${c.pattern}/`;
        case 'running': return 'Expect app running';
      }
    }
  }
}

export { describeElement };
