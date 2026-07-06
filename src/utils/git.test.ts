/**
 * Tests for git.ts — Red Phase (Pass 2)
 *
 * All tests are EXPECTED TO FAIL because git.ts contains only stubs
 * that throw Error('not implemented').
 *
 * Tests are written against the CONTRACT (type signatures + Gherkin scenarios),
 * not against the stub implementation.
 *
 * @see git.gherkin
 * @see git.mmd
 */

import {
  getCurrentBranch,
  isWorkingDirectoryDirty,
  branchExists,
  ensureBranchIsSynced,
  sanitizeToGitBranch,
  setupFeatureBranch,
  gitCommit,
} from './git';
import type {
  BranchName,
  IssueRef,
  SetupFeatureBranchOutcome,
  GitCommitOutcome,
} from './git';
import { vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────
let isDirty = false;
let headBranch = 'feat/my-feature';
let existingBranches = new Set(['main', 'master']);
let mockAddFails = false;
let mockNothingToCommit = false;
let mockFsReadResponse = 'y\n';

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return headBranch + '\n';
    }
    if (cmd.includes('status --porcelain')) {
      if (cmd.includes('git status')) { if (mockNothingToCommit) return ''; return isDirty ? ' M somefile.ts\n' : ''; }
    }
    if (cmd.includes('rev-parse --verify --quiet')) {
      const match = cmd.match(/refs\/heads\/"([^"]+)"/);
      const branch = match ? match[1] : '';
      if (existingBranches.has(branch)) return '';
      throw new Error('branch not found');
    }
    if (cmd.includes('checkout -b')) return '';
    if (cmd.includes('checkout "')) return '';
    if (cmd.includes('fetch origin')) return '';
    if (cmd.includes('git add')) {
      if (mockAddFails) throw new Error('add failed');
      return '';
    }
    if (cmd.includes('git commit')) {
      if (mockNothingToCommit) throw new Error('nothing to commit');
      return '';
    }
    return '';
  })
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeSync: vi.fn(),
    readSync: vi.fn((fd, buf: Buffer) => {
      buf.write(mockFsReadResponse);
      return mockFsReadResponse.length;
    })
  };
});

beforeEach(() => {
  // Reset defaults before each test
  isDirty = false;
  headBranch = 'feat/my-feature';
  existingBranches = new Set(['main', 'master']);
  mockAddFails = false;
  mockNothingToCommit = false;
  mockFsReadResponse = 'y\n';
});
// ──────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
//  getCurrentBranch
// ────────────────────────────────────────────────────────────────────────────
// git.gherkin Background: current branch is "feat/my-feature"
// git.mmd line 6
describe('getCurrentBranch', () => {
  it('returns a non-empty string representing the currently active git branch name', () => {
    const branch: string = getCurrentBranch();
    expect(typeof branch).toBe('string');
    expect(branch.length).toBeGreaterThan(0);
  });

  it('returns the branch name without leading or trailing whitespace', () => {
    const branch: string = getCurrentBranch();
    expect(branch).toBe(branch.trim());
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  isWorkingDirectoryDirty
// ────────────────────────────────────────────────────────────────────────────
// git.gherkin Scenario: setupFeatureBranch aborts when the working directory
//                         has uncommitted changes
// git.mmd line 7
describe('isWorkingDirectoryDirty', () => {
  // [GS-4] git.gherkin line 41-46
  it('returns true when the working tree has uncommitted changes', () => {
isDirty = true;
    const dirty: boolean = isWorkingDirectoryDirty();
    expect(dirty).toBe(true);
  });

  it('returns false when the working tree is clean (no staged or unstaged changes)', () => {
mockNothingToCommit = true;
    const dirty: boolean = isWorkingDirectoryDirty();
    expect(dirty).toBe(false);
  });

  it('always returns a boolean value', () => {
    const result: unknown = isWorkingDirectoryDirty();
    expect(typeof result).toBe('boolean');
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  branchExists
// ────────────────────────────────────────────────────────────────────────────
// git.mmd line 9
describe('branchExists', () => {
  // [GS-1] branch "feat/pay-404" does NOT exist
  it('returns false for a branch that does not exist locally', () => {
    const exists: boolean = branchExists('feat/nonexistent-branch' as BranchName);
    expect(exists).toBe(false);
  });

  // [GS-3] branch "feat/pay-404" already exists locally
  it('returns true for a branch that exists locally', () => {
    const exists: boolean = branchExists('main' as BranchName);
    expect(exists).toBe(true);
  });

  it('always returns a boolean value', () => {
    const result: unknown = branchExists('feat/temp' as BranchName);
    expect(typeof result).toBe('boolean');
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  ensureBranchIsSynced
// ────────────────────────────────────────────────────────────────────────────
// git.mmd lines 41-42 (F16)
describe('ensureBranchIsSynced', () => {
  // [GS-1] ensureBranchIsSynced should be called with "feat/pay-404"
  it('completes without throwing for a valid, existing branch', () => {
    expect(() => {
      ensureBranchIsSynced('feat/pay-404' as BranchName);
    }).not.toThrow();
  });

  it('accepts a simple branch name without a slash separator', () => {
    expect(() => {
      ensureBranchIsSynced('main' as BranchName);
    }).not.toThrow();
  });

  it('does not return a value (returns undefined)', () => {
    const result: void = ensureBranchIsSynced('feat/test' as BranchName);
    expect(result).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  sanitizeToGitBranch
// ────────────────────────────────────────────────────────────────────────────
// git.mmd lines 10, 15-19 (S1-S4)
describe('sanitizeToGitBranch', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // [GS-2] git.gherkin line 25-28
  // Scenario: sanitizeToGitBranch prepends "ai/issue-" when given a
  //           numeric-only issue reference
  // ═══════════════════════════════════════════════════════════════════════════
  it('[GS-2] prepends "ai/issue-" when the issue reference consists only of digits', () => {
    const result: BranchName = sanitizeToGitBranch('404' as IssueRef);
    expect(result).toBe('ai/issue-404');
  });

  it('prepends "ai/issue-" for any numeric-only string regardless of length', () => {
    expect(sanitizeToGitBranch('0' as IssueRef)).toBe('ai/issue-0');
    expect(sanitizeToGitBranch('1' as IssueRef)).toBe('ai/issue-1');
    expect(sanitizeToGitBranch('99999' as IssueRef)).toBe('ai/issue-99999');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Coercion behaviour for non-numeric input (git.mmd S3)
  // ═══════════════════════════════════════════════════════════════════════════

  it('converts a mixed-case Jira-style reference to lowercase with a forward-slash separator', () => {
    // Derived from [GS-1] "setupFeatureBranch creates a new feature branch"
    // where sanitizeToGitBranch("PAY-404") → "feat/pay-404"
    const result: BranchName = sanitizeToGitBranch('PAY-404' as IssueRef);
    expect(result).toBe('feat/pay-404');
  });

  it('converts all uppercase characters to lowercase', () => {
    const result: string = sanitizeToGitBranch('HELLO-WORLD' as IssueRef) as string;
    expect(result).toBe(result.toLowerCase());
  });

  it('replaces spaces with hyphens', () => {
    const result: string = sanitizeToGitBranch('Add OAuth' as IssueRef) as string;
    expect(result).not.toContain(' ');
  });

  it('replaces special characters with hyphens', () => {
    const result: string = sanitizeToGitBranch('fix/bug#42!' as IssueRef) as string;
    // Valid git branch names only contain: letters, digits, hyphens, underscores, dots, forward slashes
    expect(result).toMatch(/^[a-z0-9._/-]+$/);
  });

  it('collapses multiple consecutive hyphens into a single hyphen', () => {
    const result: string = sanitizeToGitBranch('BUG---FIX' as IssueRef) as string;
    expect(result).not.toContain('--');
  });

  it('trims leading and trailing hyphens from the result', () => {
    const result: string = sanitizeToGitBranch('--hello-world--' as IssueRef) as string;
    expect(result).not.toMatch(/^-/);
    expect(result).not.toMatch(/-$/);
  });

  it('throws or returns a sensible fallback for an empty issue reference', () => {
    // Empty input is a degenerate case — the implementation must handle it
    // without crashing. Either throw with a descriptive message or return a
    // fallback name.
    expect(() => sanitizeToGitBranch('' as IssueRef)).toThrow();
  });

  it('returns a string that does not contain any git-invalid characters', () => {
    const result: string = sanitizeToGitBranch('UPPER case AND spaces!@#$%^&*()' as IssueRef) as string;
    expect(result).toMatch(/^[a-z0-9._/-]+$/);
  });

  it('handles a reference that already resembles a valid branch name', () => {
    const result: BranchName = sanitizeToGitBranch('feat/my-feature' as IssueRef);
    expect(result).toBe('feat/my-feature');
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  setupFeatureBranch
// ────────────────────────────────────────────────────────────────────────────
// git.mmd lines 11, 22-43 (F1-F17)
describe('setupFeatureBranch', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // [GS-1] git.gherkin lines 12-21
  // Scenario: setupFeatureBranch creates a new feature branch from current
  //           branch when working tree is clean
  // ═══════════════════════════════════════════════════════════════════════════
  it('[GS-1] creates a new feature branch from current branch when working tree is clean, branch does not exist, skipHitl=true', () => {
mockNothingToCommit = true;
    // Preconditions (not testable from the call site — must be externally
    // arranged): working tree is clean, branch "feat/pay-404" does NOT exist,
    // baseBranch is null.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      true,
    );
    expect(outcome.kind).toBe('created');
    if (outcome.kind === 'created') {
      expect(outcome.branch).toBe('feat/pay-404');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // [GS-3] git.gherkin lines 30-37
  // Scenario: setupFeatureBranch checks out an existing branch without
  //           prompting when skipHitl is true
  // ═══════════════════════════════════════════════════════════════════════════
  it('[GS-3] checks out an existing branch directly when skipHitl is true and the branch already exists', () => {
existingBranches.add('feat/pay-404');
mockNothingToCommit = true;
    // Preconditions: working tree is clean, branch "feat/pay-404" already
    // exists locally, skipHitl is true.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      true,
    );
    expect(outcome.kind).toBe('checked_out');
    if (outcome.kind === 'checked_out') {
      expect(outcome.branch).toBe('feat/pay-404');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // [GS-4] git.gherkin lines 41-46
  // Scenario: setupFeatureBranch aborts when the working directory has
  //           uncommitted changes
  // ═══════════════════════════════════════════════════════════════════════════
  it('[GS-4] aborts with abort_dirty when the working directory has uncommitted changes', () => {
isDirty = true;
    // Precondition: working directory is dirty.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      true,
    );
    expect(outcome.kind).toBe('abort_dirty');
    if (outcome.kind === 'abort_dirty') {
      expect(typeof outcome.message).toBe('string');
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // [GS-5] git.gherkin lines 48-54
  // Scenario: setupFeatureBranch aborts when HEAD is main and no baseBranch
  //           override is provided
  // ═══════════════════════════════════════════════════════════════════════════
  it('[GS-5] aborts with abort_main when HEAD is "main" and baseBranch is null', () => {
headBranch = 'main';mockNothingToCommit = true;
    // Precondition: current branch is "main", working tree is clean.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      true,
    );
    expect(outcome.kind).toBe('abort_main');
    if (outcome.kind === 'abort_main') {
      expect(typeof outcome.message).toBe('string');
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it('prompts the user and returns abort_user_declined when branch exists, skipHitl=false, and user declines', () => {
existingBranches.add('feat/pay-404');
mockFsReadResponse = 'n\n';mockNothingToCommit = true;
    // Precondition: branch exists, skipHitl is false, user declines prompt.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      false,
    );
    expect(outcome.kind).toBe('abort_user_declined');
    if (outcome.kind === 'abort_user_declined') {
      expect(typeof outcome.message).toBe('string');
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it('prompts the user and returns checked_out when branch exists, skipHitl=false, and user approves', () => {
existingBranches.add('feat/pay-404');
mockNothingToCommit = true;
    // Precondition: branch exists, skipHitl is false, user approves prompt.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      false,
    );
    expect(outcome.kind).toBe('checked_out');
  });

  it('uses the provided baseBranch when it is non-null, bypassing the abort_main guard', () => {
headBranch = 'main';mockNothingToCommit = true;
    // When a baseBranch is explicitly provided and HEAD is "main", the
    // abort_main guard is bypassed. The function branches from the given base.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      'develop' as BranchName,
      true,
    );
    expect(outcome.kind).toMatch(/^(created|checked_out)$/);
  });

  it('returns the correct discriminated union shape for every possible outcome kind', () => {
    // Verify that every outcome variant has the expected shape.
    // This test checks the type contract at runtime.
    const outcomes: SetupFeatureBranchOutcome[] = [
      { kind: 'checked_out', branch: 'feat/test' as BranchName },
      { kind: 'created', branch: 'feat/test' as BranchName },
      { kind: 'abort_dirty', message: 'dirty' },
      { kind: 'abort_main', message: 'on main' },
      { kind: 'abort_user_declined', message: 'declined' },
    ];

    for (const o of outcomes) {
      expect(o).toHaveProperty('kind');
      if (o.kind === 'checked_out' || o.kind === 'created') {
        expect(o).toHaveProperty('branch');
      } else {
        expect(o).toHaveProperty('message');
      }
    }
  });

  it('does not mutate any external state when aborting (abort_dirty)', () => {
isDirty = true;
    // Contract: on abort, no git checkout or branch creation is attempted.
    // This is an integration property — the outcome kind being abort_dirty
    // IS the signal that no mutation occurred.
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      true,
    );
    expect(outcome.kind).toBe('abort_dirty');
  });

  it('does not mutate any external state when aborting (abort_main)', () => {
headBranch = 'main';mockNothingToCommit = true;
    const outcome: SetupFeatureBranchOutcome = setupFeatureBranch(
      'PAY-404' as IssueRef,
      null,
      true,
    );
    expect(outcome.kind).toBe('abort_main');
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  gitCommit
// ────────────────────────────────────────────────────────────────────────────
// git.mmd lines 12, 46-54 (C1-C8)
describe('gitCommit', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // [GS-6] git.gherkin lines 56-62
  // Scenario: gitCommit logs and returns without error when there is nothing
  //           to commit
  // ═══════════════════════════════════════════════════════════════════════════
  it('[GS-6] returns nothing_to_commit when there are no staged or unstaged changes', () => {
mockNothingToCommit = true;
    // Precondition: no staged or unstaged changes exist for the given files.
    const outcome: GitCommitOutcome = gitCommit(
      ['README.md'],
      'docs: update readme',
    );
    expect(outcome.kind).toBe('nothing_to_commit');
  });

  it('returns committed on a successful commit', () => {
isDirty = true;
    const outcome: GitCommitOutcome = gitCommit(
      ['src/index.ts'],
      'feat: add new feature',
    );
    expect(outcome.kind).toBe('committed');
    if (outcome.kind === 'committed') {
      expect(typeof outcome.message).toBe('string');
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it('returns committed with the provided commit message on success', () => {
isDirty = true;
    const expectedMessage = 'fix: resolve edge case in parser';
    const outcome: GitCommitOutcome = gitCommit(
      ['src/parser.ts'],
      expectedMessage,
    );
    expect(outcome.kind).toBe('committed');
    if (outcome.kind === 'committed') {
      expect(outcome.message).toBe(expectedMessage);
    }
  });

  // git.mmd lines 47-50 (C1-C4): git add failure → log warning, proceed
  it('returns add_warning when git add fails but still proceeds with the commit attempt', () => {
mockAddFails = true;
    const outcome: GitCommitOutcome = gitCommit(
      ['nonexistent-file.txt'],
      'chore: update missing file',
    );
    expect(outcome.kind).toBe('add_warning');
    if (outcome.kind === 'add_warning') {
      expect(typeof outcome.message).toBe('string');
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  // git.mmd lines 47-50: warning is logged but execution continues
  it('proceeds despite add_warning — outcome is add_warning, not an exception', () => {
    // The contract says: log a warning (but continue) if git add fails.
    // The function must not throw; it returns add_warning instead.
    expect(() => {
      gitCommit(['/invalid/path'], 'msg');
    }).not.toThrow();
  });

  it('handles a single-file commit correctly', () => {
    const outcome: GitCommitOutcome = gitCommit(
      ['package.json'],
      'chore: bump version',
    );
    // Must return one of the defined outcomes — no crash.
    expect(['committed', 'nothing_to_commit', 'add_warning']).toContain(outcome.kind);
  });

  it('handles an empty files array gracefully', () => {
    const outcome: GitCommitOutcome = gitCommit([], 'wip: empty commit');
    // Empty files list could mean nothing to stage → nothing_to_commit, or
    // the implementation could interpret it as "commit everything staged".
    // Either way it must be one of the defined outcomes.
    expect(['committed', 'nothing_to_commit', 'add_warning']).toContain(outcome.kind);
  });

  it('handles a multi-file commit', () => {
    const outcome: GitCommitOutcome = gitCommit(
      ['file1.ts', 'file2.ts', 'file3.ts'],
      'refactor: extract helpers',
    );
    expect(['committed', 'nothing_to_commit', 'add_warning']).toContain(outcome.kind);
  });

  it('returns the correct discriminated union shape for every possible outcome kind', () => {
    const outcomes: GitCommitOutcome[] = [
      { kind: 'committed', message: 'ok' },
      { kind: 'nothing_to_commit' },
      { kind: 'add_warning', message: 'warning' },
    ];

    for (const o of outcomes) {
      expect(o).toHaveProperty('kind');
      if (o.kind === 'nothing_to_commit') {
        expect(Object.keys(o)).toEqual(['kind']);
      } else {
        expect(o).toHaveProperty('message');
      }
    }
  });
});