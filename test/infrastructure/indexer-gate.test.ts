import { vi, describe, it, expect, beforeEach } from 'vitest';

import { ensureIndexerAccess } from '../../src/infrastructure/indexer-gate.js';
import type { IGitService, IFileSystem, ILogger } from '../../src/core/interfaces.js';
import type { IndexerProbeFailure } from '../../src/infrastructure/indexer-probe.js';

const probeMocks = vi.hoisted(() => ({
  resolveIndexerBinary: vi.fn(),
  runStaticIndexerChecks: vi.fn(),
  runLiveIndexerProbe: vi.fn(),
  defaultIsExecutable: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  ensureIndexed: vi.fn(),
}));

vi.mock('../../src/infrastructure/indexer-probe.js', () => ({
  resolveIndexerBinary: probeMocks.resolveIndexerBinary,
  runStaticIndexerChecks: probeMocks.runStaticIndexerChecks,
  runLiveIndexerProbe: probeMocks.runLiveIndexerProbe,
  defaultIsExecutable: probeMocks.defaultIsExecutable,
}));

vi.mock('../../src/infrastructure/indexer-client.js', () => ({
  ensureIndexed: clientMocks.ensureIndexed,
}));

class StubLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
  get level(): string {
    return 'info';
  }
}

function stubFs(): IFileSystem {
  return {
    exists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    readdir: vi.fn(),
  };
}

function stubGit(overrides: Partial<IGitService> = {}): IGitService {
  return {
    commit: vi.fn(),
    getPendingChanges: vi.fn(),
    getCurrentBranch: vi.fn(),
    isDirty: vi.fn(),
    getCurrentCommitSha: vi.fn().mockResolvedValue('abc123'),
    getLastCompletedPass: vi.fn(),
    resetWorkingTree: vi.fn(),
    abortToSha: vi.fn(),
    tag: vi.fn(),
    getDiffLineRanges: vi.fn(),
    createFeatureBranch: vi.fn(),
    ...overrides,
  };
}

function failure(kind: IndexerProbeFailure['kind']): IndexerProbeFailure {
  return { kind, message: `remedy for ${kind}` };
}

function okStatic() {
  return { ok: true as const, binary: '/bin/codebase-memory-mcp' };
}

beforeEach(() => {
  vi.clearAllMocks();
  probeMocks.resolveIndexerBinary.mockResolvedValue('/bin/codebase-memory-mcp');
  probeMocks.runStaticIndexerChecks.mockResolvedValue(okStatic());
  probeMocks.runLiveIndexerProbe.mockResolvedValue({ ok: true });
  clientMocks.ensureIndexed.mockResolvedValue({ kind: 'fresh', project: 'repo-a' });
});

describe('ensureIndexerAccess', () => {
  const baseDeps = {
    fs: stubFs(),
    git: stubGit(),
    logger: new StubLogger(),
    backend: 'pi',
    workDir: '/proj',
    agentDir: '/home/u/.pi/agent',
  };

  it('fails fatally (G1) when the backend is opencode-cli', async () => {
    const result = await ensureIndexerAccess({ ...baseDeps, backend: 'opencode-cli' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/opencode-cli/);
      expect(result.message).toMatch(/G1/);
    }
    expect(probeMocks.resolveIndexerBinary).not.toHaveBeenCalled();
  });

  it('propagates a static binary_missing failure with an actionable message', async () => {
    probeMocks.resolveIndexerBinary.mockResolvedValue(null);
    probeMocks.runStaticIndexerChecks.mockResolvedValue({
      ok: false,
      failure: failure('binary_missing'),
    });

    const result = await ensureIndexerAccess(baseDeps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('binary_missing');
    // No SDK import should have been needed for a missing binary.
    expect(probeMocks.runLiveIndexerProbe).not.toHaveBeenCalled();
  });

  it('propagates a live-probe tools_missing failure', async () => {
    probeMocks.runLiveIndexerProbe.mockResolvedValue({ ok: false, failure: failure('tools_missing') });

    const result = await ensureIndexerAccess(baseDeps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('tools_missing');
    expect(clientMocks.ensureIndexed).not.toHaveBeenCalled();
  });

  it('runs the index bootstrap after static+live pass and reports ok', async () => {
    const result = await ensureIndexerAccess(baseDeps);
    expect(result).toEqual({ ok: true });
    expect(clientMocks.ensureIndexed).toHaveBeenCalledWith(
      expect.objectContaining({
        binary: '/bin/codebase-memory-mcp',
        workDir: '/proj',
        currentHeadSha: 'abc123',
      }),
    );
  });

  it('propagates an index-bootstrap failure', async () => {
    clientMocks.ensureIndexed.mockResolvedValue({
      kind: 'failed',
      reason: 'timeout',
      message: 'index_repository timed out after 120s',
    });

    const result = await ensureIndexerAccess(baseDeps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('timed out');
  });

  it('falls back to presence-only bootstrapping when the git SHA cannot be read', async () => {
    const git = stubGit({ getCurrentCommitSha: vi.fn().mockRejectedValue(new Error('not a repo')) });
    const result = await ensureIndexerAccess({ ...baseDeps, git });
    expect(result.ok).toBe(true);
    expect(clientMocks.ensureIndexed).toHaveBeenCalledWith(
      expect.objectContaining({ currentHeadSha: undefined }),
    );
  });
});
