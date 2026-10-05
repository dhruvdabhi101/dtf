/**
 * What happened when, shared by one test's perf monitors and chaos faults, so
 * a report can show "CPU spiked 3 s after Wi-Fi came back" rather than two
 * unrelated logs.
 */
export type TimelineEvent = {
  at: number;
  kind: 'phase-start' | 'phase-end' | 'fault-start' | 'fault-end' | 'mark';
  label: string;
  detail?: string;
};

export class Timeline {
  readonly events: TimelineEvent[] = [];
  #listeners = new Set<(e: TimelineEvent) => void>();

  add(kind: TimelineEvent['kind'], label: string, detail?: string): TimelineEvent {
    const e: TimelineEvent = { at: Date.now(), kind, label, detail };
    this.events.push(e);
    for (const fn of this.#listeners) fn(e);
    return e;
  }

  on(fn: (e: TimelineEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}
