import { PipelineOrchestrator } from '../src/core/orchestrator.js';
import type { HitlHandler } from '../src/core/orchestrator.js';
import { PipelinePass } from '../src/core/types.js';
import type {
  PipelineContext,
  AgenticEvent,
  FileChange,
  HitlPayload,
} from '../src/core/types.js';
import type {
  IGitService,
  IFileSystem,
  ICommandRunner,
  IAgentRunner,
  IEventBus,
  ILogger,
  IStateStore,
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
    history: {},
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
  events: IEventBus;
  config: PipelineConfig;
  logger: StubLogger;
  stateStore: IStateStore;
  hitl: HitlHandler;
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

  const events: IEventBus = {
    emit: vi.fn((event: AgenticEvent) => {
      emittedEvents.push(event);
      // Sync listener map so `on('ERROR', fn)` subscribes and gets called
      const listeners = (events as unknown as { _listeners: Map<string, Array<(e: AgenticEvent) => void>> })._listeners;
      const fns = listeners?.get(event.kind);
      if (fns) {
        for (const fn of fns) {
          fn(event);
        }
      }
    }),
    on: vi.fn((kind: string, handler: (event: AgenticEvent) => void) => {
      const self = events as unknown as { _listeners: Map<string, Array<(e: AgenticEvent) => void>> };
      if (!self._listeners) self._listeners = new Map();
      const existing = self._listeners.get(kind) ?? [];
      existing.push(handler);
      self._listeners.set(kind, existing);
      return () => {
        const list = self._listeners.get(kind);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        }
      };
    }),
  };

  const config: PipelineConfig = {
    opencodeLogPath: '/home/fake/.local/share/opencode/log/opencode.log',
    apiKeySet: 'present',
  };

  const stateStore: IStateStore = {
    path: '/project/.opencode/state-my_module.json',
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
  };

  const hitl = vi.fn().mockResolvedValue(undefined);

  const logger = new StubLogger();

  return { git, fs, cmd, agentRunner, events, config, logger, stateStore, hitl, emittedEvents };
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
    it('calls agentRunner.execute for all 8 passes and cmd.runTests for self-correction passes', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx);

      expect(result).toBe(true);
      // Passes 0, 1, 2 use agentRunner directly (3 calls);
      // Passes 3-7 use self-correction machine which calls agentRunner (5 calls) → 8 total
      expect(m.agentRunner.execute).toHaveBeenCalledTimes(8);
      // Passes 3-7 each run tests once → 5 calls
      expect(m.cmd.runTests).toHaveBeenCalledTimes(5);
    });

    it('emits PIPELINE_STARTED and PIPELINE_COMPLETED', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(findEvents(m.emittedEvents, 'PIPELINE_STARTED')).toHaveLength(1);
      const completed = findEvents(m.emittedEvents, 'PIPELINE_COMPLETED');
      expect(completed).toHaveLength(1);
    });

    it('emits PASS_STARTED and PASS_COMPLETED for all 8 passes', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(findEvents(m.emittedEvents, 'PASS_STARTED')).toHaveLength(8);
      expect(findEvents(m.emittedEvents, 'PASS_COMPLETED')).toHaveLength(8);
    });

    it('calls git.commit for passes 1–7 (7 commits)', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      // 7 commits: Passes 1-7
      expect(m.git.commit).toHaveBeenCalledTimes(7);
    });

    it('does NOT emit HITL_REQUIRED when skipHitl is true', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(0);
    });

    it('emits HITL_REQUIRED and calls hitl handler when skipHitl is false', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: false }));

      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(2);
      expect(m.hitl).toHaveBeenCalledTimes(2);
    });

    it('calls hitl handler with correct pass and files for Pass 0 and Pass 2', async () => {
      const m = makeMocks();
      const testFiles: FileChange[] = [
        { status: 'A', file: 'test/foo.test.ts' },
        { status: 'A', file: 'test/bar.test.ts' },
      ];
      (m.git.getPendingChanges as ReturnType<typeof vi.fn>).mockResolvedValue(testFiles);
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: false }));

      expect(m.hitl).toHaveBeenCalledWith(PipelinePass.Design, testFiles);
      expect(m.hitl).toHaveBeenCalledWith(PipelinePass.TestGeneration, testFiles);
    });

    it('characterization: event kind sequence for full 8-pass happy path', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

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
          "PASS_STARTED",
          "TEST_RUN_STARTED",
          "TEST_RUN_COMPLETED",
          "PASS_COMPLETED",
          "PASS_STARTED",
          "TEST_RUN_STARTED",
          "TEST_RUN_COMPLETED",
          "PASS_COMPLETED",
          "PASS_STARTED",
          "TEST_RUN_STARTED",
          "TEST_RUN_COMPLETED",
          "PASS_COMPLETED",
          "PASS_STARTED",
          "TEST_RUN_STARTED",
          "TEST_RUN_COMPLETED",
          "PASS_COMPLETED",
          "PASS_STARTED",
          "TEST_RUN_STARTED",
          "TEST_RUN_COMPLETED",
          "PASS_COMPLETED",
          "PIPELINE_COMPLETED",
        ]
      `);
    });
  });

  describe('HITL — existing synchronous path', () => {
    it('rejects the pipeline when the HITL handler throws', async () => {
      const m = makeMocks();
      m.hitl = vi.fn().mockRejectedValue(new Error('HITL rejected by user'));

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await expect(
        orch.run(makeContext({ skipHitl: false })),
      ).rejects.toThrow('HITL rejected by user');

      expect(findEvents(m.emittedEvents, 'ERROR').length).toBeGreaterThan(0);

      // git.commit must never be called — pipeline fails at first HITL gate
      expect(m.git.commit).not.toHaveBeenCalled();
    });

    it('emits HITL_REQUIRED events with correct payload (files + message)', async () => {
      const m = makeMocks();
      const testFiles: FileChange[] = [
        { status: 'A', file: 'src/foo.ts' },
      ];
      (m.git.getPendingChanges as ReturnType<typeof vi.fn>).mockResolvedValue(testFiles);
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: false }));

      const hitlEvents = findEvents(m.emittedEvents, 'HITL_REQUIRED');
      expect(hitlEvents).toHaveLength(2);

      for (const evt of hitlEvents) {
        expect(evt.message).toMatch(/Review generated artefacts for Pass/);
        const payload = evt.payload as HitlPayload;
        expect(payload.files).toEqual(testFiles);
      }

      expect(hitlEvents[0]!.pass).toBe(PipelinePass.Design);
      expect(hitlEvents[1]!.pass).toBe(PipelinePass.TestGeneration);
    });

    it('invokes the HITL handler exactly twice (Pass 0 and Pass 2) and never for other passes', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await orch.run(makeContext({ skipHitl: false }));

      expect(m.hitl).toHaveBeenCalledTimes(2);
      expect(m.hitl).toHaveBeenCalledWith(PipelinePass.Design, expect.any(Array));
      expect(m.hitl).toHaveBeenCalledWith(PipelinePass.TestGeneration, expect.any(Array));
    });
  });

  describe('Pass 0 — design phase', () => {
    it('runs Pass 0 and handles design artefacts', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      // writeFile called for design artefacts
      expect(m.fs.writeFile).toHaveBeenCalledWith(ctx.designMmdPath, '');
      expect(m.fs.writeFile).toHaveBeenCalledWith(ctx.specGherkinPath, '');

      // All 8 passes use agentRunner through the machine
      expect(m.agentRunner.execute).toHaveBeenCalledTimes(8);
    });
  });

  describe('Error handling', () => {
    it('rejects when an agent run fails', async () => {
      const m = makeMocks();
      let callCount = 0;
      (m.agentRunner.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount > 1) throw new Error('Agent execution failed');
        return { output: '' };
      });

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

      await expect(
        orch.run(makeContext({ skipHitl: true })),
      ).rejects.toThrow('Agent execution failed');

      expect(findEvents(m.emittedEvents, 'ERROR').length).toBeGreaterThan(0);
    });
  });

  describe('Event payload accuracy', () => {
    it('passes currentPass and passLabel on every pass-level event', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);

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
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      const commitCalls = (m.git.commit as ReturnType<typeof vi.fn>).mock.calls;
      const pass2Commit = commitCalls.find((call: unknown[]) => (call[1] as string).includes('completed Pass 2'));
      expect(pass2Commit).toBeTruthy();
      expect(pass2Commit![0]).toContain('.');
    });
  });

  describe('Rebase Pattern — resume with startPass', () => {
    it('runs only passes from startPass onwards (Pass 3 resume)', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx, PipelinePass.CoreImplementation);

      expect(result).toBe(true);
      // Passes 3-7: 5 agent calls and 5 test runs through self-correction machine
      expect(m.agentRunner.execute).toHaveBeenCalledTimes(5);
      expect(m.cmd.runTests).toHaveBeenCalledTimes(5);
      // Passes 3-7 each commit → 5 commits
      expect(m.git.commit).toHaveBeenCalledTimes(5);
    });

    it('runs only Pass 7 when starting at Documentation', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx, PipelinePass.Documentation);

      expect(result).toBe(true);
      expect(m.agentRunner.execute).toHaveBeenCalledTimes(1);
      expect(m.cmd.runTests).toHaveBeenCalledTimes(1);
      expect(m.git.commit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Snapshot serialization', () => {
    it('populates ctx.xstateSnapshot after completion', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      expect(ctx.xstateSnapshot).toBeDefined();
      expect(typeof ctx.xstateSnapshot).toBe('object');
      const json = JSON.stringify(ctx.xstateSnapshot);
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(parsed.status).toBe('done');
    });

    it('resumes from final snapshot without re-running agents', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      expect(ctx.xstateSnapshot).toBeDefined();
      const prevAgentCalls = (m.agentRunner.execute as ReturnType<typeof vi.fn>).mock.calls.length;
      const prevCommitCalls = (m.git.commit as ReturnType<typeof vi.fn>).mock.calls.length;

      // Run again with the snapshot — should resolve immediately without re-invoking agents
      const ctx2 = makeContext({ skipHitl: true, xstateSnapshot: ctx.xstateSnapshot });
      const m2 = makeMocks();
      const orch2 = new PipelineOrchestrator(m2.git, m2.fs, m2.cmd, m2.agentRunner, m2.events, m2.logger, m2.config, m2.stateStore, m2.hitl);

      const result = await orch2.run(ctx2);

      expect(result).toBe(true);
      // Snapshot restores to 'done' state — no agents run again
      expect((m2.agentRunner.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect((m2.git.commit as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('saves final snapshot via stateStore on completion', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.agentRunner, m.events, m.logger, m.config, m.stateStore, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      // stateStore.save called after pipeline completes — orchestrator owns persistence
      expect(m.stateStore.save).toHaveBeenCalled();
      // ctx passed to save includes xstateSnapshot
      const saveCall = (m.stateStore.save as ReturnType<typeof vi.fn>).mock.calls.at(-1) as unknown[] | undefined;
      const savedCtx = saveCall?.[0] as PipelineContext | undefined;
      expect(savedCtx?.xstateSnapshot).toBeDefined();
    });
  });
});
