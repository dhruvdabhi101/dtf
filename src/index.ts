/**
 * dtf — OS-level end-to-end testing for desktop apps.
 *
 * The framework tests an app from *outside* the process, through the operating
 * system's own accessibility and input layers. That is the only vantage point
 * from which tray icons, notification banners, native dialogs, file panels and
 * permission prompts are observable at all — none of them live inside the app's
 * renderer, so no in-process test harness can see them.
 */

export { DesktopApp, type LogLine } from './app.ts';
export { Locator } from './surfaces/locator.ts';
export { TraySurface, TrayPopup, type TrayQuery } from './surfaces/tray.ts';
export { BrowserSurface, type OpenPage } from './surfaces/browser.ts';
export { NotificationSurface, type NotificationQuery } from './surfaces/notifications.ts';
export { DialogSurface, DialogHandle, type DialogQuery } from './surfaces/dialogs.ts';
export { MenuSurface } from './surfaces/menu.ts';
export { WindowSurface, WindowHandle, type WindowQuery } from './surfaces/windows.ts';
export { PermissionSurface } from './surfaces/permissions.ts';

export { describe, test, it, beforeAll, afterAll, beforeEach, afterEach, type TestContext } from './runner/registry.ts';
export { defineConfig, loadConfig, loadConfigFrom, type DTFConfig, type AppConfig, type AppPath } from './runner/config.ts';
export { runTests, collectTests, type RunOptions, type CollectedFile } from './runner/run.ts';
export { createDriver, isPlatformSupported } from './drivers/index.ts';
export {
  PrettyReporter, JsonReporter, JUnitReporter, StreamReporter,
  type Reporter, type RunEvent, type TestResult, type RunSummary,
} from './runner/reporter.ts';
export { runDoctor } from './doctor.ts';

export { RecordingSession, type Suggestion, type PickResult } from './recorder/session.ts';
export { StepBuilder, describeStep, type Step, type StepInput, type Target, type Check } from './recorder/steps.ts';
export { generateSpec, generateBody, appendToSpec } from './recorder/codegen.ts';
export { selectorCandidates } from './recorder/selectors.ts';

export {
  PostHogServer, type PostHogServerOptions, type CapturedEvent, type CapturedRequest, type EventQuery, type FlagValue,
} from './fakes/posthog.ts';

export { aiAssert, aiCheck, type AIOptions, type AIResult } from './ai/agent.ts';

export { Perf, PerfMonitor, PerfReport, AbResult, Timeline, BrowserWorkload, type PerfConfig, type AbOptions, type AbVariant } from './perf/index.ts';
export type { PerfTarget, MonitorOptions } from './perf/monitor.ts';
export type { Budget, BudgetViolation, Regression, PerfSummary, TargetPhaseStats } from './perf/report.ts';
export type { WorkloadPreset, WorkloadRunOptions } from './perf/workload.ts';
export { Chaos, type ChaosConfig, type Fault, type ProcessTarget } from './chaos/index.ts';
export type { ProcInfo, ProcKind, ProcSelector } from './chaos/procs.ts';
export { NetworkProxy, NETWORK_PROFILES, type NetConditions, type NetworkProfile } from './net/proxy.ts';
export { Rng } from './core/random.ts';

export { MacOSDriver } from './drivers/macos.ts';
export type { Driver, PreflightCheck } from './drivers/driver.ts';

export { waitFor, sleep } from './core/wait.ts';
export { AssertionError, DriverError, TimeoutError, UnsupportedError } from './core/errors.ts';
export { toSelectorPath } from './core/selector.ts';

export type * from './types.ts';
