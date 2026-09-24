import { TimeoutError } from './errors.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type WaitOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  /** Used in the timeout message, e.g. "the Quit menu item". */
  description?: string;
};

/**
 * Polls `fn` until it returns a truthy value.
 *
 * Every assertion and query in the framework goes through this. UI is
 * asynchronous in ways you cannot instrument from outside the process — a menu
 * takes a frame to draw, a notification takes a moment to be posted — so the
 * default posture is "retry until the deadline" rather than "check once".
 */
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  opts: WaitOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw new TimeoutError(opts.description ?? 'condition', timeoutMs, lastError);
    }
    await sleep(intervalMs);
  }
}

/** Runs `fn` and resolves to undefined instead of throwing. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
