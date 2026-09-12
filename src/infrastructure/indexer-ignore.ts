/**
 * Guarantee the target repo carries a `.cbmignore` that excludes transient
 * scratch/run-state directories from the codebase-memory index.
 *
 * `codebase-memory-mcp` reads `<repo>/.cbmignore` (newline-separated,
 * gitignore-style syntax) at index time. The pipeline merges these exclusions
 * before the mandatory index bootstrap so that `artefacts/` is never indexed in
 * **any** target repo — independent of the advisory rules in the agent prompts.
 *
 * Best-effort by design: a read/write failure is logged and reported as
 * `changed: false` (the agent-prompt rules still apply), never a gate failure.
 */

import { join } from 'node:path';

import type { IFileSystem, ILogger } from '../core/interfaces.js';

/** Filename of the codebase-memory ignore file (repo root). */
export const CBM_IGNORE_FILENAME = '.cbmignore';

/**
 * Directories that must never be indexed: transient scratch documents and
 * pipeline run state. Trailing slashes are gitignore directory syntax.
 */
export const CBM_IGNORE_ENTRIES: readonly string[] = [
  'artefacts/',
  'artifacts/',
  '.agentic-tdd/',
];

const HEADER =
  '# Managed by agentic-tdd — excludes transient scratch/run state from the codebase index.';

/** Normalise a line for comparison (trim; ignore blanks and comments). */
function isMeaningfulLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#');
}

/**
 * Merge the required {@link CBM_IGNORE_ENTRIES} into *existing* content.
 *
 * Pure: no I/O. Existing user rules and comments are preserved; only missing
 * entries are appended. `changed` is `false` when every entry is already
 * present (so the caller can skip a redundant reindex).
 */
export function mergeCbmIgnore(existing: string): { content: string; changed: boolean } {
  const present = new Set(
    existing
      .split(/\r?\n/)
      .filter(isMeaningfulLine)
      .map((line) => line.trim()),
  );
  const missing = CBM_IGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) {
    return { content: existing, changed: false };
  }

  let base = existing;
  if (base.length === 0) {
    base = `${HEADER}\n`;
  } else if (!base.endsWith('\n')) {
    base = `${base}\n`;
  }
  return { content: `${base}${missing.join('\n')}\n`, changed: true };
}

export interface EnsureCbmIgnoreResult {
  /** True when the file was created or its contents changed. */
  changed: boolean;
  /** Absolute path of the ignore file. */
  path: string;
}

export interface EnsureCbmIgnoreDeps {
  fs: IFileSystem;
  workDir: string;
  logger?: ILogger;
}

/**
 * Ensure `<workDir>/.cbmignore` contains every {@link CBM_IGNORE_ENTRIES}
 * entry, merging with any user-authored rules.
 */
export async function ensureCbmIgnore(deps: EnsureCbmIgnoreDeps): Promise<EnsureCbmIgnoreResult> {
  const path = join(deps.workDir, CBM_IGNORE_FILENAME);
  try {
    const exists = await deps.fs.exists(path);
    const current = exists ? await deps.fs.readFile(path) : '';
    const { content, changed } = mergeCbmIgnore(current);
    if (changed) {
      await deps.fs.writeFile(path, content);
      deps.logger?.info({ path }, 'Wrote .cbmignore exclusions for the codebase index');
    }
    return { changed, path };
  } catch (err) {
    deps.logger?.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      'Could not ensure .cbmignore; scratch directories may be indexed',
    );
    return { changed: false, path };
  }
}
