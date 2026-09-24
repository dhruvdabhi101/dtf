import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The nearest directory at or above `from` containing a package.json. */
function packageRoot(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The module specifier a generated spec should import the framework from.
 *
 * In a user's project that is simply `'dtf'`. Inside the framework's own
 * repository the suite imports the sources relatively, and recorded tests
 * should match the files next to them.
 */
export function importSpecifierFor(cwd: string, specFile: string): string {
  const root = packageRoot(cwd);
  if (!root) return 'dtf';
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name !== 'dtf') return 'dtf';
  } catch {
    return 'dtf';
  }
  const rel = relative(dirname(specFile), join(root, 'src', 'index.ts')).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}
