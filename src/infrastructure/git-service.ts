import { execa } from 'execa';
import type { IGitService } from '../core/interfaces.js';
import type { GitCommitResult, FileChange, DiffLineChange, Range } from '../core/types.js';

/**
 * Regex to parse a `diff --git a/<old> b/<new>` file header.
 * Captures the new file path (group 1).
 */
const DIFF_FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

/**
 * Regex to parse a unified-diff hunk header `@@ -oldStart,oldCount +newStart,newCount @@`.
 * Groups: 1=oldStart, 2=oldCount (optional), 3=newStart, 4=newCount (optional).
 */
const DIFF_HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseDiffUnified0(stdout: string): DiffLineChange[] {
  const lines = stdout.split('\n');
  const result: DiffLineChange[] = [];
  let current: DiffLineChange | null = null;

  for (const line of lines) {
    const fileMatch = DIFF_FILE_HEADER.exec(line);
    if (fileMatch) {
      if (current) result.push(current);
      current = { file: fileMatch[2]!, ranges: [] };
      continue;
    }

    const hunkMatch = DIFF_HUNK_HEADER.exec(line);
    if (hunkMatch && current) {
      const newStart = parseInt(hunkMatch[3]!, 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      const range: Range = {
        start: newStart,
        end: newStart + newCount - 1,
      };
      current.ranges.push(range);
    }
  }

  if (current) result.push(current);
  return result;
}

export class GitService implements IGitService {
  #diffCache = new Map<string, DiffLineChange[]>();

  async getDiffLineRanges(fromRef: string, toRef: string): Promise<DiffLineChange[]> {
    const key = `${fromRef}..${toRef}`;
    const cached = this.#diffCache.get(key);
    if (cached) return cached;

    const { stdout } = await execa('git', [
      'diff',
      '--unified=0',
      fromRef,
      toRef,
      '--',
    ]);

    const result = parseDiffUnified0(stdout);
    this.#diffCache.set(key, result);
    return result;
  }
  async getCurrentBranch(): Promise<string> {
    const result = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.stdout.trim();
  }

  async isDirty(): Promise<boolean> {
    try {
      const result = await execa('git', ['status', '--porcelain']);
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async getPendingChanges(): Promise<FileChange[]> {
    try {
      const result = await execa('git', ['status', '--porcelain']);
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      return lines.map(line => {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3).trim();
        return { status, file };
      });
    } catch {
      return [];
    }
  }

  async commit(files: string[], message: string): Promise<GitCommitResult> {
    let addFailed = false;

    for (const file of files) {
      try {
        await execa('git', ['add', file]);
      } catch {
        addFailed = true;
      }
    }

    try {
      await execa('git', ['commit', '-m', message]);
      if (addFailed) {
        return { kind: 'add_warning', message };
      }
      return { kind: 'committed', message };
    } catch (err) {
      const combined = err instanceof Error ? err.message.toLowerCase() : '';
      if (combined.includes('nothing to commit') || combined.includes('nothing added to commit')) {
        if (addFailed) {
          return { kind: 'add_warning', message: `git add failed for some files — nothing to commit` };
        }
        return { kind: 'nothing_to_commit', message: err instanceof Error ? err.message : '' };
      }
      if (addFailed) {
        return { kind: 'add_warning', message };
      }
      return { kind: 'nothing_to_commit', message: err instanceof Error ? err.message : '' };
    }
  }

  async getCurrentCommitSha(): Promise<string> {
    const result = await execa('git', ['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async getLastCompletedPass(): Promise<number | null> {
    try {
      const result = await execa('git', [
        'log',
        '--oneline',
        '--grep=chore(ai): completed Pass ',
        '-n', '20',
      ]);
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      let highest = null;
      for (const line of lines) {
        const match = line.match(/completed Pass (\d+)/);
        if (match) {
          const n = parseInt(match[1]!, 10);
          if (Number.isFinite(n) && (highest === null || n > highest)) {
            highest = n;
          }
        }
      }
      return highest;
    } catch {
      return null;
    }
  }

  async resetWorkingTree(): Promise<void> {
    await execa('git', ['reset', '--hard', 'HEAD']);
    await execa('git', ['clean', '-fd']);
  }

  async abortToSha(sha: string): Promise<void> {
    await execa('git', ['reset', '--hard', sha]);
    await execa('git', ['clean', '-fd']);
  }
}