import { describe, it, expect } from 'vitest';
import { sanitizeToGitBranch } from '../../src/utils/git-sanitize.js';
import type { BranchName, IssueRef } from '../../src/utils/git-sanitize.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  sanitizeToGitBranch — pure unit tests (no I/O)
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeToGitBranch', () => {
  it('[GS-2] prepends "ai/issue-" when the issue reference consists only of digits', () => {
    const result: BranchName = sanitizeToGitBranch('404' as IssueRef);
    expect(result).toBe('ai/issue-404');
  });

  it('prepends "ai/issue-" for any numeric-only string regardless of length', () => {
    expect(sanitizeToGitBranch('0' as IssueRef)).toBe('ai/issue-0');
    expect(sanitizeToGitBranch('1' as IssueRef)).toBe('ai/issue-1');
    expect(sanitizeToGitBranch('99999' as IssueRef)).toBe('ai/issue-99999');
  });

  it('converts a mixed-case Jira-style reference to lowercase with a forward-slash separator', () => {
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
