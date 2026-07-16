import { PipelineOrchestrator } from '../src/core/orchestrator.js';
import { PipelinePass, SELF_CORRECTION_PASSES } from '../src/core/types.js';
import type {
  PipelineContext,
  AgenticEvent,
} from '../src/core/types.js';
import type {
  IGitService,
  IFileSystem,
  ICommandRunner,
  IAgentRunner,
  ISelfCorrectionRunner,
  IEventBus,
  ILogger,
  PipelineConfig,
} from '../src/core/interfaces.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Factory for a minimal PipelineContext (all artefact paths in specs/)
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// StubLogger — captures calls for verification
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
// Mock factory — returns fresh vi.fn() mocks for every service
// ---------------------------------------------------------------------------

interface Mocks {
  git: IGitService;
  fs: IFileSystem;
  cmd: ICommandRunner;
  agentRunner: IAgentRunner;
  selfCorrectionRunner: ISelfCorrectionRunner;
  events: IEventBus;
  config: PipelineConfig;
  logger: StubLogger;
  hitl: () => Promise<void>;
  emittedEvents: AgenticEvent[];
}

function makeMocks(): Mocks {
  const emittedEvents: AgenticEvent[] = [];

  const git: IGitService = {
    commit: vi.fn().mockResolvedValue({ kind: 'committed' as const, message: 'ok' }),
    getPendingChanges: vi.fn().mockResolvedValue([]),
    getCurrentBranch: vi.fn().mockResolvedValue('feat/test'),
    isDirty: vi.fn().mockResolvedValue(false),
    getCurrentCommitSha: vi.fn().mockResolvedValue('abc123def456'),
    getLastCompletedPass: vi.fn().mockResolvedValue(null),
    resetWorkingTree: vi.fn().mockResolvedValue(undefined),
    abortToSha: vi.fn().mockResolvedValue(undefined),
  };

  const fs: IFileSystem = {
    exists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue('%% Module: my_module\n%% This is a long enough module design mock string \n'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  };

  const cmd: ICommandRunner = {
    runTests: vi.fn().mockResolvedValue({ passed: true, output: '' }),
  };

  const agentRunner: IAgentRunner = {
    execute: vi.fn().mockResolvedValue({ output: '' }),
  };

  const selfCorrectionRunner: ISelfCorrectionRunner = {
    execute: vi.fn().mockResolvedValue(undefined),
  };

  const events: IEventBus = {
    emit: vi.fn((event: AgenticEvent) => {
      emittedEvents.push(event);
    }),
    on: vi.fn().mockReturnValue(() => { }),
  };

  const config: PipelineConfig = {
    opencodeLogPath: '/home/fake/.local/share/opencode/log/opencode.log',
    apiKeySet: 'present',
  };

  const hitl = vi.fn().mockResolvedValue(undefined);

  const logger = new StubLogger();

  return { git, fs, cmd, agentRunner, selfCorrectionRunner, events, config, logger, hitl, emittedEvents };
}

// ---------------------------------------------------------------------------
// Helper: filter events by kind
// ---------------------------------------------------------------------------

function findEvents(events: AgenticEvent[], kind: string): AgenticEvent[] {
  return events.filter(e => e.kind === kind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineOrchestrator', () => {
  describe('Happy Path — all 8 passes succeed', () => {
    it('calls agentRunner.execute for non-guarded passes and delegates to selfCorrectionRunner for guarded ones', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx);

      expect(result).toBe(true);
      // Passes 0, 1, 2 use agentRunner directly → 3 calls
      expect(m.agentRunner.execute).toHaveBeenCalledTimes(3);
      // Passes 3-7 delegate to selfCorrectionRunner → 5 calls
      expect(m.selfCorrectionRunner.execute).toHaveBeenCalledTimes(5);
    });

    it('emits PIPELINE_STARTED and PIPELINE_COMPLETED', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(findEvents(m.emittedEvents, 'PIPELINE_STARTED')).toHaveLength(1);
      const completed = findEvents(m.emittedEvents, 'PIPELINE_COMPLETED');
      expect(completed).toHaveLength(1);
    });

    it('emits PASS_STARTED and PASS_COMPLETED for non-guarded passes (0, 1, 2)', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));
      console.log(m.emittedEvents.filter(e => e.kind === 'PASS_STARTED').map(e => e.pass));

      expect(findEvents(m.emittedEvents, 'PASS_STARTED')).toHaveLength(3);
      expect(findEvents(m.emittedEvents, 'PASS_COMPLETED')).toHaveLength(3);
    });

    it('delegates to selfCorrectionRunner for each self-correction pass', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      // Passes 3, 4, 5, 6, 7 each delegate once → 5 calls
      expect(m.selfCorrectionRunner.execute).toHaveBeenCalledTimes(SELF_CORRECTION_PASSES.size);
    });

    it('calls git.commit for passes 1–7 (7 commits)', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      // 7 commits: Passes 1-7
      expect(m.git.commit).toHaveBeenCalledTimes(7);
    });

    it('does NOT emit HITL_REQUIRED when skipHitl is true', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(0);
    });

    it('emits HITL_REQUIRED and calls hitl handler when skipHitl is false', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: false }));

      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(1);
      expect(m.hitl).toHaveBeenCalledTimes(1);
    });

    it('includes design artefact, Gherkin spec, and spec file in Pass 0 agent request', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      const firstCall = (m.agentRunner.execute as ReturnType<typeof vi.fn>).mock.calls[0];
      const request = firstCall[0] as { pass: number; prompt: string; artefacts: Record<string, string | undefined>; runId?: string };
      expect(request.pass).toBe(0);
      expect(request.artefacts.designMmd).toBe(ctx.designMmdPath);
      expect(request.artefacts.specGherkin).toBe(ctx.specGherkinPath);
      expect(request.artefacts.specFile).toBe(ctx.specFileAbsPath);
      expect(request.runId).toBeDefined();
      expect(request.prompt).toContain(ctx.featureName);
    });

    it('characterization: event kind sequence for full 8-pass happy path', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(m.emittedEvents.map(e => e.kind)).toMatchInlineSnapshot(`
        [
          "PIPELINE_STARTED",
          "PASS_STARTED",
          "PASS_COMPLETED",
          "PASS_STARTED",
          "PASS_COMPLETED",
          "PASS_STARTED",
          "PASS_COMPLETED",
          "PIPELINE_COMPLETED",
        ]
      `);
    });
  });

  describe('Pass 0 — design phase', () => {
    it('runs Pass 0 and handles design artefacts', async () => {
      const m = makeMocks();

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      // writeFile called for design artefacts and potentially state files
      expect(m.fs.writeFile).toHaveBeenCalledWith(ctx.designMmdPath, '');
      expect(m.fs.writeFile).toHaveBeenCalledWith(ctx.specGherkinPath, '');

      // Passes 0, 1, 2 use agentRunner directly → 3 calls
      expect(m.agentRunner.execute).toHaveBeenCalledTimes(3);
    });
  });

  describe('Self-Correction delegation', () => {
    it('delegates to selfCorrectionRunner for passes 3-7, which handles the loop internally', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      // Self-correction runner called 5 times (once per guarded pass: 3, 4, 5, 6, 7)
      expect(m.selfCorrectionRunner.execute).toHaveBeenCalledTimes(SELF_CORRECTION_PASSES.size);
      // Pipeline completes successfully
      expect(findEvents(m.emittedEvents, 'PIPELINE_COMPLETED')).toHaveLength(1);
    });

    it('throws when selfCorrectionRunner rejects, propagating the error', async () => {
      const m = makeMocks();
      (m.selfCorrectionRunner.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('FAILED after 4 attempt(s). The test suite still fails after 3 self-correction retries.'),
      );

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await expect(
        orch.run(makeContext({ skipHitl: true, maxCorrectionRetries: 3 })),
      ).rejects.toThrow(/FAILED after 4 attempt/);

      expect(findEvents(m.emittedEvents, 'ERROR')).toHaveLength(1);
    });
  });

  describe('Event payload accuracy', () => {
    it('passes currentPass and passLabel on every event', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      for (const evt of m.emittedEvents) {
        if (evt.kind === 'PIPELINE_STARTED' || evt.kind === 'PIPELINE_COMPLETED') continue;
        expect(evt.pass).toBeGreaterThanOrEqual(0);
        expect(evt.passLabel).toBeTruthy();
      }
    });
  });

  describe('Pass 2 commits all changes', () => {
    it('commits all changes after Pass 2 completes', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      const commitCalls = (m.git.commit as ReturnType<typeof vi.fn>).mock.calls;
      const pass2Commit = commitCalls.find((call: unknown[]) => (call[1] as string).includes('completed Pass 2'));
      expect(pass2Commit).toBeTruthy();
      expect(pass2Commit![0]).toEqual(['.']);
    });
  });

  describe('Rebase Pattern — resume with startPass', () => {
    it('runs only passes from startPass onwards (Pass 3 resume)', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx, PipelinePass.CoreImplementation); // start at Pass 3

      expect(result).toBe(true);
      // Passes 0, 1, 2 skipped; Passes 3-7 delegate to selfCorrectionRunner (5 calls); agentRunner not called
      expect(m.selfCorrectionRunner.execute).toHaveBeenCalledTimes(SELF_CORRECTION_PASSES.size);
      expect(m.agentRunner.execute).not.toHaveBeenCalled();
    });

    it('runs only Pass 7 when starting at Documentation', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.selfCorrectionRunner, m.events, m.logger, m.config, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx, PipelinePass.Documentation);

      expect(result).toBe(true);
      expect(m.agentRunner.execute).not.toHaveBeenCalled();
      expect(m.selfCorrectionRunner.execute).toHaveBeenCalledTimes(1);
    });
  });
});