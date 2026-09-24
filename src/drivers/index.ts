import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Driver } from './driver.ts';
import { UnsupportedError } from '../core/errors.ts';

export type DriverOptions = { onStderr?: (line: string) => void };

/**
 * Where each platform's driver lives. Adding a platform means adding a file
 * here and an entry below; nothing above the `Driver` interface changes.
 *
 * Drivers are imported lazily so a machine only ever loads its own, and so a
 * driver that has not been written yet is a clear error rather than a crash at
 * import time.
 */
const DRIVERS: Partial<Record<NodeJS.Platform, { file: string; export: string }>> = {
  darwin: { file: './macos.ts', export: 'MacOSDriver' },
  win32: { file: './windows.ts', export: 'WindowsDriver' },
};

export function isPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  const entry = DRIVERS[platform];
  return !!entry && existsSync(fileURLToPath(new URL(entry.file, import.meta.url)));
}

export async function createDriver(opts: DriverOptions = {}): Promise<Driver> {
  const entry = DRIVERS[process.platform];
  const url = entry ? new URL(entry.file, import.meta.url) : undefined;
  if (!entry || !url || !existsSync(fileURLToPath(url))) {
    throw new UnsupportedError(
      `the ${process.platform} driver`,
      `${process.platform} — see docs/WINDOWS.md for how a platform driver is added`,
    );
  }
  const mod = (await import(url.href)) as Record<string, new (o: DriverOptions) => Driver>;
  const Ctor = mod[entry.export];
  if (typeof Ctor !== 'function') {
    throw new Error(`${entry.file} does not export a class named ${entry.export}`);
  }
  return new Ctor(opts);
}
