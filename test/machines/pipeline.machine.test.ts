import { createActor, waitFor } from 'xstate';

import { createPipelineMachine, getInitialStateForPass } from '../../src/core/machines/pipeline.machine.js';
import { PipelinePass } from '../../src/core/types.js';
import type {
  PipelineContext,
  AgenticEvent,
  FileChange,
} from '../../src/core/types.js';
import type {
  IGitService,
  IFileSystem,
  ICommandRunner,
  IAgentRunner,
  IEventBus,
  ILogger,
  IStateStore,
} from '../../src/core/interfaces.js';
import type { HitlHandler } from '../../src/core/orchestrator.js';
import { vi, describe, it, expect } from 'vitest';

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
    errorLogPath: `${srcDir}/.opencode_error.log`,
    history: {},
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
    execute: vi.fn().mockResolvedValue({ output: '' }),
  };

  const cmd: ICommandRunner = {
    runTests: vi.fn().mockResolvedValue({ passed: true, output: '' }),
  };

  const git: IGitService = {
    commit: vi.fn().mockResolvedValue({ kind: 'committed' as const, message: 'ok' }),
    getPendingChanges: vi.fn().mockResolvedValue([] as FileChange[]),
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

  const events: IEventBus = {
    emit: vi.fn((event: AgenticEvent) => {
      emittedEvents.push(event);
    }),
    on: vi.fn().mockReturnValue(() => {}),
  };

  const stateStore: IStateStore = {
    path: '/project/.opencode/state-my_module.json',
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
  };

  const logger = new StubLogger();
  const hitl: HitlHandler = vi.fn().mockResolvedValue(undefined as void);

  return {
    agentRunner,
    cmd,
    git,
    fs,
    events,
    logger,
    stateStore,
    hitl,
    emittedEvents,
  };
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

describe('Pipeline Machine', () => {
  describe('Full happy path (skipHitl)', () => {
    it('completes all 8 passes and reaches pipeline_complete', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      expect(actor.getSnapshot().status).toBe('done');

      // Should have PIPELINE_STARTED and PIPELINE_COMPLETED events
      expect(findEvents(m.emittedEvents, 'PIPELINE_STARTED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'PIPELINE_COMPLETED')).toHaveLength(1);

      // No HITL events (skipHitl=true)
      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(0);
    });

    it('emits PASS_STARTED and PASS_COMPLETED for each pass', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      expect(findEvents(m.emittedEvents, 'PASS_STARTED').length).toBe(8);
      expect(findEvents(m.emittedEvents, 'PASS_COMPLETED').length).toBe(8);
    });

    it('calls git.commit for committed passes (1-7)', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      expect(m.git.commit).toHaveBeenCalledTimes(7);
    });
  });

  describe('HITL gates', () => {
    it('goes through HITL for pass 0 and pass 2 when skipHitl is false', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: false });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      // HITL_REQUIRED should be emitted for pass 0 and pass 2
      const hitlEvents = findEvents(m.emittedEvents, 'HITL_REQUIRED');
      expect(hitlEvents.length).toBe(2);
      expect(hitlEvents[0]!.pass).toBe(0);
      expect(hitlEvents[1]!.pass).toBe(2);

      // onHitl callback called twice
      expect(m.hitl).toHaveBeenCalledTimes(2);
    });

    it('skips HITL gates when skipHitl is true', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(0);
      expect(m.hitl).not.toHaveBeenCalled();
    });
  });

  describe('Committing lifecycle (1557 spec)', () => {
    it('does not call stateStore.save from the machine (orchestrator owns persistence)', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      // Machine no longer owns persistence — orchestrator handles it
      expect(m.stateStore.save).not.toHaveBeenCalled();
    });

    it('updates ctx.history[pass].commitHash post-commit', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      // Every committed pass should have its commitHash set
      for (let p = 1; p <= 7; p++) {
        expect(ctx.history[p as PipelinePass]?.commitHash).toBe('abc123def456');
      }
    });

    it('works without stateStore (no persistence mode)', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        // No stateStore
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      expect(actor.getSnapshot().status).toBe('done');
      // stateStore.save not called because there is none
      expect(findEvents(m.emittedEvents, 'PIPELINE_COMPLETED')).toHaveLength(1);
    });

    it('pass 0 does not produce a git commit', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      // 7 committed passes (1-7), not pass 0
      expect(m.git.commit).toHaveBeenCalledTimes(7);
    });
  });

  describe('Error handling', () => {
    it('reaches pipeline_failed when a pass actor rejects', async () => {
      const m = makeMocks();
      // Make the first simple pass (pass 1) fail
      let callCount = 0;
      (m.agentRunner.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount > 1) throw new Error('Agent execution failed');
        return { output: '' };
      });

      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
      actor.start();

      await waitForDone(actor);

      const errorEvents = findEvents(m.emittedEvents, 'ERROR');
      expect(errorEvents.length).toBeGreaterThan(0);
      expect(errorEvents[0]!.message).toContain('Agent execution failed');
    });
  });

  describe('getInitialStateForPass', () => {
    it('returns correct state for each pass', () => {
      expect(getInitialStateForPass(PipelinePass.Design)).toBe('pass_0_design');
      expect(getInitialStateForPass(PipelinePass.Contracts)).toBe('pass_1_contracts');
      expect(getInitialStateForPass(PipelinePass.TestGeneration)).toBe('pass_2_test_generation');
      expect(getInitialStateForPass(PipelinePass.CoreImplementation)).toBe('pass_3_core_implementation');
      expect(getInitialStateForPass(PipelinePass.Refactor)).toBe('pass_4_refactor');
      expect(getInitialStateForPass(PipelinePass.Security)).toBe('pass_5_security');
      expect(getInitialStateForPass(PipelinePass.Observability)).toBe('pass_6_observability');
      expect(getInitialStateForPass(PipelinePass.Documentation)).toBe('pass_7_documentation');
    });
  });

  describe('Resume from middle pass', () => {
    it('starts at pass_4_refactor when startPass=Refactor', async () => {
      const m = makeMocks();
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Refactor } });
      actor.start();

      await waitForDone(actor);

      expect(actor.getSnapshot().status).toBe('done');
      // Only passes 4-7 completed (4 passes) + PIPELINE_STARTED/COMPLETED
      expect(findEvents(m.emittedEvents, 'PASS_STARTED').length).toBe(4);
    });
  });

  describe('Snapshot serialization', () => {
    it('produces a serializable persisted snapshot mid-pipeline', async () => {
      const m = makeMocks();

      // Build a machine that pauses after a few passes
      // We won't be able to pause perfectly due to sync invocations,
      // but we can verify snapshot after completion
      const machine = createPipelineMachine({
        agentRunner: m.agentRunner,
        cmd: m.cmd,
        fs: m.fs,
        git: m.git,
        events: m.events,
        logger: m.logger,
        stateStore: m.stateStore,
        onHitl: m.hitl,
      });
      const ctx = makeContext({ skipHitl: true });
      const actor = createActor(machine, { input: { ctx, startPass: PipelinePass.Design } });
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
});
