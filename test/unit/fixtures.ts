import type { ElementContext, RecordedClick, RecordedKey } from '../../src/types.ts';
import type { Target } from '../../src/recorder/steps.ts';

let seq = 0;
let clock = 1_000_000;

/** A recorded click with sensible defaults; override what the test cares about. */
export function click(ctx: Partial<RecordedClick> & Pick<ElementContext, 'surface'>): RecordedClick {
  clock += 1000;
  return {
    seq: ++seq, type: 'click', button: 'left', count: 1, modifiers: [], x: 10, y: 10, at: clock,
    pid: 42, app: 'Fixture', bundleId: 'com.example.fixture',
    ...ctx,
  };
}

export function key(k: string, text = k, modifiers: string[] = [], extra: Partial<RecordedKey> = {}): RecordedKey {
  clock += 50;
  return { seq: ++seq, type: 'key', key: k, text, modifiers, repeat: false, pid: 42, at: clock, ...extra };
}

export function target(selector: string, label = selector, title = 'Main'): Target {
  return { scope: { kind: 'window', title }, selector, label, verified: true };
}

export function advance(ms: number) { clock += ms; }
