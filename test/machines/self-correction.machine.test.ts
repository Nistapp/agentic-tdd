import { createActor, waitFor } from 'xstate';

import { selfCorrectionMachineConfig, createSelfCorrectionMachine } from '../../src/core/machines/self-correction.machine.js';
import { PipelinePass, PASS_LABELS } from '../../src/core/types.js';
import type {
  PipelineContext,
  AgenticEvent,
  AgentRunRequest,
} from '../../src/core/types.js';
import type {
  IGitService,
  IFileSystem,
  ICommandRunner,
  IAgentRunner,
  IEventBus,
  ILogger,
  IContextProvider,
} from '../../src/core/interfaces.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// StubLogger
// ---------------------------------------------------------------------------

class StubLogger implements ILogger {
  readonly calls: { method: string; args: unknown[] }[] = [];

  debug(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'debug', args: [msgOrObj, msg].filter((a: unknown) => a !== undefined) });
  }

  info(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'info', args: [msgOrObj, msg].filter((a: unknown) => a !== undefined) });
  }

  warn(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'warn', args: [msgOrObj, msg].filter((a: unknown) => a !== undefined) });
  }

  error(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'error', args: [msgOrObj, msg].filter((a: unknown) => a !== undefined) });
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
    errorLogPath: `${srcDir}/.agentic-tdd/error-my-feature.log`,
    history: {},
    currentPass: PipelinePass.CoreImplementation,
    currentAttempt: 1,
    runId: 'test-run-id',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMocks() {
  const emittedEvents: AgenticEvent[] = [];

  const agentRunner: IAgentRunner = {
    execute: vi.fn().mockResolvedValue({ output: 'agent output' }),
  };

  const cmd: ICommandRunner = {
    runTests: vi.fn().mockResolvedValue({ passed: true, output: '' }),
  };

  const git: IGitService = {
    commit: vi.fn(),
    getPendingChanges: vi.fn().mockResolvedValue([{ status: 'M', file: 'some/file.ts' }]),
    getCurrentBranch: vi.fn(),
    isDirty: vi.fn(),
    getCurrentCommitSha: vi.fn(),
    getLastCompletedPass: vi.fn(),
    resetWorkingTree: vi.fn(),
    abortToSha: vi.fn(),
    tag: vi.fn(),
  };

  const fs: IFileSystem = {
    exists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue('%% content %%'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  };

  const events: IEventBus = {
    emit: vi.fn((event: AgenticEvent) => {
      emittedEvents.push(event);
    }),
    on: vi.fn().mockReturnValue(() => {}),
  };

  const logger = new StubLogger();

  const contextProvider: IContextProvider = {
    build: vi.fn().mockReturnValue({
      files: { contracts: [], tests: [], implementation: [] },
      targetSymbols: {},
    }),
  };

  return { agentRunner, cmd, git, fs, events, logger, contextProvider, emittedEvents };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEvents(events: AgenticEvent[], kind: string): AgenticEvent[] {
  return events.filter((e) => e.kind === kind);
}

async function waitForDone(actor: ReturnType<typeof createActor>) {
  await waitFor(actor, (snapshot) => snapshot.status === 'done' || snapshot.status === 'error');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelfCorrection Machine', () => {
  describe('Happy path — tests pass on first attempt', () => {
    it('resolves to done state', async () => {
      const m = makeMocks();
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      expect(actor.getSnapshot().status).toBe('done');

      // Machine reached done (success) state, not failed
      const persisted = actor.getPersistedSnapshot();
      expect(persisted).toBeTruthy();
    });

    it('calls agentRunner.execute and cmd.runTests once each', async () => {
      const m = makeMocks();
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      expect(m.agentRunner.execute).toHaveBeenCalledTimes(1);
      expect(m.cmd.runTests).toHaveBeenCalledTimes(1);
    });

    it('emits PASS_STARTED, TEST_RUN_STARTED, TEST_RUN_COMPLETED, PASS_COMPLETED', async () => {
      const m = makeMocks();
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      expect(findEvents(m.emittedEvents, 'PASS_STARTED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'TEST_RUN_STARTED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'TEST_RUN_COMPLETED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'PASS_COMPLETED')).toHaveLength(1);
    });

    it('calls git.getPendingChanges on success (via cleanup)', async () => {
      const m = makeMocks();
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      expect(m.git.getPendingChanges).toHaveBeenCalled();
    });

    it('deletes stale error log on success', async () => {
      const m = makeMocks();
      (m.fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      expect(m.fs.deleteFile).toHaveBeenCalledWith(ctx.errorLogPath);
    });
  });

  describe('Agent invocation ordering', () => {
    it('runs agent BEFORE tests on first attempt', async () => {
      const m = makeMocks();
      const callOrder: string[] = [];
      (m.agentRunner.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('agent');
        return { output: '' };
      });
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('tests');
        return { passed: true, output: '' };
      });

      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      expect(callOrder[0]).toBe('agent');
      expect(callOrder[1]).toBe('tests');
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
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

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
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      const writeCalls = (m.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
      const errorLogWrite = writeCalls.find((c) => c[0] === ctx.errorLogPath);
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
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      const calls = (m.agentRunner.execute as ReturnType<typeof vi.fn>).mock.calls;
      const firstRequest = calls[0]![0] as AgentRunRequest;
      const secondRequest = calls[1]![0] as AgentRunRequest;

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
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      const calls = (m.agentRunner.execute as ReturnType<typeof vi.fn>).mock.calls;
      const firstPrompt = (calls[0]![0] as AgentRunRequest).prompt;
      const secondPrompt = (calls[1]![0] as AgentRunRequest).prompt;

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
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      expect(findEvents(m.emittedEvents, 'TEST_RUN_FAILED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'SELF_CORRECTION_ATTEMPTED')).toHaveLength(1);
    });
  });

  describe('Max retries exhausted', () => {
    it('throws error when all attempts exhaust (AD-12 fix)', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FAIL',
      });
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      // After AD-12 fix, failed entry throws → actor errors
      try {
        await waitForDone(actor);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(String(err)).toContain('FAILED');
      }
      expect(actor.getSnapshot().status).toBe('error');
    });

    it('agentRunner.execute called totalAttempts times', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FAIL',
      });
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      try {
        await waitForDone(actor);
      } catch {
        // expected — AD-12 fix throws
      }

      expect(m.agentRunner.execute).toHaveBeenCalledTimes(2);
    });

    it('emits ERROR when tests exhausted', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FAIL',
      });
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      try {
        await waitForDone(actor);
      } catch {
        // expected — AD-12 fix throws
      }

      const errorEvents = findEvents(m.emittedEvents, 'ERROR');
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it('leaves error log on disk without deleting', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FINAL FAIL',
      });
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext({ maxCorrectionRetries: 1 });
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      try {
        await waitForDone(actor);
      } catch {
        // expected — AD-12 fix throws
      }

      const writeCalls = (m.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
      const errorLogWrite = writeCalls.find((c) => c[0] === ctx.errorLogPath);
      expect(errorLogWrite).toBeTruthy();
      expect(errorLogWrite![1]).toContain('FINAL FAIL');

      const deleteCalls = (m.fs.deleteFile as ReturnType<typeof vi.fn>).mock.calls as string[][];
      expect(deleteCalls.find((c) => c[0] === ctx.errorLogPath)).toBeFalsy();
    });
  });

  describe('Agent execution error', () => {
    it('throws when agent rejects (AD-12 fix)', async () => {
      const m = makeMocks();
      (m.agentRunner.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Agent crashed'),
      );
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      try {
        await waitForDone(actor);
      } catch {
        // expected — AD-12 fix throws
      }

      const errorEvents = findEvents(m.emittedEvents, 'ERROR');
      expect(errorEvents.length).toBeGreaterThan(0);
      expect(errorEvents[0]!.message).toContain('Agent crashed');
    });
  });

  describe('Snapshot serialization', () => {
    it('produces a serializable persisted snapshot', async () => {
      const m = makeMocks();
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitForDone(actor);

      const snapshot = actor.getPersistedSnapshot();
      const json = JSON.stringify(snapshot);
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(typeof parsed).toBe('object');
      expect(parsed.status).toBe('done');
    });
  });

  describe('visualisation regression guard', () => {
    it('selfCorrectionMachineConfig uses only string refs in invoke.src', () => {
      type InvokeDef = { src: unknown };

      function collectInvokeSources(node: {
        invoke?: InvokeDef[];
        states?: Record<string, unknown>;
      }): unknown[] {
        const sources: unknown[] = (node.invoke ?? []).map((i) => i.src);
        for (const child of Object.values(node.states ?? {})) {
          sources.push(...collectInvokeSources(child as { invoke?: InvokeDef[]; states?: Record<string, unknown> }));
        }
        return sources;
      }

      const root = (selfCorrectionMachineConfig as { root: { states?: Record<string, unknown> } }).root;
      const allSrcs = collectInvokeSources(root);

      expect(allSrcs.length).toBeGreaterThan(0);

      for (const src of allSrcs) {
        expect(typeof src).toBe('string');
      }
    });
  });

  describe('Assess-First Skip Logic (T4, T5)', () => {
    it('Agent returns SKIP on first attempt -> exits via skipped state (T4)', async () => {
      const m = makeMocks();
      
      m.agentRunner.execute = vi.fn().mockResolvedValue({ output: 'SKIP:3:No core changes' });
      
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitFor(actor, (s) => s.status === 'done');
      
      // Should exit via 'skipped'
      const snapshot = actor.getPersistedSnapshot();
      expect(snapshot.value).toBe('skipped');
      
      // Tests should not have run
      expect(m.cmd.runTests).not.toHaveBeenCalled();
      
      // History should reflect skipped status
      expect(ctx.history[PipelinePass.CoreImplementation]?.status).toBe('skipped');
      expect(ctx.history[PipelinePass.CoreImplementation]?.skipReason).toBe('No core changes');
    });
    
    it('Agent does not skip -> enters normal test-retry loop (T5)', async () => {
      const m = makeMocks();
      
      m.agentRunner.execute = vi.fn().mockResolvedValue({ output: 'Normal output without skip' });
      m.cmd.runTests = vi.fn().mockResolvedValue({ passed: true, output: '' });
      
      const machine = createSelfCorrectionMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        contextProvider: m.contextProvider,
      });
      const ctx = makeContext();
      
      const actor = createActor(machine, { input: { ctx, pass: PipelinePass.CoreImplementation } });
      actor.start();

      await waitFor(actor, (s) => s.status === 'done');
      
      // Should exit via 'done' normally
      const snapshot = actor.getPersistedSnapshot();
      expect(snapshot.value).toBe('done');
      
      // Tests should have run
      expect(m.cmd.runTests).toHaveBeenCalledTimes(1);
    });
  });
});
