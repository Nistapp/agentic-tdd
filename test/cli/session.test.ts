import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startNewSession, resumeSession } from '../../src/cli/session.js';
import type { IGitService, IFileSystem, IStateStore } from '../../src/core/interfaces.js';
import type { PipelineContext } from '../../src/core/types.js';
import { TerminalRenderer, consoleWriter } from '../../src/cli/terminal-renderer.js';
import type { ValidatedOptions } from '../../src/cli/validators.js';

const di = vi.hoisted(() => ({
  createPipelineServices: vi.fn(),
}));

const gate = vi.hoisted(() => ({
  ensureIndexerAccess: vi.fn(),
}));

vi.mock('../../src/cli/di-container.js', () => ({
  createPipelineServices: di.createPipelineServices,
}));

vi.mock('../../src/infrastructure/mcp-config.js', () => ({
  writeMcpConfig: vi.fn().mockResolvedValue({ created: true, merged: false, kept: false, writtenContent: '{}' }),
  teardownMcpConfig: vi.fn().mockResolvedValue(undefined),
  getMcpTemplateDir: vi.fn(() => '/tmp'),
  resolveMcpBinary: vi.fn().mockResolvedValue('/usr/bin/codebase-memory-mcp'),
}));

vi.mock('../../src/infrastructure/indexer-gate.js', () => ({
  ensureIndexerAccess: gate.ensureIndexerAccess,
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

function stubContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    featureName: 'PAY-404',
    testCmd: ['npm', 'test'],
    skipHitl: false,
    maxCorrectionRetries: 1,
    pipelineVersion: '0.1.0',
    sourceType: 'file',
    logLevel: 'INFO',
    specFileAbsPath: '/tmp/specs/foo.md',
    featureDescription: 'Add payment gateway',
    baseBranch: undefined,
    originalBaseSha: undefined,
    history: {},
    artefactDir: '/tmp/art',
    designMmdPath: '/tmp/art/PAY-404.mmd',
    specGherkinPath: '/tmp/art/PAY-404.gherkin',
    testFilePath: '/tmp/test/PAY-404.test.ts',
    errorLogPath: '/tmp/art/error-PAY-404.log',
    ...overrides,
  };
}

const pausedContext: PipelineContext = stubContext({
  currentPass: 0,
  xstateSnapshot: { status: 'active', value: 'paused' } as unknown as Record<string, unknown>,
});

describe('startNewSession branch creation', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    di.createPipelineServices.mockClear();
    di.createPipelineServices.mockReturnValue({
      orchestrator: { run: vi.fn().mockResolvedValue(undefined) },
    });
    gate.ensureIndexerAccess.mockClear();
    gate.ensureIndexerAccess.mockResolvedValue({ ok: true });
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

// ---------------------------------------------------------------------------
// Mandatory indexer gate — each session entry point gates before any run
// ---------------------------------------------------------------------------

describe('mandatory indexer gate at session entry points', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    di.createPipelineServices.mockClear();
    di.createPipelineServices.mockReturnValue({
      orchestrator: { run: vi.fn().mockResolvedValue(undefined) },
    });
    gate.ensureIndexerAccess.mockClear();
    gate.ensureIndexerAccess.mockResolvedValue({ ok: true });
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

  function makeRenderer(): TerminalRenderer {
    return new TerminalRenderer(consoleWriter);
  }

  it('startNewSession exits fatally (before createPipelineServices) when the gate fails', async () => {
    gate.ensureIndexerAccess.mockResolvedValue({
      ok: false,
      message: '[binary_missing] codebase-memory-mcp is not on PATH. Install it.',
    });
    const fs = stubFs();
    const git = stubGit({
      createFeatureBranch: vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const),
      getCurrentCommitSha: vi.fn().mockResolvedValue('abc123'),
    });
    const stateStore = stubStateStore();
    const renderer = makeRenderer();
    const fatalSpy = vi.spyOn(renderer, 'fatal');

    await expect(
      startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0'),
    ).rejects.toThrow('process.exit called');

    expect(fatalSpy).toHaveBeenCalledWith(
      '[binary_missing] codebase-memory-mcp is not on PATH. Install it.',
    );
    expect(di.createPipelineServices).not.toHaveBeenCalled();
  });

  it('startNewSession proceeds to create services when the gate passes', async () => {
    const fs = stubFs();
    const git = stubGit({
      createFeatureBranch: vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const),
      getCurrentCommitSha: vi.fn().mockResolvedValue('abc123'),
    });
    const stateStore = stubStateStore();

    await startNewSession(validOptions, stateStore, fs, git, makeRenderer(), '0.1.0');

    expect(gate.ensureIndexerAccess).toHaveBeenCalledTimes(1);
    expect(di.createPipelineServices).toHaveBeenCalledTimes(1);
  });

  it('resumeSession (paused) exits fatally before createPipelineServices when the gate fails', async () => {
    gate.ensureIndexerAccess.mockResolvedValue({ ok: false, message: '[probe_timeout] timed out' });
    const fs = stubFs();
    const git = stubGit();
    const stateStore = stubStateStore({ load: vi.fn().mockResolvedValue(pausedContext) });
    const renderer = makeRenderer();
    const fatalSpy = vi.spyOn(renderer, 'fatal');

    await expect(
      resumeSession(stateStore, fs, git, renderer, '0.1.0', undefined, undefined, undefined, 'pi'),
    ).rejects.toThrow('process.exit called');

    expect(fatalSpy).toHaveBeenCalledWith('[probe_timeout] timed out');
    expect(di.createPipelineServices).not.toHaveBeenCalled();
  });

  it('resumeSession (fast-forward) exits fatally before createPipelineServices when the gate fails', async () => {
    gate.ensureIndexerAccess.mockResolvedValue({ ok: false, message: '[tools_missing] allowlist bug' });
    const fs = stubFs();
    const git = stubGit({ resetWorkingTree: vi.fn().mockResolvedValue(undefined) });
    const stateStore = stubStateStore({
      load: vi.fn().mockResolvedValue(stubContext({ currentPass: 3, history: {} })),
    });
    const renderer = makeRenderer();
    const fatalSpy = vi.spyOn(renderer, 'fatal');

    await expect(
      resumeSession(stateStore, fs, git, renderer, '0.1.0', undefined, undefined, undefined, 'pi'),
    ).rejects.toThrow('process.exit called');

    expect(fatalSpy).toHaveBeenCalledWith('[tools_missing] allowlist bug');
    expect(di.createPipelineServices).not.toHaveBeenCalled();
  });

  it('resumeSession proceeds when the gate passes', async () => {
    const fs = stubFs();
    const git = stubGit();
    const stateStore = stubStateStore({
      load: vi.fn().mockResolvedValue(stubContext({ currentPass: 3, history: {} })),
    });

    await resumeSession(stateStore, fs, git, makeRenderer(), '0.1.0', undefined, undefined, undefined, 'pi');

    expect(gate.ensureIndexerAccess).toHaveBeenCalledTimes(1);
    expect(di.createPipelineServices).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guaranteed server teardown (gate-owned opencode server)
// ---------------------------------------------------------------------------

describe('server teardown at session entry points', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  function stubServer() {
    return {
      baseUrl: 'http://127.0.0.1:4321',
      isAlive: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
  }

  beforeEach(() => {
    di.createPipelineServices.mockClear();
    di.createPipelineServices.mockReturnValue({
      orchestrator: { run: vi.fn().mockResolvedValue(undefined) },
    });
    gate.ensureIndexerAccess.mockClear();
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

  it('hands the gate server to the DI container and closes it after success', async () => {
    const handle = stubServer();
    gate.ensureIndexerAccess.mockResolvedValue({ ok: true, server: handle });
    const fs = stubFs();
    const git = stubGit({
      createFeatureBranch: vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const),
      getCurrentCommitSha: vi.fn().mockResolvedValue('abc123'),
    });
    const stateStore = stubStateStore();

    await startNewSession(validOptions, stateStore, fs, git, new TerminalRenderer(consoleWriter), '0.1.0');

    expect(di.createPipelineServices).toHaveBeenCalledWith(
      expect.objectContaining({ agentServer: handle }),
    );
    expect(handle.close).toHaveBeenCalledTimes(1);
    const closeOrder = handle.close.mock.invocationCallOrder[0]!;
    const exitOrder = exitSpy.mock.invocationCallOrder[0]!;
    expect(closeOrder).toBeLessThan(exitOrder);
  });

  it('closes the server when the orchestrator throws', async () => {
    const handle = stubServer();
    gate.ensureIndexerAccess.mockResolvedValue({ ok: true, server: handle });
    di.createPipelineServices.mockReturnValue({
      orchestrator: { run: vi.fn().mockRejectedValue(new Error('pass exploded')) },
    });
    const fs = stubFs();
    const git = stubGit({
      createFeatureBranch: vi.fn().mockResolvedValue({ kind: 'created', branch: 'feat/pay-404' } as const),
      getCurrentCommitSha: vi.fn().mockResolvedValue('abc123'),
    });
    const stateStore = stubStateStore();
    const renderer = new TerminalRenderer(consoleWriter);
    const fatalSpy = vi.spyOn(renderer, 'fatal');

    await expect(
      startNewSession(validOptions, stateStore, fs, git, renderer, '0.1.0'),
    ).rejects.toThrow('process.exit called');

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(fatalSpy).toHaveBeenCalledWith('pass exploded');
  });
});
