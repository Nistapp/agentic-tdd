/**
 * Pure branch-name sanitization helpers shared by the CLI and infrastructure
 * layers. Contains no I/O — safe to import from any layer.
 */

/**
 * A validated git branch name, produced by {@link sanitizeToGitBranch}.
 * Examples: `"feat/pay-404"`, `"ai/issue-404"`.
 */
export type BranchName = string & { __brand: 'BranchName' };

/**
 * A free-form issue reference passed into `createFeatureBranch` or
 * `sanitizeToGitBranch`.  May contain letters, digits, hyphens, etc.
 * Examples: `"PAY-404"`, `"404"`, `"Add OAuth"`.
 */
export type IssueRef = string & { __brand: 'IssueRef' };

/**
 * Converts a free-form issue reference into a valid git branch name.
 * - If the input consists only of digits, prepend `"ai/issue-"`.
 * - Otherwise, coerce into a valid branch name (lowercase, replace
 *   non-alphanumeric characters with hyphens, collapse runs, trim).
 * - If the input matches a Jira-style pattern (letters-hyphen-digits),
 *   prepend `"feat/"`.
 * @param issueRef - Free-form string such as `"PAY-404"` or `"404"`.
 * @returns A valid git branch name, e.g. `"feat/pay-404"` or `"ai/issue-404"`.
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
