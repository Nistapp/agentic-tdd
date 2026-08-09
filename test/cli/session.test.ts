import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startNewSession } from '../../src/cli/session.js';
import type { IGitService, IFileSystem, IStateStore } from '../../src/core/interfaces.js';
import { TerminalRenderer, consoleWriter } from '../../src/cli/terminal-renderer.js';
import type { ValidatedOptions } from '../../src/cli/validators.js';

vi.mock('../../src/cli/di-container.js', () => ({
  createPipelineServices: vi.fn(() => ({
    orchestrator: {
      run: vi.fn().mockResolvedValue(undefined),
    },
  })),
}));

function stubGit(overrides: Partial<IGitService> = {}): IGitService {
  return {
    commit: vi.fn(),
    getPendingChanges: vi.fn(),
    getCurrentBranch: vi.fn(),
    isDirty: vi.fn(),
    getCurrentCommitSha: vi.fn(),
    getLastCompletedPass: vi.fn(),
    resetWorkingTree: vi.fn(),
    abortToSha: vi.fn(),
    tag: vi.fn(),
    getDiffLineRanges: vi.fn(),
    createFeatureBranch: vi.fn(),
    ...overrides,
  };
}

function stubFs(overrides: Partial<IFileSystem> = {}): IFileSystem {
  return {
    exists: vi.fn().mockResolvedValue(false),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    readdir: vi.fn(),
    ...overrides,
  };
}

function stubStateStore(overrides: Partial<IStateStore> = {}): IStateStore {
  return {
    path: '/tmp/test-state.json',
    save: vi.fn(),
    load: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

const validOptions: ValidatedOptions = {
  specFileAbsPath: '/tmp/specs/foo.md',
  testCmd: ['npm', 'test'],
  skipHitl: false,
  logLevel: 'INFO',
  baseBranch: undefined,
  featureName: 'PAY-404',
  featureDescription: 'Add payment gateway',
};

describe('startNewSession branch creation', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (code?: number | string | null | undefined) => {
        if (code === 0) return undefined as never;
        throw new Error('process.exit called');
      },
    );
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('calls createFeatureBranch before getCurrentCommitSha', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const);
    const getCurrentCommitSha = vi.fn().mockResolvedValue('abc123');
    const git = stubGit({ createFeatureBranch, getCurrentCommitSha });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);

    await startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0');

    const createIdx = createFeatureBranch.mock.invocationCallOrder[0];
    const shaIdx = getCurrentCommitSha.mock.invocationCallOrder[0];
    expect(createIdx).toBeLessThan(shaIdx!);
  });

  it('passes correct args to createFeatureBranch', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const);
    const git = stubGit({ createFeatureBranch, getCurrentCommitSha: vi.fn().mockResolvedValue('abc123') });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);

    await startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0');

    expect(createFeatureBranch).toHaveBeenCalledWith(
      'PAY-404',
      null,
      false,
      expect.any(Function),
    );
  });

  it('passes baseBranch override to createFeatureBranch', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const);
    const git = stubGit({ createFeatureBranch, getCurrentCommitSha: vi.fn().mockResolvedValue('abc123') });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);

    const optsWithBase = { ...validOptions, baseBranch: 'develop' };

    await startNewSession(optsWithBase, stateStore, fs, git, renderer, '0.1.0');

    expect(createFeatureBranch).toHaveBeenCalledWith(
      'PAY-404',
      'develop',
      false,
      expect.any(Function),
    );
  });

  it('passes skipHitl to createFeatureBranch', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const);
    const git = stubGit({ createFeatureBranch, getCurrentCommitSha: vi.fn().mockResolvedValue('abc123') });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);

    const optsSkipHitl = { ...validOptions, skipHitl: true };

    await startNewSession(optsSkipHitl, stateStore, fs, git, renderer, '0.1.0');

    expect(createFeatureBranch).toHaveBeenCalledWith(
      'PAY-404',
      null,
      true,
      expect.any(Function),
    );
  });

  it('calls renderer.fatal on abort_dirty and does not proceed', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({
      kind: 'abort_dirty',
      message: 'Working directory has uncommitted changes.',
    } as const);
    const git = stubGit({ createFeatureBranch });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);
    const fatalSpy = vi.spyOn(renderer, 'fatal');

    await expect(
      startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0'),
    ).rejects.toThrow('process.exit called');

    expect(fatalSpy).toHaveBeenCalledWith('Working directory has uncommitted changes.');
    expect(git.getCurrentCommitSha).not.toHaveBeenCalled();
  });

  it('calls renderer.fatal on abort_main and does not proceed', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({
      kind: 'abort_main',
      message: 'Refusing to branch from main.',
    } as const);
    const git = stubGit({ createFeatureBranch });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);
    const fatalSpy = vi.spyOn(renderer, 'fatal');

    await expect(
      startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0'),
    ).rejects.toThrow('process.exit called');

    expect(fatalSpy).toHaveBeenCalledWith('Refusing to branch from main.');
    expect(git.getCurrentCommitSha).not.toHaveBeenCalled();
  });

  it('calls renderer.fatal on abort_user_declined and does not proceed', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({
      kind: 'abort_user_declined',
      message: 'User declined to check out existing branch "feat/pay-404".',
    } as const);
    const git = stubGit({ createFeatureBranch });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);
    const fatalSpy = vi.spyOn(renderer, 'fatal');

    await expect(
      startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0'),
    ).rejects.toThrow('process.exit called');

    expect(fatalSpy).toHaveBeenCalledWith('User declined to check out existing branch "feat/pay-404".');
    expect(git.getCurrentCommitSha).not.toHaveBeenCalled();
  });

  it('calls renderer.gitInfo with branch info on success', async () => {
    const createFeatureBranch = vi.fn().mockResolvedValue({
      kind: 'created',
      branch: 'feat/pay-404',
    } as const);
    const git = stubGit({
      createFeatureBranch,
      getCurrentCommitSha: vi.fn().mockResolvedValue('abc123'),
    });
    const fs = stubFs();
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);
    const gitInfoSpy = vi.spyOn(renderer, 'gitInfo');

    await startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0');

    expect(gitInfoSpy).toHaveBeenCalledWith(
      'Switched to branch feat/pay-404 [created]',
    );
  });
});
