import { EventEmitter } from 'node:events';

import type { Driver, Root } from '../drivers/driver.ts';
import type { DesktopApp } from '../app.ts';
import type { AXNode, ElementContext, RecordedClick, RecordedEvent, RecordedKey } from '../types.ts';
import { toSelectorPath } from '../core/selector.ts';
import { selectorCandidates, withNth, describeElement, sameRect } from './selectors.ts';
import {
  StepBuilder, describeStep, dialogIdentity,
  type Check, type Scope, type Step, type StepInput, type Target,
} from './steps.ts';
import { generateSpec, generateBody, type SpecOptions } from './codegen.ts';

/** Something the recorder noticed that is worth asserting on. */
export type Suggestion = {
  id: string;
  label: string;
  check: Check;
  at: number;
};

/** The element chosen in pick mode, with its live state for assertion defaults. */
export type PickResult = {
  target: Target;
  text?: string;
  enabled?: boolean;
  context: ElementContext;
};

export type SessionEvents = {
  step: [{ step: Step; steps: Step[] }];
  steps: [Step[]];
  suggestion: [Suggestion];
  pick: [PickResult];
  ignored: [{ reason: string; event: RecordedEvent }];
  error: [Error];
  state: [{ recording: boolean; picking: boolean }];
};

export type RecordingSessionOptions = {
  /** Watch for notifications, dialogs and windows and offer them as assertions. */
  observe?: boolean;
  observeIntervalMs?: number;
};

/**
 * One recording against one running app.
 *
 * Owns the ordering problem: native events arrive in order, but resolving each
 * one to a verified selector is asynchronous. A promise chain keeps step
 * building strictly sequential so a fast click-then-type never comes out
 * type-then-click.
 */
export class RecordingSession extends EventEmitter<SessionEvents> {
  readonly driver: Driver;
  readonly app: DesktopApp;
  #builder: StepBuilder;
  #chain: Promise<void> = Promise.resolve();
  #recording = false;
  #picking = false;
  #pendingPick: { resolve: (p: PickResult) => void; reject: (e: Error) => void } | null = null;
  #observer: NodeJS.Timeout | null = null;
  #seen = { notifications: new Set<string>(), dialogs: new Set<string>(), windows: new Set<string>() };
  #opts: Required<RecordingSessionOptions>;
  suggestions: Suggestion[] = [];

  constructor(driver: Driver, app: DesktopApp, opts: RecordingSessionOptions = {}) {
    super();
    this.driver = driver;
    this.app = app;
    this.#builder = new StepBuilder({ platform: driver.platform });
    this.#opts = { observe: true, observeIntervalMs: 1000, ...opts };
  }

  get recording() { return this.#recording; }
  get picking() { return this.#picking; }
  get steps(): Step[] { return this.#builder.steps; }

  async start(): Promise<void> {
    if (this.#recording) return;
    await this.#primeObservers();
    await this.driver.recordStart((e) => {
      this.#chain = this.#chain.then(() => this.#handle(e)).catch((err) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    });
    this.#recording = true;
    if (this.#opts.observe) {
      this.#observer = setInterval(() => { void this.#observe(); }, this.#opts.observeIntervalMs);
    }
    this.#emitState();
  }

  async stop(): Promise<void> {
    if (this.#observer) clearInterval(this.#observer);
    this.#observer = null;
    if (this.#recording) await this.driver.recordStop();
    this.#recording = false;
    this.#picking = false;
    this.#pendingPick?.reject(new Error('recording stopped'));
    this.#pendingPick = null;
    await this.#chain;
    this.#emitState();
  }

  /** Waits for the next click to pick an element, without the app receiving it. */
  async pick(timeoutMs = 60_000): Promise<PickResult> {
    if (!this.#recording) throw new Error('start recording before picking an element');
    this.#pendingPick?.reject(new Error('superseded by a new pick'));
    await this.driver.recordPick(true);
    this.#picking = true;
    this.#emitState();
    return new Promise<PickResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingPick = null;
        this.#picking = false;
        void this.driver.recordPick(false).catch(() => {});
        this.#emitState();
        reject(new Error('no element was picked'));
      }, timeoutMs);
      this.#pendingPick = {
        resolve: (p) => { clearTimeout(timer); resolve(p); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  async cancelPick(): Promise<void> {
    await this.driver.recordPick(false).catch(() => {});
    this.#picking = false;
    this.#pendingPick?.reject(new Error('pick cancelled'));
    this.#pendingPick = null;
    this.#emitState();
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  addStep(input: StepInput, index?: number): Step {
    const step = this.#builder.push(input, Date.now());
    if (index !== undefined && index >= 0 && index < this.#builder.steps.length - 1) {
      this.#builder.steps.pop();
      this.#builder.steps.splice(index, 0, step);
    }
    this.emit('steps', this.steps);
    return step;
  }

  updateStep(id: string, patch: Partial<StepInput>): Step {
    const i = this.#builder.steps.findIndex((s) => s.id === id);
    if (i === -1) throw new Error(`no step ${id}`);
    const next = { ...this.#builder.steps[i], ...patch, id } as Step;
    this.#builder.steps[i] = next;
    this.emit('steps', this.steps);
    return next;
  }

  removeStep(id: string): void {
    this.#builder.steps = this.#builder.steps.filter((s) => s.id !== id);
    this.emit('steps', this.steps);
  }

  moveStep(id: string, to: number): void {
    const steps = this.#builder.steps;
    const i = steps.findIndex((s) => s.id === id);
    if (i === -1) return;
    const [s] = steps.splice(i, 1);
    steps.splice(Math.max(0, Math.min(to, steps.length)), 0, s);
    this.emit('steps', this.steps);
  }

  setSteps(steps: Step[]): void {
    this.#builder.steps = [...steps];
    this.emit('steps', this.steps);
  }

  acceptSuggestion(id: string): Step | undefined {
    const s = this.suggestions.find((x) => x.id === id);
    if (!s) return undefined;
    this.suggestions = this.suggestions.filter((x) => x.id !== id);
    return this.addStep({ kind: 'expect', check: s.check });
  }

  code(opts: SpecOptions): string { return generateSpec(this.steps, opts); }
  body(): string { return generateBody(this.steps); }

  // ── Event handling ──────────────────────────────────────────────────────

  #emitState() {
    this.emit('state', { recording: this.#recording, picking: this.#picking });
  }

  /** Whether an event belongs to the app under test (and not, say, to the Studio's own browser tab). */
  #relevant(e: RecordedEvent): boolean {
    const pid = this.app.pid;
    if (e.type === 'key') {
      if (e.pid === pid || e.focus?.pid === pid) return true;
      return e.focus?.dialog?.kind === 'filePanel';
    }
    if (e.pid === pid) return true;
    if (e.surface === 'notification') return true;
    return e.dialog?.kind === 'filePanel';
  }

  async #handle(e: RecordedEvent): Promise<void> {
    if (e.type === 'pick') {
      await this.#handlePick(e);
      return;
    }
    if (!this.#relevant(e)) {
      this.emit('ignored', { reason: `event targeted ${('app' in e && e.app) || `pid ${e.pid}`}, not the app under test`, event: e });
      return;
    }
    const target = e.type === 'key'
      ? (e.focus ? await this.#resolveTarget(e.focus) : undefined)
      : (e.element && needsTarget(e) ? await this.#resolveTarget(e) : undefined);

    const before = this.steps.length;
    const lastBefore = this.steps[before - 1];
    const step = this.#builder.apply(
      e.type === 'key' ? { type: 'key', event: e as RecordedKey, target } : { type: 'click', event: e as RecordedClick, target },
    );
    if (step) this.emit('step', { step, steps: this.steps });
    else if (this.steps.length !== before || this.steps[before - 1] !== lastBefore) this.emit('steps', this.steps);
  }

  async #handlePick(e: RecordedClick): Promise<void> {
    this.#picking = false;
    this.#emitState();
    const pending = this.#pendingPick;
    this.#pendingPick = null;
    if (!e.element) {
      pending?.reject(new Error('nothing accessible under the pointer'));
      return;
    }
    const target = await this.#resolveTarget(e);
    const el = e.element;
    const text = el.title ?? el.value ?? el.description;
    const result: PickResult = { target, text, enabled: el.enabled, context: e };
    this.emit('pick', result);
    pending?.resolve(result);
  }

  /** Scope + best verified selector for an element. */
  async #resolveTarget(ctx: ElementContext): Promise<Target> {
    const el = ctx.element!;
    const scope = scopeFor(ctx);
    const candidates = selectorCandidates(el, ctx.ancestors);
    const label = describeElement(el);
    const root = await this.#scopeRoot(ctx, scope).catch(() => undefined);
    if (!root) return { scope, selector: candidates[0], alternatives: candidates.slice(1), label, verified: false };

    const verified: string[] = [];
    let fallback: string | undefined;
    for (const cand of candidates) {
      let matches: AXNode[];
      try {
        matches = await this.driver.findAll(root, toSelectorPath(cand), { maxDepth: 0 });
      } catch {
        continue;
      }
      if (matches.length === 1) verified.push(cand);
      else if (matches.length > 1 && !fallback) {
        const idx = matches.findIndex((m) => sameRect(m.rect, el.rect));
        if (idx >= 0) fallback = withNth(cand, idx);
      }
      if (verified.length >= 3) break;
    }
    if (verified.length) {
      return { scope, selector: verified[0], alternatives: [...verified.slice(1), ...(fallback ? [fallback] : [])], label, verified: true };
    }
    if (fallback) return { scope, selector: fallback, alternatives: candidates, label, verified: true };
    return { scope, selector: candidates[0], alternatives: candidates.slice(1), label, verified: false };
  }

  /** The tree root a scope's selectors are resolved against. */
  async #scopeRoot(ctx: ElementContext, scope: Scope): Promise<Root | undefined> {
    switch (scope.kind) {
      case 'app':
      case 'trayPopup':
        return { pid: ctx.pid };
      case 'window': {
        const wins = await this.driver.windowList(ctx.pid);
        const w = wins.find((x) => x.title === scope.title) ?? wins.find((x) => x.main);
        return w ? { ref: w.ref } : { pid: ctx.pid };
      }
      case 'dialog': {
        const dialogs = await this.driver.dialogList(scope.dialogKind === 'filePanel' ? undefined : ctx.pid);
        const d = dialogs.find((x) => (scope.title ? x.title === scope.title : true)
          && (scope.text ? x.texts.includes(scope.text) : true));
        return d ? { ref: d.ref } : { pid: ctx.pid };
      }
    }
  }

  // ── Observers ───────────────────────────────────────────────────────────

  /** Records what is already on screen so only *new* things become suggestions. */
  async #primeObservers() {
    const [notes, dialogs, windows] = await Promise.all([
      this.app.notifications.list().catch(() => []),
      this.driver.dialogList(this.app.pid).catch(() => []),
      this.driver.windowList(this.app.pid).catch(() => []),
    ]);
    for (const n of notes) this.#seen.notifications.add(`${n.title}|${n.body}`);
    for (const d of dialogs) this.#seen.dialogs.add(`${d.title}|${d.texts.join('|')}`);
    for (const w of windows) this.#seen.windows.add(w.title);
  }

  async #observe() {
    if (!this.#recording) return;
    try {
      for (const n of await this.app.notifications.list().catch(() => [])) {
        const key = `${n.title}|${n.body}`;
        if (this.#seen.notifications.has(key)) continue;
        this.#seen.notifications.add(key);
        this.#suggest({ type: 'notification', title: n.title || undefined, body: n.title ? undefined : n.body });
      }
      for (const d of await this.driver.dialogList(this.app.pid).catch(() => [])) {
        const key = `${d.title}|${d.texts.join('|')}`;
        if (this.#seen.dialogs.has(key)) continue;
        this.#seen.dialogs.add(key);
        const id = dialogIdentity({ pid: d.pid, app: d.app, bundleId: d.bundleId, surface: 'dialog', dialog: { kind: d.kind, title: d.title, texts: d.texts } });
        this.#suggest({ type: 'dialog', title: id.title, text: id.text });
      }
      for (const w of await this.driver.windowList(this.app.pid).catch(() => [])) {
        if (!w.title || this.#seen.windows.has(w.title)) continue;
        this.#seen.windows.add(w.title);
        this.#suggest({ type: 'window', title: w.title });
      }
    } catch {
      // Observation is best-effort; a transient AX failure is not worth surfacing.
    }
  }

  #suggest(check: Check) {
    const s: Suggestion = {
      id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      label: describeStep({ kind: 'expect', check }),
      check,
      at: Date.now(),
    };
    this.suggestions.push(s);
    this.emit('suggestion', s);
  }
}

/** Surfaces whose steps are addressed by path or by dialog button, not by selector. */
function needsTarget(e: RecordedClick): boolean {
  return !['tray', 'trayMenu', 'menuBar', 'notification'].includes(e.surface);
}

export function scopeFor(ctx: ElementContext): Scope {
  switch (ctx.surface) {
    case 'dialog': {
      const id = dialogIdentity(ctx);
      return { kind: 'dialog', title: id.title, text: id.text, dialogKind: id.kind };
    }
    case 'window':
      return ctx.window?.title ? { kind: 'window', title: ctx.window.title } : { kind: 'app' };
    default:
      return { kind: 'app' };
  }
}
