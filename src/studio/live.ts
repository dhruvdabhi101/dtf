import { EventEmitter } from 'node:events';

import type { Driver } from '../drivers/driver.ts';
import { createDriver } from '../drivers/index.ts';
import { DesktopApp } from '../app.ts';
import type { LaunchOptions, RecordedEvent, SelectorPath } from '../types.ts';
import { toSelectorPath } from '../core/selector.ts';
import { RecordingSession, type PickResult, type Suggestion } from '../recorder/session.ts';
import { describeStep, type Step, type StepInput } from '../recorder/steps.ts';
import { selectorCandidates } from '../recorder/selectors.ts';

export type LiveEvent =
  | { type: 'recorder:state'; state: RecorderState }
  | { type: 'recorder:steps'; steps: Step[] }
  | { type: 'recorder:suggestion'; suggestion: Suggestion }
  | { type: 'recorder:pick'; pick: PickResult }
  | { type: 'recorder:ignored'; reason: string }
  | { type: 'recorder:error'; message: string }
  | { type: 'inspect:pick'; pick: unknown };

export type RecorderState = {
  recording: boolean;
  picking: boolean;
  app?: { pid: number; name: string; bundleId: string; launched: boolean };
  steps: Step[];
  suggestions: Suggestion[];
};

/**
 * Everything in the Studio that talks to the OS directly (as opposed to runs,
 * which happen in a child process): the recorder, the inspector, and the list
 * of running apps. They share one native helper, started lazily.
 */
export class LiveManager extends EventEmitter<{ event: [LiveEvent] }> {
  #driver: Driver | null = null;
  #starting: Promise<Driver> | null = null;
  #session: RecordingSession | null = null;
  #app: DesktopApp | null = null;
  #launched = false;
  #inspectPicking = false;

  async driver(): Promise<Driver> {
    if (this.#driver) return this.#driver;
    this.#starting ??= (async () => {
      const d = await createDriver();
      await d.start();
      this.#driver = d;
      return d;
    })();
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  get busy(): boolean { return !!this.#session?.recording; }

  state(): RecorderState {
    return {
      recording: this.#session?.recording ?? false,
      picking: this.#session?.picking ?? this.#inspectPicking,
      app: this.#app ? { pid: this.#app.pid, name: this.#app.name, bundleId: this.#app.bundleId, launched: this.#launched } : undefined,
      steps: this.#session?.steps ?? [],
      suggestions: this.#session?.suggestions ?? [],
    };
  }

  #publish(e: LiveEvent) { this.emit('event', e); }
  #publishState() { this.#publish({ type: 'recorder:state', state: this.state() }); }

  async apps() {
    const d = await this.driver();
    const list = await d.listApps();
    return list
      .filter((a) => a.name && a.pid !== process.pid)
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  // ── Recording ───────────────────────────────────────────────────────────

  async startRecording(target: { launch?: LaunchOptions; pid?: number }, keepSteps = false): Promise<RecorderState> {
    if (this.#session?.recording) throw Object.assign(new Error('already recording'), { status: 409 });
    const d = await this.driver();
    const perm = await d.checkAutomationPermission();
    if (!perm.granted) throw new Error(perm.detail);

    // Reuse the running app when re-recording against the same one, so
    // "record more steps" does not relaunch it.
    const reuse = this.#app && (await this.#app.isRunning()) && (
      (target.pid && this.#app.pid === target.pid) || (target.launch && this.#launched)
    );
    if (!reuse) {
      await this.#closeApp();
      if (target.launch) {
        this.#app = await DesktopApp.launch(d, target.launch);
        this.#launched = true;
      } else if (target.pid) {
        this.#app = await DesktopApp.attach(d, { pid: target.pid });
        this.#launched = false;
      } else {
        throw new Error('choose an app to record: launch the configured app or attach to a running one');
      }
    }

    const previous = keepSteps ? this.#session?.steps ?? [] : [];
    const session = new RecordingSession(d, this.#app!);
    if (previous.length) session.setSteps(previous);
    session.on('step', ({ steps }) => this.#publish({ type: 'recorder:steps', steps }));
    session.on('steps', (steps) => this.#publish({ type: 'recorder:steps', steps }));
    session.on('suggestion', (suggestion) => this.#publish({ type: 'recorder:suggestion', suggestion }));
    session.on('pick', (pick) => this.#publish({ type: 'recorder:pick', pick }));
    session.on('ignored', ({ reason }) => this.#publish({ type: 'recorder:ignored', reason }));
    session.on('error', (err) => this.#publish({ type: 'recorder:error', message: err.message }));
    session.on('state', () => this.#publishState());
    this.#session = session;
    await session.start();
    this.#publishState();
    return this.state();
  }

  async stopRecording(): Promise<RecorderState> {
    await this.#session?.stop();
    this.#publishState();
    return this.state();
  }

  async pick(): Promise<void> {
    const s = this.#requireSession();
    // The result is delivered as a `recorder:pick` event; the request returns at once.
    s.pick().catch((err: Error) => this.#publish({ type: 'recorder:error', message: err.message }));
  }

  async cancelPick() { await this.#session?.cancelPick(); }

  addStep(input: StepInput, index?: number) { return this.#requireSession(true).addStep(input, index); }
  updateStep(id: string, patch: Partial<StepInput>) { return this.#requireSession(true).updateStep(id, patch); }
  removeStep(id: string) { this.#requireSession(true).removeStep(id); }
  moveStep(id: string, to: number) { this.#requireSession(true).moveStep(id, to); }
  acceptSuggestion(id: string) {
    const step = this.#requireSession(true).acceptSuggestion(id);
    this.#publishState();
    return step;
  }

  dismissSuggestion(id: string) {
    const s = this.#requireSession(true);
    s.suggestions = s.suggestions.filter((x) => x.id !== id);
    this.#publishState();
  }

  clear() {
    if (this.#session) this.#session.setSteps([]);
    if (this.#session) this.#session.suggestions = [];
    this.#publishState();
  }

  steps(): Step[] { return this.#session?.steps ?? []; }

  describe(): string[] { return this.steps().map(describeStep); }

  #requireSession(allowStopped = false): RecordingSession {
    const s = this.#session;
    if (!s) throw Object.assign(new Error('no recording session; start recording first'), { status: 409 });
    if (!allowStopped && !s.recording) throw Object.assign(new Error('recording is stopped'), { status: 409 });
    return s;
  }

  async #closeApp() {
    if (this.#app && this.#launched) await this.#app.close().catch(() => {});
    this.#app = null;
    this.#launched = false;
  }

  /** Closes the app the recorder launched. Attached apps are left alone. */
  async closeApp(): Promise<void> {
    if (this.#session?.recording) await this.#session.stop();
    await this.#closeApp();
    this.#publishState();
  }

  // ── Inspector ───────────────────────────────────────────────────────────

  async tree(pid: number, depth = 8) {
    const d = await this.driver();
    await d.setElectronAccessibility(pid).catch(() => {});
    return d.tree({ pid }, { maxDepth: depth, maxNodes: 5000 });
  }

  async query(pid: number, selector: SelectorPath) {
    const d = await this.driver();
    const path = toSelectorPath(selector);
    const nodes = await d.findAll({ pid }, path, { maxDepth: 0 });
    return { count: nodes.length, nodes: nodes.slice(0, 50) };
  }

  /**
   * Pick an element on screen to inspect: the next click is swallowed and the
   * element under it described, with selector suggestions. Works whether or
   * not a recording is running.
   */
  async inspectPick(): Promise<void> {
    const d = await this.driver();
    if (this.#session?.recording) {
      this.#session.pick()
        .then((pick) => this.#publish({ type: 'inspect:pick', pick }))
        .catch((err: Error) => this.#publish({ type: 'recorder:error', message: err.message }));
      return;
    }
    if (this.#inspectPicking) return;
    this.#inspectPicking = true;
    this.#publishState();
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      this.#inspectPicking = false;
      await d.recordStop().catch(() => {});
      this.#publishState();
    };
    await d.recordStart((e: RecordedEvent) => {
      if (e.type !== 'pick') return;
      void finish();
      const candidates = e.element ? selectorCandidates(e.element, e.ancestors) : [];
      this.#publish({ type: 'inspect:pick', pick: { context: e, candidates } });
    });
    await d.recordPick(true);
    setTimeout(() => { void finish(); }, 60_000).unref();
  }

  async dispose() {
    await this.#session?.stop().catch(() => {});
    await this.#closeApp();
    await this.#driver?.stop().catch(() => {});
  }
}
