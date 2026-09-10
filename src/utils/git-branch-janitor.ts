import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'dev'];

export interface TrackedBranch {
  name: string;
  track: string;
}

export interface SelectStaleOptions {
  protectedBranches?: readonly string[];
  currentBranch?: string | null;
}

/**
 * Parse the output of
 * `git for-each-ref --format='%(refname:short)%00%(upstream:track)' refs/heads`
 * into `{ name, track }` records. Fields are separated by a NUL byte (`%00`)
 * so branch names cannot collide with the tracking-status marker.
 */
export function parseTrackedBranches(raw: string): TrackedBranch[] {
  const branches: TrackedBranch[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('\0');
    if (separator === -1) {
      branches.push({ name: trimmed, track: '' });
      continue;
    }
    branches.push({
      name: trimmed.slice(0, separator),
      track: trimmed.slice(separator + 1),
    });
  }
  return branches;
}

/**
 * Select local branches whose upstream remote branch has been deleted
 * (`[gone]`). Protected branches and the currently checked-out branch are
 * never selected.
 */
export function selectStaleBranches(
  branches: readonly TrackedBranch[],
  options: SelectStaleOptions = {},
): string[] {
  const protectedBranches =
    options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  const currentBranch = options.currentBranch ?? null;
  const protectedSet = new Set(protectedBranches);
  const stale: string[] = [];
  for (const branch of branches) {
    if (protectedSet.has(branch.name)) continue;
    if (branch.name === currentBranch) continue;
    if (!/\[gone\]/.test(branch.track)) continue;
    stale.push(branch.name);
  }
  return stale;
}

function runGit(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function currentBranchName(): string | null {
  try {
    return runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    return null;
  }
}

function parseProtected(argv: readonly string[]): string[] {
  const arg = argv.find((a) => a.startsWith('--protected='));
  if (!arg) return [...DEFAULT_PROTECTED_BRANCHES];
  const values = arg
    .slice('--protected='.length)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return values.length > 0 ? values : [...DEFAULT_PROTECTED_BRANCHES];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Janitor entry point. Defaults to a dry run; pass `--apply` to delete.
 */
export function main(argv: string[] = process.argv.slice(2)): number {
  const apply = argv.includes('--apply') || argv.includes('-a');
  const quiet = argv.includes('--quiet') || argv.includes('-q');
  const protectedBranches = parseProtected(argv);

  try {
    runGit(['fetch', '--prune']);
  } catch (err) {
    if (!quiet) {
      console.warn(
        `warning: git fetch --prune failed (${errorMessage(err)}); ` +
          'proceeding with existing tracking metadata.',
      );
    }
  }

  const raw = runGit([
    'for-each-ref',
    '--format=%(refname:short)%00%(upstream:track)',
    'refs/heads',
  ]);
  const branches = parseTrackedBranches(raw);
  const stale = selectStaleBranches(branches, {
    protectedBranches,
    currentBranch: currentBranchName(),
  });

  if (stale.length === 0) {
    if (!quiet) console.log('No stale branches to delete.');
    return 0;
  }

  const suffix = stale.length === 1 ? '' : 'es';
  console.log(
    `${apply ? 'Deleting' : 'Would delete'} ${stale.length} stale branch${suffix}:`,
  );
  for (const name of stale) console.log(`  - ${name}`);

  if (!apply) {
    console.log('\nDry run - no branches deleted. Re-run with --apply to delete.');
    return 0;
  }

  runGit(['branch', '-D', ...stale]);
  console.log(`Deleted ${stale.length} stale branch${suffix}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`error: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}
