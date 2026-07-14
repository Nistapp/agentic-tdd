import { SelfCorrectionRunner } from '../../src/core/runners/self-correction-runner.js';
import { PipelinePass, PASS_LABELS } from '../../src/core/types.js';
import type {
  PipelineContext,
  AgenticEvent,
  AgentRunRequest,
  AgentArtefacts,
} from '../../src/core/types.js';
import type {
  IGitService,
  IFileSystem,
  ICommandRunner,
  IAgentRunner,
  IEventBus,
  ILogger,
} from '../../src/core/interfaces.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// StubLogger — captures calls for verification, supports .level
// ---------------------------------------------------------------------------

class StubLogger implements ILogger {
  readonly calls: { method: string; args: unknown[] }[] = [];

  debug(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'debug', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  info(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'info', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  warn(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'warn', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  error(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'error', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  child(_bindings: Record<string, unknown>): ILogger {
    return this;
  }

  get level(): string {
    return 'info';
  }
}

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const specsDir = '/project/specs';
  const srcDir = '/project/src';
  return {
    featureName: 'my_module',
    testCmd: ['npm', 'test'],
    skipHitl: true,
    maxCorrectionRetries: 3,
    pipelineVersion: '1.0.0',
    sourceType: 'file',
    logLevel: 'INFO',
    specFileAbsPath: `${specsDir}/my_module.md`,
    featureDescription: 'Create a simple utility module',
    artefactDir: specsDir,
    designMmdPath: `${specsDir}/my_module.mmd`,
    specGherkinPath: `${specsDir}/my_module.gherkin`,
    errorLogPath: `${srcDir}/.opencode_error.log`,
    currentPass: PipelinePass.CoreImplementation,
    currentAttempt: 1,
    runId: 'test-run-id',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

interface Mocks {
  agentRunner: IAgentRunner;
  cmd: ICommandRunner;
  git: IGitService;
  fs: IFileSystem;
  events: IEventBus;
  logger: StubLogger;
  emittedEvents: AgenticEvent[];
  childLoggers: StubLogger[];
}

function makeMocks(): Mocks {
  const emittedEvents: AgenticEvent[] = [];
  const childLoggers: StubLogger[] = [];

  const agentRunner: IAgentRunner = {
    execute: vi.fn().mockResolvedValue({ output: 'agent output' }),
  };

  const cmd: ICommandRunner = {
    runTests: vi.fn().mockResolvedValue({ passed: true, output: '' }),
  };

  const git: IGitService = {
    commit: vi.fn(),
    getPendingChanges: vi.fn().mockResolvedValue([]),
    getCurrentBranch: vi.fn(),
    isDirty: vi.fn(),
    getCurrentCommitSha: vi.fn(),
    getLastCompletedPass: vi.fn(),
    resetWorkingTree: vi.fn(),
    abortToSha: vi.fn(),
  };

  const fs: IFileSystem = {
    exists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue('%% content %%'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  };

  const events: IEventBus = {
    emit: vi.fn((event: AgenticEvent) => {
      emittedEvents.push(event);
    }),
    on: vi.fn().mockReturnValue(() => { }),
  };

  const logger = new StubLogger();
  // Track child loggers created
  const origChild = logger.child.bind(logger);
  logger.child = (bindings: Record<string, unknown>): ILogger => {
    const child = new StubLogger();
    childLoggers.push(child);
    return child;
  };

  return { agentRunner, cmd, git, fs, events, logger, emittedEvents, childLoggers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEvents(events: AgenticEvent[], kind: string): AgenticEvent[] {
  return events.filter(e => e.kind === kind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelfCorrectionRunner', () => {
  describe('Happy path — tests pass on first attempt', () => {
    it('calls agentRunner.execute once and runTests once', async () => {
      const m = makeMocks();
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);
      const ctx = makeContext();

      await runner.execute(ctx);

      expect(m.agentRunner.execute).toHaveBeenCalledTimes(1);
      expect(m.cmd.runTests).toHaveBeenCalledTimes(1);
    });

    it('emits PASL_STARTED, TEST_RUN_STARTED, TEST_RUN_COMPLETED, PASS_COMPLETED', async () => {
      const m = makeMocks();
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);
      const ctx = makeContext();

      await runner.execute(ctx);

      expect(findEvents(m.emittedEvents, 'PASS_STARTED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'TEST_RUN_STARTED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'TEST_RUN_COMPLETED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'PASS_COMPLETED')).toHaveLength(1);
    });

    it('calls git.getPendingChanges on success', async () => {
      const m = makeMocks();
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await runner.execute(makeContext());

      expect(m.git.getPendingChanges).toHaveBeenCalled();
    });

    it('deletes stale error log on success', async () => {
      const m = makeMocks();
      (m.fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);
      const ctx = makeContext();

      await runner.execute(ctx);

      expect(m.fs.deleteFile).toHaveBeenCalledWith(ctx.errorLogPath);
    });
  });

  describe('D1 fix — agent invocation ordering', () => {
    it('runs agent BEFORE tests on first attempt', async () => {
      const m = makeMocks();
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      // Track call order
      const callOrder: string[] = [];
      (m.agentRunner.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('agent');
        return { output: '' };
      });
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('tests');
        return { passed: true, output: '' };
      });

      await runner.execute(makeContext());

      expect(callOrder[0]).toBe('agent');
      expect(callOrder[1]).toBe('tests');
    });
  });

  describe('D2 fix — no mutable logger field', () => {
    it('creates a fresh child logger per attempt', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({ passed: true, output: '' });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await runner.execute(makeContext());

      // One child logger created for the single attempt
      expect(m.childLoggers.length).toBe(1);
    });

    it('creates two child loggers when attempt 1 fails', async () => {
      const m = makeMocks();
      let callCount = 0;
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { passed: false, output: 'FAIL' };
        return { passed: true, output: '' };
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await runner.execute(makeContext({ maxCorrectionRetries: 1 }));

      // Two attempts → two child loggers
      expect(m.childLoggers.length).toBe(2);
    });
  });

  describe('Self-correction — tests fail once then pass', () => {
    it('calls agentRunner.execute twice and runTests twice', async () => {
      const m = makeMocks();
      let testCallCount = 0;
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        testCallCount++;
        if (testCallCount === 1) return { passed: false, output: 'AssertionError' };
        return { passed: true, output: '' };
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await runner.execute(makeContext({ maxCorrectionRetries: 1 }));

      expect(m.agentRunner.execute).toHaveBeenCalledTimes(2);
      expect(m.cmd.runTests).toHaveBeenCalledTimes(2);
    });

    it('writes error log after failure, deletes it after success', async () => {
      const m = makeMocks();
      let testCallCount = 0;
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        testCallCount++;
        if (testCallCount === 1) return { passed: false, output: 'AssertionError' };
        return { passed: true, output: '' };
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);
      const ctx = makeContext({ maxCorrectionRetries: 1 });

      await runner.execute(ctx);

      const writeCalls = (m.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
      const errorLogWrite = writeCalls.find(c => c[0] === ctx.errorLogPath);
      expect(errorLogWrite).toBeTruthy();
      expect(errorLogWrite![1]).toContain('AssertionError');

      expect(m.fs.deleteFile).toHaveBeenCalledWith(ctx.errorLogPath);
    });

    it('attaches errorLog on second agent invocation', async () => {
      const m = makeMocks();
      let testCallCount = 0;
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        testCallCount++;
        if (testCallCount === 1) return { passed: false, output: 'AssertionError' };
        return { passed: true, output: '' };
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);
      const ctx = makeContext({ maxCorrectionRetries: 1 });

      await runner.execute(ctx);

      const calls = (m.agentRunner.execute as ReturnType<typeof vi.fn>).mock.calls;
      const firstRequest = calls[0][0] as AgentRunRequest;
      const secondRequest = calls[1][0] as AgentRunRequest;

      expect(firstRequest.artefacts.errorLog).toBeUndefined();
      expect(secondRequest.artefacts.errorLog).toBe(ctx.errorLogPath);
    });

    it('second prompt contains attemptNumber meta', async () => {
      const m = makeMocks();
      let testCallCount = 0;
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        testCallCount++;
        if (testCallCount === 1) return { passed: false, output: 'AssertionError' };
        return { passed: true, output: '' };
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await runner.execute(makeContext({ maxCorrectionRetries: 1 }));

      const calls = (m.agentRunner.execute as ReturnType<typeof vi.fn>).mock.calls;
      const firstPrompt = (calls[0][0] as AgentRunRequest).prompt;
      const secondPrompt = (calls[1][0] as AgentRunRequest).prompt;

      expect(JSON.parse(firstPrompt)).not.toHaveProperty('meta.attemptNumber');
      expect(JSON.parse(secondPrompt)).toHaveProperty('meta.attemptNumber', 2);
    });

    it('emits TEST_RUN_FAILED and SELF_CORRECTION_ATTEMPTED', async () => {
      const m = makeMocks();
      let testCallCount = 0;
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        testCallCount++;
        if (testCallCount === 1) return { passed: false, output: 'AssertionError' };
        return { passed: true, output: '' };
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await runner.execute(makeContext({ maxCorrectionRetries: 1 }));

      expect(findEvents(m.emittedEvents, 'TEST_RUN_FAILED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'SELF_CORRECTION_ATTEMPTED')).toHaveLength(1);
    });
  });

  describe('Max retries exhausted', () => {
    it('throws when all attempts fail', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FAIL',
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await expect(
        runner.execute(makeContext({ maxCorrectionRetries: 1 })),
      ).rejects.toThrow(/FAILED after 2 attempt/);
    });

    it('agentRunner.execute called totalAttempts times', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FAIL',
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);

      await expect(
        runner.execute(makeContext({ maxCorrectionRetries: 1 })),
      ).rejects.toThrow();

      // totalAttempts = 2 (maxCorrectionRetries + 1)
      expect(m.agentRunner.execute).toHaveBeenCalledTimes(2);
    });

    it('leaves error log on disk without deleting', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FINAL FAIL',
      });
      const runner = new SelfCorrectionRunner(m.agentRunner, m.cmd, m.git, m.fs, m.events, m.logger);
      const ctx = makeContext({ maxCorrectionRetries: 1 });

      await expect(runner.execute(ctx)).rejects.toThrow();

      // Error log written (containing test output)
      const writeCalls = (m.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
      const errorLogWrite = writeCalls.find(c => c[0] === ctx.errorLogPath);
      expect(errorLogWrite).toBeTruthy();
      expect(errorLogWrite![1]).toContain('FINAL FAIL');

      // Error log NOT deleted
      const deleteCalls = (m.fs.deleteFile as ReturnType<typeof vi.fn>).mock.calls as string[][];
      expect(deleteCalls.find(c => c[0] === ctx.errorLogPath)).toBeFalsy();
    });
  });
});
