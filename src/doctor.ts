import type { Driver, PreflightCheck } from './drivers/driver.ts';
import { createDriver, isPlatformSupported } from './drivers/index.ts';

export type { PreflightCheck };

/**
 * Preflight.
 *
 * Desktop test runs fail for environmental reasons far more often than for code
 * reasons — a missing permission, a Focus mode swallowing banners, a screen
 * lock. Checking those up front turns a confusing red suite into one clear line.
 *
 * Generic checks live here; anything OS-specific comes from the driver's own
 * `preflight()`, so a new platform brings its own checks with it.
 */
export async function runDoctor(existing?: Driver): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: nodeOk
      ? `node ${process.version}`
      : `node ${process.version} is too old — dtf needs >= 22.18 for native TypeScript support`,
  });

  if (!isPlatformSupported()) {
    checks.push({
      name: 'platform',
      ok: false,
      detail: `${process.platform} has no driver yet (see docs/WINDOWS.md)`,
    });
    return checks;
  }

  const driver = existing ?? (await createDriver());
  try {
    await driver.start();
    checks.push({ name: 'platform', ok: true, detail: driver.platformName });
    checks.push({ name: 'native driver', ok: true, detail: 'built and responding' });

    const ax = await driver.checkAutomationPermission();
    checks.push({ name: 'automation permission', ok: ax.granted, detail: ax.detail });

    const sc = await driver.checkScreenRecordingPermission();
    checks.push({
      name: 'screen capture',
      ok: sc.granted ? true : 'warn',
      detail: sc.granted
        ? 'granted — screenshots will capture window content'
        : 'not granted — tests still run, but failure screenshots will be blank',
    });

    checks.push(...(await driver.preflight()));

    const screens = await driver.screenInfo();
    checks.push({
      name: 'displays',
      ok: screens.length > 0,
      detail: screens.length
        ? screens.map((s) => `${s.frame.width}x${s.frame.height} @${s.scale}x${s.main ? ' (main)' : ''}`).join(', ')
        : 'no display — dtf needs a logged-in graphical session',
    });

    const trays = await driver.trayList();
    checks.push({ name: 'tray enumeration', ok: true, detail: `${trays.length} tray item(s) visible` });
  } catch (err) {
    checks.push({ name: 'native driver', ok: false, detail: err instanceof Error ? err.message : String(err) });
  } finally {
    if (!existing) await driver.stop().catch(() => {});
  }
  return checks;
}

export function doctorPassed(checks: PreflightCheck[]): boolean {
  return checks.every((c) => c.ok !== false);
}
