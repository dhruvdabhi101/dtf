# Performance and chaos testing

Two fixtures on every test's context:

- **`ctx.perf`** measures what an app costs (CPU, memory, disk I/O, handles,
  threads, network) while it runs the way users run it: in the background,
  while someone uses the machine.
- **`ctx.chaos`** breaks things on purpose: crashes, hangs, network loss and
  latency, CPU and memory starvation, a full disk. Every fault is undone
  afterwards, including when the run itself crashes.

The Worktrace suites in `examples/worktrace/perf` and `examples/worktrace/chaos`
show both in full.

## Perf

```ts
test('recording while the user browses', async ({ app, perf }) => {
  const browser = await perf.openBrowser();                 // scripted "normal user"
  const mon = await perf.monitor([app, { label: 'Browser', pid: browser.app.pid }]);

  await perf.idle('idle', 60_000);                            // baseline phase
  await perf.phase('browsing', () =>
    browser.run({ preset: 'browse-news', durationMs: 10 * 60_000, seed: 42 }));

  const report = await mon.stop();
  report.assertBudgets({ target: app.name, phase: 'browsing', cpuP95: 50, memSlopeMBPerHour: 100 });
  report.assertNoRegression('baselines/win32.json', { tolerance: 0.2 });
});
```

### What is measured

A target is an app (its whole process tree: Electron's renderer, GPU and
utility helpers, and any sidecar it spawns), an executable name (`'chrome'`),
or `{ label, pid?, name? }`. Each tick, per target:

| metric | Windows | macOS |
|---|---|---|
| CPU (% of one core; also ÷ cores) | `GetProcessTimes` | `ps` |
| memory | private bytes + working set | resident size |
| disk read/write | `GetProcessIoCounters` | – |
| handles, threads | yes | – |
| network per process | – (see below) | `nettop` (best effort) |

Plus the whole machine (CPU, memory, adapter bytes) and, when the app runs
through dtf's proxy, its traffic per host.

Sampling runs outside the test runner (a PowerShell/C# loop on Windows, `ps`
on macOS), so a busy test does not skew its own numbers.

**Network per process on Windows.** Windows has no per-process byte counters
without an ETW trace (administrator). dtf measures the app's traffic instead by
launching it through a local proxy: set `networkProxy: true` in the config.
Chromium traffic follows `--proxy-server`; Node, Rust and Go clients follow
`HTTPS_PROXY`. Traffic that ignores both is not counted; the machine-wide
adapter counters still show it.

### Phases, reports, budgets, baselines

- `perf.phase(name, fn)` / `perf.idle(name, ms)` mark phases. Each report has
  stats per phase and for `all` (the recording minus `warmupMs`).
- Stats are distributions (`mean`, `p50`, `p95`, `max`), not averages: capture
  spikes are short, and a mean hides or exaggerates them. Memory, handles and
  threads also carry `growth` and `slopePerHour`, a least-squares fit that sees
  past garbage-collection sawtooth. It is the leak signal.
- `mon.stop()` writes `samples.ndjson`, `data.json`, `summary.json` and a
  self-contained `report.html` to `dtf-artifacts/perf/<test>/…`, and the
  runner attaches the summary table to the test result. `dtf perf report <dir>`
  rebuilds the HTML.
- `report.assertBudgets(budgets)`: `cpuMean`, `cpuP95`, `cpuMax`, `memMaxMB`,
  `memGrowthMB`, `memSlopeMBPerHour`, `handlesGrowth`, `threadsGrowth`,
  `ioWriteMBpsMean`, `netBytesPerMin`, `systemCpuMean`, per target and phase.
  Config `perf.budgets` sets defaults for `perf.assertBudgets(report)`. A budget
  naming a target or phase the recording does not have is an error.
- `report.assertNoRegression(path, { tolerance })` compares with a saved
  summary (written on first use). Each metric has an absolute noise floor, so
  going from 5% to 6% CPU is not a "20% regression". Keep baselines per
  machine: numbers from different hardware do not compare.

### The workload

`perf.openBrowser()` launches an isolated Chromium profile (Chrome for Testing
when installed) and drives it over DevTools. `run({ preset, durationMs, seed })`:

| preset | does |
|---|---|
| `browse-news` | news, Wikipedia, GitHub; scrolls; sometimes types a search |
| `docs-reading` | long dwell on documentation pages, slow scrolling |
| `video` | a looping muted YouTube embed |
| `idle` | a blank page |

Or pass `urls`. The same seed replays the same pages, pauses and scrolls.

### A/B

```ts
const result = await perf.ab({
  targets: [app, { label: 'Browser', pid: browser.app.pid }],
  variants: {
    'recording-on': { setup: () => startRecording(app) },
    'recording-off': { setup: () => stopRecording(app) },
  },
  run: () => browser.run({ preset: 'browse-news', durationMs: 180_000, seed: 7 }),
  repeat: 3,
});
result.delta('recording-on', 'recording-off', 'Browser'); // what recording costs the user's own work
```

Rounds alternate (A B B A …) so machine drift hits both variants, and each
figure is the median across rounds.

## Chaos

```ts
test('survives two minutes offline', async ({ app, chaos }) => {
  await chaos.with(chaos.network.offline(), () => sleep(120_000));  // restored here, always
  await app.tray.shouldExist();
});
```

A fault is injected when created and undone by `fault.restore()`, at the end of
`chaos.with(...)`, after `durationMs`, or when the test ends.

### Faults

| fault | how | needs |
|---|---|---|
| `process.kill(app, { which, how })` | `kill`, `crash` (access violation / SIGSEGV) or `abort`; `which`: `main`, `renderer`, `gpu`, `utility`, `sidecar`, `child`, `random-child`, `tree`, a pid | – |
| `process.suspend(app, { which })` | freezes processes (`NtSuspendProcess` / SIGSTOP) | – |
| `process.killLoop({ … })` | kills at seeded random moments, with your recover + check steps between | – |
| `network.offline()` | proxy: only the app loses the network; `style` `refuse`, `reset` or `hang` | `networkProxy` |
| `network.offline({ via: 'firewall', target })` | Windows Firewall blocks every executable in the app's tree | admin |
| `network.offline({ via: 'wifi' })` | disconnects Wi-Fi (`netsh wlan` / `networksetup`), so the OS itself reports offline | destructive |
| `network.offline({ via: 'adapter' })` | disables the default-route adapter | admin, destructive |
| `network.latency / throttle / loss / profile` | proxy shaping for the app; `via: 'os'` shapes every program with clumsy (Windows) or dummynet (macOS) | proxy; `os`: admin, destructive |
| `network.dnsFail / stall({ hosts })` | lookups fail; connections open and never progress | `networkProxy` |
| `network.flap({ downMs, upMs, cycles })` | repeated drops | as `offline` |
| `cpu.stress({ load, threads, priority })` | busy threads in a separate process | – |
| `cpu.cap(app, { percent })` | Windows: job-object hard cap on the tree (% of the machine). macOS: renice +20 | – |
| `memory.stress({ usedFraction })` | holds the machine at e.g. 95% used, never below `minFreeMB` | destructive |
| `memory.cap(app, { mb })` | Windows job-object commit limit: the app's allocations past it fail | Windows |
| `memory.pressure(level)` | macOS `memory_pressure`; elsewhere memory stress | destructive |
| `disk.fill({ path, leaveMB })` | fills the volume holding `path` | destructive |
| `random({ faults, durationMs })` | seeded random faults with an invariant check after each | – |

Network profiles: `slow-3g`, `3g`, `edge`, `satellite`, `lossy`, `flaky`,
`extreme-latency`.

### Safety

- **Destructive faults** (machine-wide: Wi-Fi, adapters, OS-level shaping,
  memory and disk exhaustion) refuse to run unless `chaos.allowDestructive` is
  set, `--allow-destructive` is passed, or `DTF_CHAOS_DESTRUCTIVE=1`. Do not
  run them over a remote session: you may lose the connection you are using.
- **Admin faults** say so up front instead of failing halfway. `dtf doctor`
  shows what this machine can run.
- **The restore journal.** Before a fault is injected, its undo steps are
  written to `%TEMP%\dtf-chaos` (`$TMPDIR/dtf-chaos`). A detached **watchdog**
  per fault undoes it at its deadline (`chaos.maxFaultMs`, default 10 min) or
  as soon as the runner process dies. `dtf run` replays leftovers at start;
  `dtf chaos status` and `dtf chaos restore` do it by hand.
- **Replay.** Randomized faults use a seeded RNG. The seed is in the test's
  attachments; `--seed <n>` repeats the run.

### Recovering from a kill

`app.relaunch()` starts the app again with the same executable, arguments and
user-data dir, runs the config's `beforeLaunch` first (for lock files a killed
instance leaves behind), and points `app` and all its surfaces at the new
process. `app.logCursor()` before the fault plus `app.shouldNotLog(pattern,
{ since })` after it checks only what happened during the recovery.

## Limitations

- CPU caps on processes already inside a job that forbids nesting (some
  Chromium sandboxed renderers) fail for those processes; they are listed in the
  chaos log. New processes the app starts later join the cap.
- Clearing a CPU cap needs the job's name, which lives as long as one handle to
  it does. dtf parks that handle in the app's main process, so the cap can be
  lifted as long as the app runs (and once it exits there is nothing to lift).
- Proxy faults only affect traffic that goes through the proxy; use `firewall`
  or `wifi` for the rest.
- macOS network-per-process figures come from `nettop`, whose output is not a
  stable interface. OS-level shaping on macOS uses `pfctl`/`dnctl` through
  `sudo -n`.
