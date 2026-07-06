// ── Contracts (pass-1-contracts-agent) ─────────────────────────────────────
// Types and interfaces derived from the Mermaid design artefact and Gherkin spec.
// Artefact names are dynamic (e.g. git.mmd / git.gherkin when processing git.ts).
// All function bodies are stubs — implementation is Pass 3.

import { execSync } from 'child_process';
import * as fs from 'fs';

/**
 * A validated git branch name, produced by {@link sanitizeToGitBranch}.
 * Examples: `"feat/pay-404"`, `"ai/issue-404"`.
 * @see git.gherkin Scenario: sanitizeToGitBranch prepends "ai/issue-" when given a numeric-only issue reference
 */
export type BranchName = string & { __brand: 'BranchName' };

/**
 * A free-form issue reference passed into `setupFeatureBranch` or
 * `sanitizeToGitBranch`.  May contain letters, digits, hyphens, etc.
 * Examples: `"PAY-404"`, `"404"`, `"Add OAuth"`.
 */
export type IssueRef = string & { __brand: 'IssueRef' };

/**
 * Shape of the `baseBranch` parameter — either an explicit branch name
 * or `null` to mean "use the current branch".
 * @see git.mmd lines 26-28 (F4 branch)
 */
export type BaseBranchOverride = BranchName | null;

/**
 * Parameters for {@link setupFeatureBranch}.
 * @see git.mmd lines 11, 22-43
 * @see git.gherkin Scenario: setupFeatureBranch creates a new feature branch
 * @see git.gherkin Scenario: setupFeatureBranch checks out an existing branch without prompting when skipHitl is true
 */
export interface SetupFeatureBranchParams {
  /** Free-form issue reference (e.g. "PAY-404", "404"). */
  issueRef: IssueRef;
  /**
   * Explicit base branch to branch from.
   * `null` means "use the current branch".
   */
  baseBranch: BaseBranchOverride;
  /**
   * If `true`, skip the human-in-the-loop prompt when the target
   * branch already exists (just check it out).
   */
  skipHitl: boolean;
}

/**
 * Parameters for {@link gitCommit}.
 * @see git.mmd lines 46-54
 * @see git.gherkin Scenario: gitCommit logs and returns without error when there is nothing to commit
 */
export interface GitCommitParams {
  /** List of file paths to stage and commit. */
  files: string[];
  /** Commit message body. */
  message: string;
}

/**
 * Discriminated union describing every possible outcome of
 * {@link setupFeatureBranch}.  Returned (not thrown) so callers
 * inspect the result without try/catch.
 * @see git.mmd lines 24-25 (abort dirty), 28-29 (abort main), 36-37 (user declined)
 */
export type SetupFeatureBranchOutcome =
  | { kind: 'checked_out'; branch: BranchName }
  | { kind: 'created'; branch: BranchName }
  | { kind: 'abort_dirty'; message: string }
  | { kind: 'abort_main'; message: string }
  | { kind: 'abort_user_declined'; message: string };

/**
 * Discriminated union describing every possible outcome of
 * {@link gitCommit}.
 * @see git.mmd lines 47-54
 * @see git.gherkin Scenario: gitCommit logs and returns without error when there is nothing to commit
 */
export type GitCommitOutcome =
  | { kind: 'committed'; message: string }
  | { kind: 'nothing_to_commit' }
  | { kind: 'add_warning'; message: string };

// ── End Contracts ──────────────────────────────────────────────────

/**
 * Returns the name of the currently active git branch.
 * @returns The current branch name, e.g. `"feat/my-feature"`.
 * @see git.mmd line 6
 * @see git.gherkin Background: current branch is "feat/my-feature"
 */
export function getCurrentBranch(): string {
  return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
}

/**
 * Returns `true` if the working directory has uncommitted changes.
 * @returns `true` if dirty, `false` if clean.
 * @see git.mmd line 7
 * @see git.gherkin Scenario: setupFeatureBranch aborts when the working directory has uncommitted changes
 */
export function isWorkingDirectoryDirty(): boolean {
  const status = execSync('git status --porcelain', { encoding: 'utf-8' });
  return status.length > 0;
}

/**
 * Checks whether a branch exists locally.
 * @param branchName - The branch name to check.
 * @returns `true` if the branch exists locally.
 * @see git.mmd line 9
 * @see git.gherkin Scenario: setupFeatureBranch creates a new feature branch (branch does NOT exist)
 * @see git.gherkin Scenario: setupFeatureBranch checks out an existing branch without prompting (branch exists)
 */
export function branchExists(branchName: BranchName): boolean {
  try {
    execSync(`git rev-parse --verify --quiet refs/heads/"${branchName}"`, { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches the latest from origin for a branch to ensure it is synced.
 * @param branchName - The branch to sync.
 * @see git.mmd lines 41-42 (F16)
 * @see git.gherkin Scenario: setupFeatureBranch creates a new feature branch — ensureBranchIsSynced called
 * @see git.gherkin Scenario: setupFeatureBranch checks out an existing branch without prompting — ensureBranchIsSynced called
 */
export function ensureBranchIsSynced(branchName: BranchName): void {
  try {
    execSync(`git fetch origin "${branchName}:${branchName}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch {
    // Silently ignore errors (e.g. no remote, branch not on remote, etc.)
  }
}

/**
 * Converts a free-form issue reference into a valid git branch name.
 * - If the input consists only of digits, prepend `"ai/issue-"`.
 * - Otherwise, coerce into a valid branch name (lowercase, replace
 *   non-alphanumeric characters with hyphens, collapse runs, trim).
 * - If the input matches a Jira-style pattern (letters-hyphen-digits),
 *   prepend `"feat/"`.
 * @param issueRef - Free-form string such as `"PAY-404"` or `"404"`.
 * @returns A valid git branch name, e.g. `"feat/pay-404"` or `"ai/issue-404"`.
 * @see git.mmd lines 10, 15-19 (S1-S4)
 * @see git.gherkin Scenario: sanitizeToGitBranch prepends "ai/issue-" when given a numeric-only issue reference
 */
export function sanitizeToGitBranch(issueRef: IssueRef): BranchName {
  // Empty input is degenerate — throw a descriptive error
  if (issueRef.length === 0) {
    throw new Error('Issue reference cannot be empty');
  }

  // S1: If the issue reference consists only of digits, prepend "ai/issue-"
  if (/^\d+$/.test(issueRef)) {
    return `ai/issue-${issueRef}` as BranchName;
  }

  // S3: Coerce to valid branch name
  // Step 1: lowercase
  let sanitized = issueRef.toLowerCase();

  // Step 2: Replace any character that is not valid in a git branch name
  // Valid git branch chars: a-z, 0-9, ., _, /, -
  sanitized = sanitized.replace(/[^a-z0-9._/-]/g, '-');

  // Step 3: Collapse multiple consecutive hyphens into a single hyphen
  sanitized = sanitized.replace(/-+/g, '-');

  // Step 4: Trim leading and trailing hyphens
  sanitized = sanitized.replace(/^-+/, '');
  sanitized = sanitized.replace(/-+$/, '');

  // If the original input (before sanitization, case-insensitive) matches
  // a Jira-style pattern (letters followed by hyphen followed by digits),
  // prepend "feat/". This is required by the spec for "PAY-404" → "feat/pay-404".
  if (/^[a-z]+-\d+$/i.test(issueRef)) {
    sanitized = `feat/${sanitized}`;
  }

  return sanitized as BranchName;
}

/**
 * Prompts the user with a yes/no question and returns their response.
 * Reads synchronously from stdin.
 */
function confirmPrompt(question: string): string {
  fs.writeSync(1, question + ' ');
  const buffer = Buffer.alloc(4096);
  const bytesRead = fs.readSync(0, buffer, 0, 4096, null);
  return buffer.toString('utf8', 0, bytesRead).trim();
}

/**
 * Resolves the base branch and checks out (or creates) a feature branch.
 *
 * Abort conditions (log warning and return — no branch is changed):
 * 1. Working directory is dirty.
 * 2. HEAD is `"main"` and `baseBranch` is null.
 * 3. Branch exists, `skipHitl` is false, and the user declines the prompt.
 *
 * @param issueRef - Free-form issue reference, e.g. `"PAY-404"`.
 * @param baseBranch - Explicit base branch, or `null` to use current branch.
 * @param skipHitl - If `true`, skip user prompt when branch already exists.
 * @returns An {@link SetupFeatureBranchOutcome} describing what happened.
 * @see git.mmd lines 11, 22-43 (F1-F17)
 * @see git.gherkin Scenario: setupFeatureBranch creates a new feature branch
 * @see git.gherkin Scenario: setupFeatureBranch checks out an existing branch without prompting
 * @see git.gherkin Scenario: setupFeatureBranch aborts when the working directory has uncommitted changes
 * @see git.gherkin Scenario: setupFeatureBranch aborts when HEAD is main and no baseBranch override
 */
export function setupFeatureBranch(
  issueRef: IssueRef,
  baseBranch: BaseBranchOverride,
  skipHitl: boolean,
): SetupFeatureBranchOutcome {
  // F1-F3: Check if working directory is dirty
  // git.mmd: F1 "call isWorkingDirectoryDirty()" → F2 "dirty?" → F3 "ABORT"
  if (isWorkingDirectoryDirty()) {
    return { kind: 'abort_dirty', message: 'Working directory has uncommitted changes. Aborting.' };
  }

  // F4: Resolve baseBranch
  // null → current branch; provided → use as-is
  const resolvedBase = baseBranch !== null ? baseBranch : getCurrentBranch();

  // F5-F6: Abort if HEAD is "main" or "master" (default branch) and baseBranch is null (no override)
  // git.mmd: F5 "HEAD is 'main' AND baseBranch is null?" → F6 "ABORT"
  // IMPL-NOTE: diagram mentions only 'main' but some repos use 'master'.
  //            Both are common default branch names that should be protected.
  if (baseBranch === null) {
    const currentBranch = getCurrentBranch();
    if (currentBranch === 'main' || currentBranch === 'master') {
      return {
        kind: 'abort_main',
        message: 'Refusing to branch from main. Provide an explicit baseBranch override.',
      };
    }
  }

  // F7: sanitize issueRef to valid branch name
  const sanitized = sanitizeToGitBranch(issueRef);

  // F8-F9: Check if branch already exists
  const exists = branchExists(sanitized);

  if (exists) {
    // F10: If skipHitl is false, prompt the user
    // git.mmd: F10 "skipHitl === false?" → F11 "prompt user via readline-sync"
    if (!skipHitl) {
      const response = confirmPrompt(
        `Branch "${sanitized}" already exists. Check it out? (y/n)`,
      );
      const approved = response.toLowerCase() === 'y' || response.toLowerCase() === 'yes';
      // F12: User declines → abort
      // git.mmd: F12 "user approves?" → "no" → F13 "ABORT: user declined"
      if (!approved) {
        return {
          kind: 'abort_user_declined',
          message: `User declined to check out existing branch "${sanitized}".`,
        };
      }
    }

    // F14: Checkout existing branch
    // git.mmd: F14 "git checkout existing branch" (reached via skipHitl or user approval)
    execSync(`git checkout "${sanitized}"`, { encoding: 'utf-8', stdio: 'pipe' });
  } else {
    // F15: Create new branch from resolved base
    // git.mmd: F15 "git checkout -b new branch"
    execSync(`git checkout -b "${sanitized}" "${resolvedBase}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  }

  // F16: Ensure the branch is synced with origin
  // git.mmd: F14/F15 → F16 "call ensureBranchIsSynced(branchName)"
  ensureBranchIsSynced(sanitized);

  // F17: Return success outcome
  // git.mmd: F16 → F17 "log success, return"
  return exists
    ? { kind: 'checked_out', branch: sanitized }
    : { kind: 'created', branch: sanitized };
}

/**
 * Stages the specified files and creates a commit.
 * - Logs a warning (but continues) if `git add` fails.
 * - If there are no changes to commit, logs info and returns without error.
 *
 * @param files - List of file paths to stage and commit.
 * @param message - Commit message.
 * @returns A {@link GitCommitOutcome} describing what happened.
 * @see git.mmd lines 12, 46-54 (C1-C8)
 * @see git.gherkin Scenario: gitCommit logs and returns without error when there is nothing to commit
 */
export function gitCommit(files: string[], message: string): GitCommitOutcome {
  // C1: git add <files>
  let addFailed = false;
  try {
    execSync(`git add ${files.map(f => `"${f}"`).join(' ')}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch {
    // C2-C3: git add fails → log warning, proceed anyway
    // git.mmd: C2 "git add fails?" → C3 "console.warn add failure" → C4 "proceed anyway"
    addFailed = true;
  }

  // C5: Check if there is nothing to commit
  // git.mmd: C4 → C5 "nothing to commit?"
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8' });
    if (status.trim().length === 0) {
      // C6: Nothing to commit → log info, return
      // git.mmd: C5 "yes" → C6 "log info, return"
      if (addFailed) {
        return { kind: 'add_warning', message: `git add failed for files: ${files.join(', ')}` };
      }
      return { kind: 'nothing_to_commit' };
    }
  } catch {
    // If git status fails, proceed with commit attempt anyway
  }

  // C7: git commit -m <message>
  // git.mmd: C5 "no" → C7 "git commit -m <message>"
  try {
    execSync(`git commit -m "${message}"`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    // git commit failed (likely nothing to commit despite status showing something)
    if (addFailed) {
      return { kind: 'add_warning', message: `git add failed for files: ${files.join(', ')}` };
    }
    return { kind: 'nothing_to_commit' };
  }

  // C8: return success
  // git.mmd: C7 → C8 "log success, return"
  if (addFailed) {
    return { kind: 'add_warning', message: `git add failed for files: ${files.join(', ')}` };
  }
  return { kind: 'committed', message };
}