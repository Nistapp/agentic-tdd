import { execa } from 'execa';
import type { IGitService } from '../core/interfaces.js';
import type { GitCommitResult, FileChange } from '../core/types.js';

export class GitService implements IGitService {
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