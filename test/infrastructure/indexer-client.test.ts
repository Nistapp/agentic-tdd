import { vi, describe, it, expect, beforeEach } from 'vitest';

import {
  IndexerCli,
  IndexerCliFailure,
  ensureIndexed,
  normalizeRoot,
  unwrapMcpCliResult,
} from '../../src/infrastructure/indexer-client.js';
import type { IndexedProject, ProcessRunner } from '../../src/infrastructure/indexer-client.js';

// ---------------------------------------------------------------------------
// Pure parsing helpers
// ---------------------------------------------------------------------------

describe('normalizeRoot', () => {
  it('strips trailing separators', () => {
    expect(normalizeRoot('/repo/')).toBe('/repo');
    expect(normalizeRoot('/repo')).toBe('/repo');
  });
});

describe('unwrapMcpCliResult', () => {
  it('extracts structuredContent when present', () => {
    const out = unwrapMcpCliResult(JSON.stringify({ structuredContent: { projects: [] }, isError: false }));
    expect(out).toEqual({ projects: [] });
  });

  it('parses the JSON text embedded in content when structuredContent is absent', () => {
    const out = unwrapMcpCliResult(
      JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ status: 'ready' }) }] }),
    );
    expect(out).toEqual({ status: 'ready' });
  });

  it('throws on non-JSON output', () => {
    expect(() => unwrapMcpCliResult('not json')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// IndexerCli — one-shot CLI wrapper
// ---------------------------------------------------------------------------

function okCli(exec: (tool: string, args: readonly string[]) => ProcessRunner) {
  const runner = vi.fn((file: string, args: readonly string[], opts?: { timeoutMs?: number }) => {
    const tool = args[2] as string;
    return Promise.resolve(exec(tool, args) ?? { exitCode: 0, stdout: '{}', stderr: '' });
  }) as ProcessRunner;
  return new IndexerCli('/bin/codebase-memory-mcp', runner);
}

describe('IndexerCli', () => {
  it('listProjects parses the projects array', async () => {
    const cli = okCli((tool) => {
      expect(tool).toBe('list_projects');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          structuredContent: {
            projects: [
              { name: 'repo-a', root_path: '/x/repo-a' },
              { name: 'repo-b', root_path: '/x/repo-b' },
            ],
            total: 2,
          },
        }),
        stderr: '',
      };
    });
    const projects = await cli.listProjects();
    expect(projects).toEqual([
      { name: 'repo-a', rootPath: '/x/repo-a' },
      { name: 'repo-b', rootPath: '/x/repo-b' },
    ]);
  });

  it('listProjects surfaces a reported error as IndexerCliFailure', async () => {
    const cli = okCli(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ structuredContent: { error: 'boom' } }),
      stderr: '',
    }));
    await expect(cli.listProjects()).rejects.toThrow(IndexerCliFailure);
  });

  it('indexStatus extracts status and git headSha', async () => {
    const cli = okCli((tool) => {
      expect(tool).toBe('index_status');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          structuredContent: {
            project: 'repo-a',
            status: 'ready',
            git: { head_sha: 'abc123', branch: 'dev' },
          },
        }),
        stderr: '',
      };
    });
    const info = await cli.indexStatus('repo-a');
    expect(info).toEqual({ status: 'ready', headSha: 'abc123', project: 'repo-a' });
  });

  it('indexRepository rejects with IndexerCliFailure on a reported error', async () => {
    const cli = okCli((tool) => {
      expect(tool).toBe('index_repository');
      return {
        exitCode: 0,
        stdout: JSON.stringify({ structuredContent: { error: 'cannot index' } }),
        stderr: '',
      };
    });
    await expect(cli.indexRepository('/x/repo-a')).rejects.toThrow(/cannot index/);
  });

  it('maps a runner rejection to IndexerCliFailure(timeout) for timeouts', async () => {
    const runner: ProcessRunner = vi.fn().mockRejectedValue(new Error('timed out after 30s'));
    const cli = new IndexerCli('/bin/codebase-memory-mcp', runner);
    await expect(cli.listProjects()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps a non-zero exit to IndexerCliFailure(cli_failed)', async () => {
    const runner: ProcessRunner = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'nope' });
    const cli = new IndexerCli('/bin/codebase-memory-mcp', runner);
    await expect(cli.listProjects()).rejects.toMatchObject({ kind: 'cli_failed' });
  });
});

// ---------------------------------------------------------------------------
// ensureIndexed — the G6 mandatory bootstrap decision ladder
// ---------------------------------------------------------------------------

interface FakeCli {
  listProjects: ReturnType<typeof vi.fn>;
  findProjectForRoot: ReturnType<typeof vi.fn>;
  indexStatus: ReturnType<typeof vi.fn>;
  indexRepository: ReturnType<typeof vi.fn>;
}

function makeFakeCli(): FakeCli {
  return {
    listProjects: vi.fn(),
    findProjectForRoot: vi.fn(),
    indexStatus: vi.fn(),
    indexRepository: vi.fn(),
  };
}

function makeProject(name: string, rootPath: string): IndexedProject {
  return { name, rootPath };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureIndexed', () => {
  it('returns fresh when the project exists, is ready, and matches currentHeadSha', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValue(makeProject('repo-a', '/x/repo-a'));
    cli.indexStatus.mockResolvedValue({ status: 'ready', headSha: 'abc123', project: 'repo-a' });

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      currentHeadSha: 'abc123',
      cli: cli as unknown as IndexerCli,
    });

    expect(outcome).toEqual({ kind: 'fresh', project: 'repo-a' });
    expect(cli.indexRepository).not.toHaveBeenCalled();
  });

  it('forces a reindex when force is true even when the index is fresh', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValue(makeProject('repo-a', '/x/repo-a'));
    cli.indexStatus.mockResolvedValue({ status: 'ready', headSha: 'abc123', project: 'repo-a' });
    cli.indexRepository.mockResolvedValue(undefined);

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      currentHeadSha: 'abc123',
      force: true,
      cli: cli as unknown as IndexerCli,
    });

    expect(cli.indexStatus).not.toHaveBeenCalled();
    expect(cli.indexRepository).toHaveBeenCalledWith('/x/repo-a', 'full', expect.any(Number));
    expect(outcome).toEqual({ kind: 'indexed', project: 'repo-a' });
  });

  it('reindexes when the index is stale (headSha differs from current HEAD)', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValue(makeProject('repo-a', '/x/repo-a'));
    cli.indexStatus.mockResolvedValue({ status: 'ready', headSha: 'oldsha', project: 'repo-a' });
    cli.indexRepository.mockResolvedValue(undefined);
    cli.findProjectForRoot.mockResolvedValueOnce(makeProject('repo-a', '/x/repo-a'));

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      currentHeadSha: 'abc123',
      cli: cli as unknown as IndexerCli,
    });

    expect(cli.indexRepository).toHaveBeenCalledWith('/x/repo-a', 'full', expect.any(Number));
    expect(outcome).toEqual({ kind: 'indexed', project: 'repo-a' });
  });

  it('bootstraps a fresh index when the project is absent', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValueOnce(undefined);
    cli.indexRepository.mockResolvedValue(undefined);
    cli.findProjectForRoot.mockResolvedValueOnce(makeProject('repo-a', '/x/repo-a'));

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      currentHeadSha: 'abc123',
      cli: cli as unknown as IndexerCli,
    });

    expect(cli.indexRepository).toHaveBeenCalledWith('/x/repo-a', 'full', expect.any(Number));
    expect(outcome).toEqual({ kind: 'indexed', project: 'repo-a' });
  });

  it('is a hard failure when index_repository crashes', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValue(undefined);
    cli.indexRepository.mockRejectedValue(new IndexerCliFailure('cli_failed', 'index_repository crashed'));

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      currentHeadSha: 'abc123',
      cli: cli as unknown as IndexerCli,
    });

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'cli_failed' });
  });

  it('maps an index_repository timeout to a timeout failure', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValue(undefined);
    cli.indexRepository.mockRejectedValue(new IndexerCliFailure('timeout', 'timed out'));

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      cli: cli as unknown as IndexerCli,
    });

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'timeout' });
  });

  it('reports reindex_failed when the project is still absent after indexing', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValue(undefined);
    cli.indexRepository.mockResolvedValue(undefined);

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      cli: cli as unknown as IndexerCli,
    });

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'reindex_failed' });
  });

  it('skips the freshness comparison when no currentHeadSha is provided', async () => {
    const cli = makeFakeCli();
    cli.findProjectForRoot.mockResolvedValue(makeProject('repo-a', '/x/repo-a'));

    const outcome = await ensureIndexed({
      binary: '/bin/codebase-memory-mcp',
      workDir: '/x/repo-a',
      cli: cli as unknown as IndexerCli,
    });

    expect(outcome).toEqual({ kind: 'already_indexed', project: 'repo-a' });
    expect(cli.indexStatus).not.toHaveBeenCalled();
    expect(cli.indexRepository).not.toHaveBeenCalled();
  });
});
