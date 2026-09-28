/**
 * A failure that came back from the native driver.
 *
 * These carry the driver's error code so callers (and the retry helpers) can
 * distinguish "not there *yet*" from "will never be there".
 */
export class DriverError extends Error {
  code: string;
  op: string;

  constructor(code: string, message: string, op: string) {
    super(`[${code}] ${message}`);
    this.name = 'DriverError';
    this.code = code;
    this.op = op;
  }

  /** Codes that mean "the UI has not settled", i.e. worth polling through. */
  get transient(): boolean {
    return ['notFound', 'staleRef', 'noGeometry', 'trayNoContent', 'noNotification'].includes(this.code);
  }
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number, lastError?: unknown) {
    const tail = lastError instanceof Error ? `\n  last error: ${lastError.message}` : '';
    super(`timed out after ${ms}ms waiting for ${what}${tail}`);
    this.name = 'TimeoutError';
  }
}

export class AssertionError extends Error {
  expected: unknown;
  actual: unknown;

  constructor(message: string, expected?: unknown, actual?: unknown) {
    super(message);
    this.name = 'AssertionError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class UnsupportedError extends Error {
  /** `reason`, when given, replaces "is not implemented": for things the OS forbids rather than ones dtf lacks. */
  constructor(feature: string, platform: string, reason?: string) {
    super(reason ? `${feature} is not possible on this ${platform} machine: ${reason}` : `${feature} is not implemented on ${platform}`);
    this.name = 'UnsupportedError';
  }
}
