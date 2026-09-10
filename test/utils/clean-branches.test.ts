import { describe, it, expect } from 'vitest';
import {
  parseTrackedBranches,
  selectStaleBranches,
  DEFAULT_PROTECTED_BRANCHES,
} from '../../src/utils/git-branch-janitor.js';

describe('parseTrackedBranches', () => {
  it('splits NUL-separated name and track fields', () => {
    const raw = 'dev\0\nmain\0[behind 1]\nfeat/foo\0[gone]\n';
    const result = parseTrackedBranches(raw);
    expect(result).toEqual([
      { name: 'dev', track: '' },
      { name: 'main', track: '[behind 1]' },
      { name: 'feat/foo', track: '[gone]' },
    ]);
  });

  it('treats a line without a NUL separator as having empty track', () => {
    const result = parseTrackedBranches('local-only\n');
    expect(result).toEqual([{ name: 'local-only', track: '' }]);
  });

  it('ignores blank lines', () => {
    const result = parseTrackedBranches('\n\nfeat/foo\0[gone]\n\n');
    expect(result).toEqual([{ name: 'feat/foo', track: '[gone]' }]);
  });
});

describe('selectStaleBranches', () => {
  const branches = [
    { name: 'feat/foo', track: '[gone]' },
    { name: 'fix/bar', track: '[gone]' },
    { name: 'feat/kept', track: '[ahead 1]' },
    { name: 'local-only', track: '' },
    { name: 'main', track: '[gone]' },
    { name: 'dev', track: '[gone]' },
  ];

  it('selects only branches whose upstream is gone', () => {
    const result = selectStaleBranches(branches);
    expect(result).toEqual(['feat/foo', 'fix/bar']);
  });

  it('never selects the protected main and dev branches', () => {
    const result = selectStaleBranches(branches);
    expect(result).not.toContain('main');
    expect(result).not.toContain('dev');
  });

  it('never selects the currently checked-out branch', () => {
    const result = selectStaleBranches(branches, { currentBranch: 'feat/foo' });
    expect(result).toEqual(['fix/bar']);
  });

  it('honours a custom protected-branch allowlist', () => {
    const result = selectStaleBranches(branches, {
      protectedBranches: ['main', 'dev', 'feat/foo'],
    });
    expect(result).toEqual(['fix/bar']);
  });

  it('replaces the default allowlist when a custom one is supplied', () => {
    const result = selectStaleBranches(branches, {
      protectedBranches: ['main', 'feat/foo'],
    });
    expect(result).toEqual(['fix/bar', 'dev']);
  });

  it('returns an empty list when nothing is stale', () => {
    const result = selectStaleBranches([
      { name: 'feat/kept', track: '[ahead 1]' },
      { name: 'local-only', track: '' },
    ]);
    expect(result).toEqual([]);
  });
});

describe('DEFAULT_PROTECTED_BRANCHES', () => {
  it('protects main and dev by default', () => {
    expect(DEFAULT_PROTECTED_BRANCHES).toEqual(['main', 'dev']);
  });
});
