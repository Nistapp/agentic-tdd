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
  IEventBus,
} from '../src/core/interfaces.js';
import { vi } from 'vitest';
import { join } from 'node:path';
import { cwd } from 'node:process';

// ---------------------------------------------------------------------------
// Factory for a minimal PipelineContext (all artefact paths in specs/)
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const specsDir = '/project/specs';
  const srcDir = '/project/src';
  return {
    issueName: 'my_module',
    testCmd: ['npm', 'test'],
    skipHitl: true,
    maxCorrectionRetries: 2,
    pipelineVersion: '1.0.0',
    sourceType: 'file',
    logLevel: 'INFO',
    specFileAbsPath: `${specsDir}/my_module.md`,
    issueDescription: 'Create a simple utility module',
    artefactDir: specsDir,
    designMmdPath: `${specsDir}/my_module.mmd`,
    specGherkinPath: `${specsDir}/my_module.gherkin`,
    errorLogPath: `${srcDir}/.opencode_error.log`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factory — returns fresh vi.fn() mocks for every service
// ---------------------------------------------------------------------------

interface Mocks {
  git: IGitService;
  fs: IFileSystem;
  cmd: ICommandRunner;
  events: IEventBus;
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
    readFile: vi.fn().mockResolvedValue('%% Module: my_module\n'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  };

  const cmd: ICommandRunner = {
    runTests: vi.fn().mockResolvedValue({ passed: true, output: '' }),
    runOpenCode: vi.fn().mockResolvedValue(''),
  };

  const events: IEventBus = {
    emit: vi.fn((event: AgenticEvent) => {
      emittedEvents.push(event);
    }),
    on: vi.fn().mockReturnValue(() => {}),
  };

  const hitl = vi.fn().mockResolvedValue(undefined);

  return { git, fs, cmd, events, hitl, emittedEvents };
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
    it('calls runOpenCode exactly 8 times (once per pass)', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx);

      expect(result).toBe(true);
      expect(m.cmd.runOpenCode).toHaveBeenCalledTimes(8);
    });

    it('emits PIPELINE_STARTED and PIPELINE_COMPLETED', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(findEvents(m.emittedEvents, 'PIPELINE_STARTED')).toHaveLength(1);
      const completed = findEvents(m.emittedEvents, 'PIPELINE_COMPLETED');
      expect(completed).toHaveLength(1);
    });

    it('emits PASS_STARTED and PASS_COMPLETED for all 8 passes', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));
      console.log(m.emittedEvents.filter(e => e.kind === 'PASS_STARTED').map(e => e.pass));

      expect(findEvents(m.emittedEvents, 'PASS_STARTED')).toHaveLength(8);
      expect(findEvents(m.emittedEvents, 'PASS_COMPLETED')).toHaveLength(8);
    });

    it('runs tests for each self-correction pass exactly once on success', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      // Passes 3, 4, 5, 6 each run tests once → 4 calls
      expect(m.cmd.runTests).toHaveBeenCalledTimes(SELF_CORRECTION_PASSES.size);
    });

    it('calls git.commit for passes 1–7 (7 commits)', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      // 7 commits: Passes 1-7
      expect(m.git.commit).toHaveBeenCalledTimes(7);
    });

    it('does NOT emit HITL_REQUIRED when skipHitl is true', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(0);
    });

    it('emits HITL_REQUIRED and calls hitl handler when skipHitl is false', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await orch.run(makeContext({ skipHitl: false }));

      expect(findEvents(m.emittedEvents, 'HITL_REQUIRED')).toHaveLength(1);
      expect(m.hitl).toHaveBeenCalledTimes(1);
    });

    it('includes design artefact, Gherkin spec, and spec file in Pass 0 opencode args', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
      const ctx = makeContext({ skipHitl: true });
      const designBefore = ctx.designMmdPath;
      const specBefore = ctx.specGherkinPath;
      const issueSpec = ctx.specFileAbsPath;

      await orch.run(ctx);

      const firstCall = (m.cmd.runOpenCode as ReturnType<typeof vi.fn>).mock.calls[0];
      const args = firstCall[0] as string[];
      expect(args).toContain(designBefore);
      expect(args).toContain(specBefore);
      expect(args).toContain(issueSpec);
      expect(args).toContain('--dangerously-skip-permissions');
    });
  });

  describe('Pass 0 — design phase', () => {
    it('runs Pass 0 and handles design artefacts', async () => {
      const m = makeMocks();

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      await orch.run(ctx);

      // writeFile called for design artefacts and potentially state files
      expect(m.fs.writeFile).toHaveBeenCalledWith(ctx.designMmdPath, '');
      expect(m.fs.writeFile).toHaveBeenCalledWith(ctx.specGherkinPath, '');

      // Total opencode calls: 8 (Pass 0 + Passes 1-7)
      expect(m.cmd.runOpenCode).toHaveBeenCalledTimes(8);
    });
  });

  describe('Self-Correction Path — Pass 3 fails once then recovers', () => {
    it('writes error log, retries agent, deletes error log, and ultimately succeeds', async () => {
      const m = makeMocks();

      // runTests: fail on 1st call (Pass 3 attempt 1), succeed on all later calls
      let testCallCount = 0;
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        testCallCount++;
        if (testCallCount === 1) {
          return { passed: false, output: 'AssertionError: expected 3 to equal 4' };
        }
        return { passed: true, output: '' };
      });

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await orch.run(makeContext({ skipHitl: true }));

      // runOpenCode: 8 passes + 1 correction = 9 calls
      expect(m.cmd.runOpenCode).toHaveBeenCalledTimes(9);

      // runTests: Pass 3 fails once → 2 calls for Pass 3, +3 for Pass 4-6 = 5
      expect(m.cmd.runTests).toHaveBeenCalledTimes(SELF_CORRECTION_PASSES.size + 1);

      // Context Compaction: error log written once, then deleted on pass
      expect(m.fs.writeFile).toHaveBeenCalled();
      const writeCalls = (m.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const errorLogCall = writeCalls.find((c: unknown[]) => (c[0] as string).endsWith('.opencode_error.log'));
      expect(errorLogCall).toBeTruthy();
      expect(errorLogCall[1]).toContain('AssertionError');

      expect(m.fs.deleteFile).toHaveBeenCalledWith('/project/src/.opencode_error.log');

      // Events
      expect(findEvents(m.emittedEvents, 'SELF_CORRECTION_ATTEMPTED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'TEST_RUN_FAILED')).toHaveLength(1);
      expect(findEvents(m.emittedEvents, 'PIPELINE_COMPLETED')).toHaveLength(1);
    });
  });

  describe('Self-Correction Path — max retries exhausted', () => {
    it('throws an error when all retries are consumed and tests still fail', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        output: 'FAIL',
      });

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

      await expect(
        orch.run(makeContext({ skipHitl: true, maxCorrectionRetries: 1 })),
      ).rejects.toThrow(/FAILED after 2 attempt/);

      // Error on Pass 3 aborts pipeline — passes 4-7 never execute.
      // Pass 0:1 + Pass 1:1 + Pass 2:1 + Pass 3:2 (initial + correction) = 5
      expect(m.cmd.runOpenCode).toHaveBeenCalledTimes(5);

      // Error log deleted after last failed attempt
      expect(m.fs.deleteFile).toHaveBeenCalledWith('/project/src/.opencode_error.log');
    });
  });

  describe('Event payload accuracy', () => {
    it('passes currentPass and passLabel on every event', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);

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
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
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
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx, PipelinePass.CoreImplementation); // start at Pass 3

      expect(result).toBe(true);
      // Passes 0, 1, 2 skipped; Passes 3-7 run = 5 opencode calls
      expect(m.cmd.runOpenCode).toHaveBeenCalledTimes(5);
      // Passes 3, 4, 5, 6 each run tests once
      expect(m.cmd.runTests).toHaveBeenCalledTimes(SELF_CORRECTION_PASSES.size);
    });

    it('runs only Pass 7 when starting at Documentation', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const result = await orch.run(ctx, PipelinePass.Documentation);

      expect(result).toBe(true);
      expect(m.cmd.runOpenCode).toHaveBeenCalledTimes(1);
      expect(m.cmd.runTests).not.toHaveBeenCalled();
    });

    it('deletes state file on successful completion', async () => {
      const m = makeMocks();
      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
      const ctx = makeContext({ skipHitl: true });

      const stateFilePath = join(cwd(), '.opencode', 'active-run.json');
      // exists returns true for the state file
      (m.fs.exists as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
        if (p === stateFilePath) return true;
        return true;
      });

      await orch.run(ctx);

      expect(m.fs.deleteFile).toHaveBeenCalledWith(stateFilePath);
    });

    it('does NOT delete state file when pipeline fails', async () => {
      const m = makeMocks();
      (m.cmd.runTests as ReturnType<typeof vi.fn>).mockResolvedValue({ passed: false, output: 'FAIL' });

      const orch = new PipelineOrchestrator(m.git, m.fs, m.cmd, m.events, m.hitl);
      const ctx = makeContext({ skipHitl: true, maxCorrectionRetries: 0 });

      const stateFilePath = join(cwd(), '.opencode', 'active-run.json');
      (m.fs.exists as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
        if (p === stateFilePath) return true;
        return true;
      });

      await expect(orch.run(ctx)).rejects.toThrow();

      expect(m.fs.deleteFile).not.toHaveBeenCalledWith(stateFilePath);
    });
  });
});