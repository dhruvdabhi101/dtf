import type { DesktopApp } from '../app.ts';
import type { CdpPage } from '../browsers/cdp.ts';
import type { Driver } from '../drivers/driver.ts';
import { BrowserSurface } from '../surfaces/browser.ts';
import { Rng } from '../core/random.ts';
import { sleep } from '../core/wait.ts';
import type { Timeline } from './timeline.ts';

/**
 * "Someone using the computer normally", as a repeatable script: a real
 * Chromium browser (Chrome for Testing when installed, else the system's)
 * that visits pages, reads, scrolls and searches on a seeded schedule.
 *
 * It runs next to the app under test, so a perf test measures the app the way
 * users run it (in the background, while they do something else) and can
 * measure what the app costs the browser.
 *
 * The same seed replays the same pages, pauses and scrolls, which is what
 * makes two runs comparable at all.
 */

export type WorkloadPreset = 'browse-news' | 'docs-reading' | 'video' | 'idle';

export const WORKLOAD_URLS: Record<Exclude<WorkloadPreset, 'idle'>, string[]> = {
  'browse-news': [
    'https://en.wikipedia.org/wiki/Special:Random',
    'https://news.ycombinator.com/',
    'https://www.bbc.com/news',
    'https://github.com/trending',
    'https://stackoverflow.com/questions',
    'https://www.theverge.com/',
    'https://developer.mozilla.org/en-US/',
    'https://www.reuters.com/',
  ],
  'docs-reading': [
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide',
    'https://nodejs.org/api/fs.html',
    'https://docs.python.org/3/tutorial/index.html',
    'https://learn.microsoft.com/en-us/windows/win32/api/',
    'https://www.electronjs.org/docs/latest/',
  ],
  // Big Buck Bunny, muted so autoplay is allowed.
  'video': ['https://www.youtube.com/embed/aqz-KE-bpKQ?autoplay=1&mute=1&loop=1&playlist=aqz-KE-bpKQ'],
};

export type WorkloadRunOptions = {
  preset?: WorkloadPreset;
  /** Your own pages instead of a preset's. */
  urls?: string[];
  durationMs: number;
  seed?: number;
  /** How long to stay on each page, [min, max] ms. Defaults by preset. */
  dwellMs?: [number, number];
  /** Type a query into Wikipedia's search now and then. On for `browse-news`. */
  search?: boolean;
};

export type WorkloadStep = { at: number; action: 'navigate' | 'scroll' | 'search' | 'idle'; detail: string };

export class BrowserWorkload {
  readonly app: DesktopApp;
  #cdp: CdpPage | null;
  #timeline: Timeline | null;
  readonly steps: WorkloadStep[] = [];

  private constructor(app: DesktopApp, cdp: CdpPage | null, timeline: Timeline | null) {
    this.app = app;
    this.#cdp = cdp;
    this.#timeline = timeline;
  }

  /** Launches an isolated browser profile. Its process tree is a perf target like any app: `perf.monitor([app, workload.app])`. */
  static async open(driver: Driver, opts: { bundleId?: string; extraArgs?: string[]; timeline?: Timeline } = {}): Promise<BrowserWorkload> {
    const surface = new BrowserSurface(driver);
    const app = await surface.launchIsolated('about:blank', {
      bundleId: opts.bundleId,
      extraArgs: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', ...(opts.extraArgs ?? [])],
    });
    // The browser's own name makes a clearer report label than its executable.
    return new BrowserWorkload(app, surface.cdp(app), opts.timeline ?? null);
  }

  async #navigate(url: string) {
    if (!this.#cdp || this.#cdp.closed) throw new Error('the workload browser has no DevTools connection (was it closed?)');
    const loaded = new Promise<void>((resolve) => {
      const off = this.#cdp!.on('Page.loadEventFired', () => { off(); resolve(); });
      setTimeout(() => { off(); resolve(); }, 20_000).unref();
    });
    await this.#cdp.send('Page.navigate', { url }).catch(() => {});
    await loaded;
  }

  async #scroll(rng: Rng) {
    const dy = rng.int(200, 900) * (rng.chance(0.15) ? -1 : 1);
    await this.#cdp?.evaluate(`window.scrollBy({ top: ${dy}, behavior: 'smooth' })`).catch(() => {});
  }

  async #search(rng: Rng) {
    const words = ['electron', 'operating system', 'compression', 'history of computing', 'neural network', 'coffee', 'volcano', 'typescript'];
    const q = rng.pick(words);
    await this.#navigate('https://en.wikipedia.org/wiki/Special:Search');
    const cdp = this.#cdp!;
    await cdp.evaluate(`(() => { const i = document.querySelector('input[name=search]'); if (i) { i.focus(); i.value = ''; } })()`).catch(() => {});
    for (const ch of q) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch }).catch(() => {});
      await sleep(rng.int(60, 220));
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }).catch(() => {});
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }).catch(() => {});
    return q;
  }

  #log(action: WorkloadStep['action'], detail: string) {
    this.steps.push({ at: Date.now(), action, detail });
  }

  /** Browses for `durationMs`. Returns the steps it took, which a given seed always repeats. */
  async run(opts: WorkloadRunOptions): Promise<WorkloadStep[]> {
    const preset = opts.preset ?? (opts.urls ? undefined : 'browse-news');
    const rng = new Rng(opts.seed ?? 42);
    const end = Date.now() + opts.durationMs;
    const remaining = () => end - Date.now();
    this.#timeline?.add('mark', `workload ${preset ?? 'custom'} (seed ${rng.seed})`);

    if (preset === 'idle') {
      await this.#navigate('about:blank');
      this.#log('idle', `${opts.durationMs}ms`);
      await sleep(Math.max(0, remaining()));
      return this.steps;
    }

    const urls = opts.urls ?? WORKLOAD_URLS[preset!];
    if (preset === 'video') {
      await this.#navigate(urls[0]);
      this.#log('navigate', urls[0]);
      await sleep(Math.max(0, remaining()));
      return this.steps;
    }

    const [dmin, dmax] = opts.dwellMs ?? (preset === 'docs-reading' ? [20_000, 60_000] : [8_000, 25_000]);
    const search = opts.search ?? preset === 'browse-news';
    while (remaining() > 1000) {
      if (search && rng.chance(0.2)) {
        const q = await this.#search(rng);
        this.#log('search', q);
      } else {
        const url = rng.pick(urls);
        await this.#navigate(url);
        this.#log('navigate', url);
      }
      const dwellEnd = Date.now() + Math.min(rng.int(dmin, dmax), remaining());
      while (Date.now() < dwellEnd) {
        await sleep(Math.min(rng.int(1200, 4000), Math.max(0, dwellEnd - Date.now())));
        if (Date.now() >= dwellEnd) break;
        await this.#scroll(rng);
        this.#log('scroll', '');
      }
    }
    return this.steps;
  }

  async close(): Promise<void> {
    this.#cdp?.close();
    await this.app.close({ force: true }).catch(() => {});
  }
}
