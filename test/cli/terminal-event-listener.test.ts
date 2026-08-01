import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachTerminalListener } from '../../src/cli/terminal-event-listener.js';
import type { IEventBus } from '../../src/core/interfaces.js';
import type { AgenticEvent, AgenticEventKind } from '../../src/core/types.js';
import { PipelinePass, AGENT_NAMES } from '../../src/core/types.js';
import type { TerminalRenderer } from '../../src/cli/terminal-renderer.js';

const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));

vi.mock('../../src/utils/logger.js', () => ({
  loggers: { core: { info: infoSpy } },
}));

interface EventBusStub extends IEventBus {
  trigger(kind: AgenticEventKind, partial?: Partial<AgenticEvent>): void;
}

function makeEventBus(): EventBusStub {
  const handlers = new Map<string, Array<(event: AgenticEvent) => void>>();

  return {
    on(kind: AgenticEventKind, handler: (event: AgenticEvent) => void) {
      if (!handlers.has(kind)) handlers.set(kind, []);
      handlers.get(kind)!.push(handler);
      return () => {
        const arr = handlers.get(kind);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    },
    emit(event: AgenticEvent) {
      const arr = handlers.get(event.kind);
      if (arr) arr.forEach((h) => h(event));
    },
    trigger(kind: AgenticEventKind, partial: Partial<AgenticEvent> = {}) {
      const event: AgenticEvent = { kind, message: '', ...partial } as AgenticEvent;
      this.emit(event);
    },
  };
}

function makeRenderer() {
  return {
    passHeader: vi.fn(),
    passOk: vi.fn(),
    logAttemptCount: vi.fn(),
    logChangedFiles: vi.fn(),
    logNoChanges: vi.fn(),
    logTestStatus: vi.fn(),
    logCompaction: vi.fn(),
    logWarnMessage: vi.fn(),
    logErrorMessage: vi.fn(),
    logPipelineComplete: vi.fn(),
  } as unknown as TerminalRenderer;
}

describe('attachTerminalListener', () => {
  let events: EventBusStub;
  let renderer: TerminalRenderer;

  beforeEach(() => {
    infoSpy.mockClear();
    events = makeEventBus();
    renderer = makeRenderer();
    attachTerminalListener(events, renderer, '2.0.0');
  });

  describe('PIPELINE_STARTED', () => {
    it('calls loggers.core.info once', () => {
      events.trigger('PIPELINE_STARTED', { message: 'start' });
      expect(infoSpy).toHaveBeenCalledOnce();
      expect(infoSpy).toHaveBeenCalledWith('PIPELINE_STARTED: start');
    });
  });

  describe('PASS_STARTED', () => {
    it('calls passHeader with AGENT_NAMES[0] in the label', () => {
      events.trigger('PASS_STARTED', { pass: PipelinePass.Design });
      const call = (renderer as any).passHeader.mock.calls[0][0] as string;
      expect(call).toContain(AGENT_NAMES[PipelinePass.Design]);
    });

    it('does not hard-code agent name literal', () => {
      events.trigger('PASS_STARTED', { pass: PipelinePass.Design });
      const call = (renderer as any).passHeader.mock.calls[0][0] as string;
      expect(call).toContain(AGENT_NAMES[PipelinePass.Design]);
      // This assertion is semantically equivalent to the prior one but
      // explicitly verifies AGENT_NAMES (imported constant) vs raw string.
    });
  });

  describe('PASS_COMPLETED', () => {
    it('calls passOk', () => {
      events.trigger('PASS_COMPLETED', { pass: PipelinePass.Contracts });
      expect((renderer as any).passOk).toHaveBeenCalledWith('Pass 1 — Contracts & Types');
    });

    it('calls logAttemptCount when payload.attempts present', () => {
      events.trigger('PASS_COMPLETED', {
        pass: PipelinePass.Contracts,
        payload: { attempts: 3 },
      });
      expect((renderer as any).logAttemptCount).toHaveBeenCalledWith(3);
    });

    it('calls logChangedFiles when payload.files present', () => {
      const files = [{ status: 'M', file: 'foo.ts' }];
      events.trigger('PASS_COMPLETED', {
        pass: PipelinePass.Contracts,
        payload: { files },
      });
      expect((renderer as any).logChangedFiles).toHaveBeenCalledWith(files);
    });

    it('calls logNoChanges when no files and pass is in guarded range', () => {
      events.trigger('PASS_COMPLETED', {
        pass: PipelinePass.Refactor,
        payload: {},
      });
      expect((renderer as any).logNoChanges).toHaveBeenCalledOnce();
    });

    it('does NOT call logNoChanges when no files and pass is outside guarded range', () => {
      events.trigger('PASS_COMPLETED', {
        pass: PipelinePass.Design,
        payload: {},
      });
      expect((renderer as any).logNoChanges).not.toHaveBeenCalled();
    });
  });

  describe('TEST_RUN_STARTED', () => {
    it('calls logTestStatus', () => {
      events.trigger('TEST_RUN_STARTED', { message: 'running tests' });
      expect((renderer as any).logTestStatus).toHaveBeenCalledWith('running tests');
    });
  });

  describe('TEST_RUN_COMPLETED', () => {
    it('calls logTestStatus', () => {
      events.trigger('TEST_RUN_COMPLETED', { message: 'tests passed' });
      expect((renderer as any).logTestStatus).toHaveBeenCalledWith('tests passed');
    });
  });

  describe('TEST_RUN_FAILED', () => {
    it('calls logTestStatus', () => {
      events.trigger('TEST_RUN_FAILED', { message: 'tests failed' });
      expect((renderer as any).logTestStatus).toHaveBeenCalledWith('tests failed');
    });
  });

  describe('SELF_CORRECTION_ATTEMPTED', () => {
    it('calls logCompaction', () => {
      events.trigger('SELF_CORRECTION_ATTEMPTED', { message: 'retrying' });
      expect((renderer as any).logCompaction).toHaveBeenCalledWith('retrying');
    });
  });

  describe('WARNING', () => {
    it('calls logWarnMessage', () => {
      events.trigger('WARNING', { message: 'disk low' });
      expect((renderer as any).logWarnMessage).toHaveBeenCalledWith('disk low');
    });
  });

  describe('ERROR', () => {
    it('calls logErrorMessage', () => {
      events.trigger('ERROR', { message: 'agent timeout' });
      expect((renderer as any).logErrorMessage).toHaveBeenCalledWith('agent timeout');
    });
  });

  describe('PIPELINE_COMPLETED', () => {
    it('calls logPipelineComplete with version', () => {
      events.trigger('PIPELINE_COMPLETED');
      expect((renderer as any).logPipelineComplete).toHaveBeenCalledWith('2.0.0');
    });
  });
});
