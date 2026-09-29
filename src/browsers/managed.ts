import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const run = promisify(execFile);

/**
 * A browser dtf downloads and owns: Chrome for Testing.
 *
 * `launchIsolated` prefers it over whatever is installed, because a user's own
 * browser brings its own behaviour into the test: Edge signs a new profile into
 * the machine's Microsoft account and covers the page with a sync prompt, a
 * managed Chrome may be locked down by policy, and versions drift between
 * machines. Chrome for Testing is Google's build for exactly this: no sign-in,
 * no updater, no first-run UI, one pinned version.
 *
 * It does not change which browser an *app* opens a link in; that stays the
 * OS default browser.
 */

const VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

/** Where managed browsers live. `DTF_BROWSERS_DIR` overrides it (a CI cache, say). */
export function browsersDir(): string {
  if (process.env.DTF_BROWSERS_DIR) return process.env.DTF_BROWSERS_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dtf', 'browsers');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'dtf', 'browsers');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dtf', 'browsers');
}

/** Chrome for Testing's name for this machine, or undefined where it has no build. */
function platformKey(): string | undefined {
  if (process.platform === 'win32') return process.arch === 'x64' || process.arch === 'arm64' ? 'win64' : 'win32';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux64';
  return undefined;
}

/** The launchable path inside an extracted archive: the `.app` on macOS, the executable elsewhere. */
function executableIn(dir: string, platform: string): string {
  const root = join(dir, `chrome-${platform}`);
  if (platform.startsWith('mac')) return join(root, 'Google Chrome for Testing.app');
  if (platform.startsWith('win')) return join(root, 'chrome.exe');
  return join(root, 'chrome');
}

type Installed = { version: string; path: string };

const manifest = () => join(browsersDir(), 'chrome', 'current.json');

/** The installed Chrome for Testing, if `dtf install-browser` has been run and it is still there. */
export async function managedChrome(): Promise<Installed | undefined> {
  try {
    const info = JSON.parse(await readFile(manifest(), 'utf8')) as Installed;
    return existsSync(info.path) ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Downloads the current stable Chrome for Testing into `browsersDir()`, unless
 * that version is already there. Returns what is installed.
 */
export async function installChrome(opts: { force?: boolean; log?: (msg: string) => void } = {}): Promise<Installed> {
  const log = opts.log ?? (() => {});
  const platform = platformKey();
  if (!platform) throw new Error(`Chrome for Testing has no build for ${process.platform}/${process.arch}`);

  const res = await fetch(VERSIONS_URL);
  if (!res.ok) throw new Error(`could not read the Chrome for Testing versions (${res.status} from ${VERSIONS_URL})`);
  const stable = (await res.json() as {
    channels: { Stable: { version: string; downloads: { chrome: { platform: string; url: string }[] } } };
  }).channels.Stable;
  const url = stable.downloads.chrome.find((d) => d.platform === platform)?.url;
  if (!url) throw new Error(`Chrome for Testing ${stable.version} has no ${platform} download`);

  const current = await managedChrome();
  if (current?.version === stable.version && !opts.force) {
    log(`Chrome for Testing ${current.version} is already installed at ${current.path}`);
    return current;
  }

  const dest = join(browsersDir(), 'chrome', stable.version);
  const zip = join(tmpdir(), `dtf-chrome-${stable.version}-${platform}.zip`);
  log(`downloading Chrome for Testing ${stable.version} (${platform})\n  from ${url}`);
  const dl = await fetch(url);
  if (!dl.ok || !dl.body) throw new Error(`download failed: ${dl.status} ${dl.statusText}`);
  const total = Number(dl.headers.get('content-length') ?? 0);
  let got = 0;
  let shown = -1;
  const body = Readable.fromWeb(dl.body as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 10) * 10 : -1;
    if (pct !== shown && pct >= 0) { shown = pct; log(`  ${pct}% of ${(total / 1048576).toFixed(0)} MB`); }
  });
  await pipeline(body, createWriteStream(zip));

  log(`extracting to ${dest}`);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  try {
    if (process.platform === 'win32') {
      // Windows 10+ ships bsdtar, which reads zip archives.
      await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]);
    } else if (process.platform === 'darwin') {
      // ditto keeps the bundle's symlinks and signature intact; unzip does not always.
      await run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
    } else {
      await run('unzip', ['-q', zip, '-d', dest]);
    }
  } finally {
    await rm(zip, { force: true });
  }

  const path = executableIn(dest, platform);
  if (!existsSync(path)) throw new Error(`the archive did not contain ${path}`);
  const info: Installed = { version: stable.version, path };
  await writeFile(manifest(), JSON.stringify(info, null, 2));
  log(`installed Chrome for Testing ${info.version}\n  ${info.path}`);
  return info;
}
