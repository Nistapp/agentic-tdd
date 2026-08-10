import { setup, fromPromise, assign } from 'xstate';
import type { ActorLogic } from 'xstate';

import type {
  PipelineContext,
  PassHistory,
  AgenticEvent,
  AgentRunRequest,
  FileChange,
  HitlPayload,
  PassCompletedPayload,
  TargetSymbols,
  FileChanges,
  FileChangeRecord,
  Range,
} from '../types.js';
import {
  PASS_LABELS,
  GIT_COMMIT_PASSES,
  PipelinePass,
} from '../types.js';
import type {
  IAgentRunner,
  ICommandRunner,
  IFileSystem,
  IGitService,
  IEventBus,
  ILogger,
  IStateStore,
  ISymbolResolver,
  IContextProvider,
} from '../interfaces.js';
import { getAgentContextPayload } from '../runners/shared.js';
import { buildArtefacts } from '../runners/shared.js';
import { sanitizeLogPayload } from '../log-sanitizer.js';
import { parseSkipSignal } from '../skip-parser.js';

import {
  createSelfCorrectionMachine,
  type SelfCorrectionMachineInput,
} from './self-correction.machine.js';

// ---------------------------------------------------------------------------
// Emit helper (closed over IEventBus)
// ---------------------------------------------------------------------------

function makeEmit(events: IEventBus) {
  return function emit(
    kind: AgenticEvent['kind'],
    message: string,
    ctx: PipelineContext,
    payload?: Record<string, unknown>,
  ): void {
    events.emit({
      kind,
      message,
      timestamp: new Date(),
      pass: ctx.currentPass,
      passLabel: ctx.currentPass !== undefined ? PASS_LABELS[ctx.currentPass] : undefined,
      payload,
    } satisfies AgenticEvent);
  };
}

// ---------------------------------------------------------------------------
// Type-safe stub actor for visualisation-only config
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function notWired(name: string): ActorLogic<any, any> {
  return fromPromise(async () => {
    throw new Error(`Actor "${name}" was not wired via .provide()`);
  });
}

// ---------------------------------------------------------------------------
// Machine context & input
// ---------------------------------------------------------------------------

export interface PipelineMachineContext {
  ctx: PipelineContext;
}

export interface PipelineMachineInput {
  ctx: PipelineContext;
  startPass: PipelinePass;
}

// ---------------------------------------------------------------------------
// Initial state helper
// ---------------------------------------------------------------------------

export function getInitialStateForPass(startPass: PipelinePass): string {
  const map: Record<PipelinePass, string> = {
    0: 'pass_0_design',
    1: 'pass_1_contracts',
    2: 'pass_2_test_generation',
    3: 'pass_3_core_implementation',
    4: 'pass_4_refactor',
    5: 'pass_5_observability',
    6: 'pass_6_security',
    7: 'pass_7_documentation',
  };
  const state = map[startPass];
  if (state === undefined) {
    throw new Error(`Invalid start pass: ${startPass}`);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Module-level visualisation config (Stately-parsable, stubs only)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pipelineMachineConfig: any = setup({
  types: {
    input: {} as PipelineMachineInput,
    context: {} as PipelineMachineContext,
  },
  actors: {
    runPass0:            notWired('runPass0'),
    runSimplePass:       notWired('runSimplePass'),
    prepareHitl:         notWired('prepareHitl'),
    rewindToPassStart:   notWired('rewindToPassStart'),
    doAtomicCommit:      notWired('doAtomicCommit'),
    selfCorrectionPass3: notWired('selfCorrectionPass3'),
    selfCorrectionPass4: notWired('selfCorrectionPass4'),
    selfCorrectionPass5: notWired('selfCorrectionPass5'),
    selfCorrectionPass6: notWired('selfCorrectionPass6'),
    selfCorrectionPass7: notWired('selfCorrectionPass7'),
  },
  actions: {
    emitPipelineStarted:  () => {},
    emitPipelineCompleted: () => {},
    emitPipelineError: () => {},
    emitHitlRequired: () => {},
    emitPipelinePaused: () => {},
    emitPipelineResumed: () => {},
  },
  guards: {
    atPass0: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 0,
    atPass1: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 1,
    atPass2: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 2,
    atPass3: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 3,
    atPass4: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 4,
    atPass5: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 5,
    atPass6: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 6,
    atPass7: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 7,
    skipHitl: ({ context }: { context: PipelineMachineContext }) => context.ctx.skipHitl,
    isPauseRequested: ({ context }: { context: PipelineMachineContext }) => context.ctx.pauseRequested === true,
    afterPass0: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 0,
    afterPass1: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 1,
    afterPass2: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 2,
    afterPass3: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 3,
    afterPass4: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 4,
    afterPass5: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 5,
    afterPass6: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 6,
    afterPass7: ({ context }: { context: PipelineMachineContext }) => context.ctx.currentPass === 7,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QAcCWywBtUDswGIAFAQQFUBlAUQG0AGAXURQHtZUAXVZnJkAD0QBGAKwBOACwA6AMyDpAJlFLaogBwA2aeIA0IAJ5D5AXyO60GbHkkB9awCMwUXPjqMkIZKw5ce7gQnlBAHZJdTF1VVE5OXERXQMEVWl1GTDxYWlVLOkc6RMzdCxcMBt7R2dqQTcWNk5uXn9AkLDRCKjZLTj9RCVBSSzBUVpBWi0koNV8j0LLEtsHJxwXeWqPLzrfUEbg0PDI6M7heMR5U6l1cSDpKPkw2lUgoKnzIqt58qXqaVXPWp8Gk47FptA6xI7dBAjaQhQT7UTCWjyYbCDTPGbFUoLCriH7rf5+QHNPbtGJdBKCYLCfrydIqUYaMTGUzTCwY96LFzCXF-eoEgJA4mgslCWRSdJKJHDR73SbMl6zTEfFzqbneXlbQm7Vr7Dpg478oKiGTiWgqILyQ1BdSaNGst5lDnUIKqjYAg1akG64UIBQ0ySna0ZeTJVq214lZAAQ1gsGstGsEDgqCgSwg3BKuAAbswANYR9FWKMxuMJpMphBZ5gAY0jG1crl4vzVm34iE00n6JsE4n28gRD31GiNoiRFMDqnE6kE6jDCqLsfjibYKfwaaslbzknlGPnJaXyZwFZw2ZrdYYlRd+I1CHbneGPZu-aC+pRIWEPcRwmESIuiNnO+jBdS2XJYwAAJzA5gwK3TBawAMyggBbLcCwjQC9zLQ9K1PHx6wYRs8XVVsbxyO9u17J99VOEITQtDRHlUbtYTyOVUK3MCwCjMDcCgawAAsOEwaxd1oVd00kDd8ztCMOK4nj+ME4T0NoI8T1rXDz3w9wm1dPkKWkKlrkyMIaXES4URfQ1-SRS4aU0YQRhnVjpPYzjI24nBeIE9ghJE-BwMg6DkFg9gELA5Dt0LWT3Pk7zfOU1Tq3U7g8MvIj-H0wzRGM78zPM1R9WSVR+jHa4gmEc1ZC-f8rEjAB3SNvE8hSfKU4tRIACQASQAFQAGWsYhCEIAAlAB5AA1GgtJqZs3WnUjaFia5aHUYMDKufV1BUTt30NEYg3EUQapKerGs4Zq4rahd8G6-rrBGygAHUuoAOQAEQbbTCJbDLbyWuQhjWnIKukF9tskUZFFURl7mDQQTskM6mq8xS-LugbHoAKUoABhHqvtm3TrwWjsAZW4GNrBiEHNoaylpHK5NECW5EY4urcAgeS-LXDNj1zKTw0kdnOe5hLsOSnBUoInlfqEc1iqCFQJwM61bmphIgnEDtBEUBQxApPsMjZsAOZwLnmr8gKoJg+CkJQlyRfNsX2sSnCUs0tK5YCYMQgkMRVFuVamf1JWpENRF9IuE0YcR3dBGsKtuHYMDIyrdhYDE9d+c3SK0OLBOk5wFO04zt3Jel77ZbdU5oUkf21CD9QQ4hLJivEPtgfkVRaCtLW4-Qwvk9T9PM+toKQrCiK2PjxPh9L2By7PehCbWau+Vrv3xUD7bm+SUPWlCXuoiuU5X2O5yhd3eRrHYOB2GsGA8FTjYs757Nc5n9Cb7v2AH6f8Cksl4aRXjNNec0N6+3rtvJuLcEjUSNFkL8fZzQjCGE8S+c5v633vo-MAz9JZvwkjnQWWDiw-1wQAl+PhgEexXlUGWECSb-WWkDdaoMqJaHkP0YY9IUFa1lAUFy18cF-zwQQ1+49bahXtnnLc2Df7-3wYAjYtCpae0YcTYim9oEB1gfvCEwZbiSCVgoaQvdYitCWnHaKHlUatWvkQySDsr62Nimjb+ajK5EyvMRW8E57wUXuM+QxI4jQZGuOMCcHcEaYJ3G4y6HjyH+QgjbYKdtwouLnAk+x8VyFeI0VXJhfjSIBPIo+YJhVaBiEkMINaYgO5BG7LERGyMLq5OutYeQt1eoDSGqNSa00vbzTkFlHKpl8pUQfJICkk4hgjAmJEVpDUUYtTybGbpGMHrPTep9MBOlfEZVGTIbKDIJnlQKoYnuUgKpWkUNrb8VoWJCKFm09xDjv49PutjPGBN9k-RGQZE54y8oXKolYmZKJ4QmmtIiC+LyFROwtrxRxvNiEf1IRiJFLsNkFNAcMvSLDAarXYZtQx5U6ZhImK0Q0wYTZm2RZ07pUj0kyMyXI7FltPES2XqvA56UhBEopqSjWJxLQmMuEdS4ppYkIoAsWaQc8OLWFQIhYKYBEL4PYIQtFzi5G7kVUnZVqr1WauLkAnlIC+UAsgXXBuO9g4GPJBY-0Exu5WlNNU9IA8FVKrACqtVmANVasISyyesiv6+qNf6k1QazXatUZauh1r17Xh0fa-R6h9SN0kJOapjELiwnKrKlkV90LiGsBxOCpcoJOJIVk+VsYK1VprWBPFKbimNCgRm3ecDDC63rnIdQagKpRGsXEws5bK1gGrenWtYaMnT2EVOltc621JvUfizRhyTjdpgb2p1QhdZ9BUGIEca0VB2R9bGYQ1hmB2FgOBTMkY7CoGwOwPQdaMUNsncWW997H1gWfa+99eh23-NTdovdeiD1ZohKMvo74x3whRCIAy17rD-ofU+l9b6OCfoXWypdZa-13uw0B3DoHwMErTdBxusH9S6xqVcbsowz2iCuPC0tZDYzqGsI+qsABXbiH6v0Cx-fnXj-GwBCZE2Bjd3jwFaK7Xa-djq4PwJGO3HIMM9btHEBhvjAnhP4ZSYFaRU8JPyOLEZmTJmP3Ue3QKn2qmYPqaoiIKkfZPOGm2qaAzE7JPWCCAmasgn406vEnqyNsYQtpiExFxN-N3abo7cp3drn6PucMdtcJSJsrNxlSaZ53HG3BdCwlkNkjUkT0XVZ3ccWwuJZoQpwpPjnPprU3vDTJwwgpB04W1BvCAtyqsEnRCiEODtLE5-Fy43JvsHaY5op6WAgKCkCGCq9JZBh0YzDPo1pzHK1WoiCciN5tTZ4mZtJ4b2VsQu4tniy32vewtFESGtJ3xQnNBkPbigZmaFNNlaEIPBGlasGAZ9mBBPqWangPgD95wuAg52wVi1WEkpBmS8kFVuFXByE0i05VgeI0h5GaHsPeLw8R4BFwDCVs7shEKthWPRUBGRP0fadTzHBAnE5UbJQycU-adYan11lg0eIqTD7xLKYcPg9rbhU5VZKyhMOkrcihcw5F2LpHXxJd-XR7LkVjGpzFSWqtEya0ohmVJ1D7X8lde0+oDiJz3tpfkxZ1TU3mhjSGkZD2YMdS7fk4d3DsACPxfUC5G7+azPMfe-gxxumFVYTA2nJOdDgXJBa8p6LiPNOYzKgN2jsmGO5fY5OKtPoafaTusciH4XjuC9R+dLHwlRvhWs8Y0rYqYRvxBhBnUsH+rIyCcfRAfAj1yCkAALJDPbyTLWKQHiB0nJoIYfPGOXD9kiDQKh4TDvHcyHAzAlyNlQov4iABaQQ2aOyMRpGoVWZV3yI3ZLgK--hLiFSRDCPegQ7434FwGuMWGEIEX+iAsQzQSQ6CVo2UFUGgB85uiIYQIOZkWQGCAurkckiSHy7UkBCANwMygcZoMMDwFoPWCAdS3C2U8IG0rQR0Egyy507y6ycYhBcgyQJB04Q6aGpwW0poMgE4uU2UtwTB9KosXKBBDOzmgwPcMygQWQeUiIO2ociIoQjE5ogQ9wI4gQGGQ8xcI8GcnBagRoWsHGEge+74OQg4CgMgusZk2UwwlhI24OQWFCYiVCksphMM-ow6eaWs5kiIVEeskM8yX2I40IjwNibkdiayTKhB1wVIa0SQjEwBHq4ICQ5iWgui74igtKE4WB7hSMKyIuV018hBJ8JUyQ1ejc0I4KCIoQagWmHGZUTI2BnKKK38nBsgeOFIX4xKHcwYVEEwfQ6+k4CyfYyRGGhqUEMagawa5qWi-K7ubRnO5kR0VwZkWsjGwwxU0434B0jEBaGGzaM6raphVkFoJoQwDkSQgQOg8GIgK+-mlBZUzcJao+pGAGOGIG+GVxRoNxdI9xCg3YjGigVIDyaRZuWhhm0msmAJshax1xWsIJzEjxHmgQoQmQ7qD4voGGjWlWyxviqx80lhrqtx1SGJ4JOWpwJiRsYQwQ3YFo52zAE2l2nkhBncdMjhE4SQ5iuOVBsIFokMQBI4PcpwSgoBLkueOuLe84vRmQkKHcDwWgHG+2VES03CZk1Sehvcq+XxX84+kAnBpoHYVoXYtK3OUQjGESnOS0D4EQIpwgccqEc8ixd8VxD+Ws5UWxWgkqpugcH2YgmQoyHGRpwi7p1ab6ppyJbogphkNIjy+220P+8Gb2oQR0SQa0MQ2sJgJgQAA */
  id: 'pipeline',
  context: ({ input }) => ({
    ctx: {
      ...input.ctx,
      currentPass: input.startPass,
      currentAttempt: 1,
    },
  }),
  initial: '__begin',
  entry: 'emitPipelineStarted',
  on: {
    PAUSE: {
      actions: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          pauseRequested: true,
        }),
      }),
    },
  },
  states: {
    __begin: {
      always: [
        { guard: 'atPass0', target: 'pass_0_design' },
        { guard: 'atPass1', target: 'pass_1_contracts' },
        { guard: 'atPass2', target: 'pass_2_test_generation' },
        { guard: 'atPass3', target: 'pass_3_core_implementation' },
        { guard: 'atPass4', target: 'pass_4_refactor' },
        { guard: 'atPass5', target: 'pass_5_observability' },
        { guard: 'atPass6', target: 'pass_6_security' },
        { guard: 'atPass7', target: 'pass_7_documentation' },
      ],
    },

    pass_0_design: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 0 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'runPass0',
        input: ({ context }: { context: PipelineMachineContext }) => ({
          ctx: context.ctx,
        }),
        onDone: [
          { guard: 'skipHitl', target: 'committing' },
          { target: 'preparing_hitl_pass_0' },
        ],
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    preparing_hitl_pass_0: {
      invoke: {
        src: 'prepareHitl',
        input: () => ({ pass: 0 as PipelinePass }),
        onDone: {
          target: 'awaiting_hitl_pass_0',
          actions: [
            {
              type: 'emitHitlRequired',
              params: ({ event }: { event: { output: { pass: PipelinePass; files: FileChange[] } } }) => ({
                pass: event.output.pass,
                files: event.output.files,
              }),
            },
          ],
        },
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    awaiting_hitl_pass_0: {
      on: {
        HITL_APPROVE: 'committing',
        HITL_REWIND: 'rewinding_pass_0',
        HITL_REJECT: 'pipeline_failed',
      },
    },

    rewinding_pass_0: {
      invoke: {
        src: 'rewindToPassStart',
        input: ({ context }: { context: PipelineMachineContext }) => ({
          ctx: context.ctx,
          pass: 0 as PipelinePass,
        }),
        onDone: 'pass_0_design',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    pass_1_contracts: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 1 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'runSimplePass',
        input: ({ context }: { context: PipelineMachineContext }) => ({
          ctx: context.ctx,
        }),
        onDone: 'committing',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    pass_2_test_generation: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 2 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'runSimplePass',
        input: ({ context }: { context: PipelineMachineContext }) => ({
          ctx: context.ctx,
        }),
        onDone: [
          { guard: 'skipHitl', target: 'committing' },
          { target: 'preparing_hitl_pass_2' },
        ],
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    preparing_hitl_pass_2: {
      invoke: {
        src: 'prepareHitl',
        input: () => ({ pass: 2 as PipelinePass }),
        onDone: {
          target: 'awaiting_hitl_pass_2',
          actions: [
            {
              type: 'emitHitlRequired',
              params: ({ event }: { event: { output: { pass: PipelinePass; files: FileChange[] } } }) => ({
                pass: event.output.pass,
                files: event.output.files,
              }),
            },
          ],
        },
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    awaiting_hitl_pass_2: {
      on: {
        HITL_APPROVE: 'committing',
        HITL_REWIND: 'rewinding_pass_2',
        HITL_REJECT: 'pipeline_failed',
      },
    },

    rewinding_pass_2: {
      invoke: {
        src: 'rewindToPassStart',
        input: ({ context }: { context: PipelineMachineContext }) => ({
          ctx: context.ctx,
          pass: 2 as PipelinePass,
        }),
        onDone: 'pass_2_test_generation',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    pass_3_core_implementation: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 3 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'selfCorrectionPass3',
        input: ({
          context,
        }: {
          context: PipelineMachineContext;
        }): SelfCorrectionMachineInput => ({
          ctx: context.ctx,
          pass: 3,
        }),
        onDone: 'committing',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    pass_4_refactor: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 4 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'selfCorrectionPass4',
        input: ({
          context,
        }: {
          context: PipelineMachineContext;
        }): SelfCorrectionMachineInput => ({
          ctx: context.ctx,
          pass: 4,
        }),
        onDone: 'committing',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    pass_5_observability: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 5 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'selfCorrectionPass5',
        input: ({
          context,
        }: {
          context: PipelineMachineContext;
        }): SelfCorrectionMachineInput => ({
          ctx: context.ctx,
          pass: 5,
        }),
        onDone: 'committing',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    pass_6_security: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 6 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'selfCorrectionPass6',
        input: ({
          context,
        }: {
          context: PipelineMachineContext;
        }): SelfCorrectionMachineInput => ({
          ctx: context.ctx,
          pass: 6,
        }),
        onDone: 'committing',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    pass_7_documentation: {
      entry: assign({
        ctx: ({ context }: { context: PipelineMachineContext }) => ({
          ...context.ctx,
          currentPass: 7 as PipelinePass,
          currentAttempt: 1,
        }),
      }),
      invoke: {
        src: 'selfCorrectionPass7',
        input: ({
          context,
        }: {
          context: PipelineMachineContext;
        }): SelfCorrectionMachineInput => ({
          ctx: context.ctx,
          pass: 7,
        }),
        onDone: 'committing',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    committing: {
      invoke: {
        src: 'doAtomicCommit',
        input: ({ context }: { context: PipelineMachineContext }) => ({
          ctx: context.ctx,
        }),
        onDone: 'evaluating_next_pass',
        onError: {
          target: 'pipeline_failed',
          actions: [
            {
              type: 'emitPipelineError',
              params: ({ event }: { event: { error: unknown } }) => ({
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              }),
            },
          ],
        },
      },
    },

    evaluating_next_pass: {
      always: [
        { guard: 'isPauseRequested', target: 'paused' },
        { guard: 'afterPass0', target: 'pass_1_contracts' },
        { guard: 'afterPass1', target: 'pass_2_test_generation' },
        { guard: 'afterPass2', target: 'pass_3_core_implementation' },
        { guard: 'afterPass3', target: 'pass_4_refactor' },
        { guard: 'afterPass4', target: 'pass_5_observability' },
        { guard: 'afterPass5', target: 'pass_6_security' },
        { guard: 'afterPass6', target: 'pass_7_documentation' },
        { guard: 'afterPass7', target: 'pipeline_complete' },
      ],
    },

    paused: {
      entry: [
        assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            pauseRequested: false,
          }),
        }),
        'emitPipelinePaused',
      ],
      on: {
        RESUME: {
          target: 'evaluating_next_pass',
          actions: 'emitPipelineResumed',
        },
      },
    },

    pipeline_complete: {
      type: 'final',
      entry: 'emitPipelineCompleted',
    },

    pipeline_failed: {
      type: 'final',
    },
  },
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPipelineMachine(services: {
  agentRunner: IAgentRunner;
  cmd: ICommandRunner;
  fs: IFileSystem;
  git: IGitService;
  events: IEventBus;
  logger: ILogger;
  stateStore?: IStateStore;
  symbolResolver?: ISymbolResolver;
  contextProvider: IContextProvider;
}) {
  const {
    agentRunner,
    cmd,
    fs,
    git,
    events,
    logger,
    stateStore,
    symbolResolver,
    contextProvider,
  } = services;
  const emit = makeEmit(events);

  function resolveFromRef(ctx: PipelineContext, pass: PipelinePass): string {
    if (pass === PipelinePass.Design) {
      return ctx.originalBaseSha ?? 'HEAD~1';
    }
    const prevPass = (pass - 1) as PipelinePass;
    return ctx.history[prevPass]?.commitHash ?? ctx.originalBaseSha ?? 'HEAD~1';
  }

  /**
   * Extract a short, non-empty snippet from *source* starting at *range.start*
   * (1-based). Used as a drift-resistant anchor for locating an edit in later
   * passes, since absolute line numbers shift when files are edited again.
   */
  function extractAnchor(source: string, range: Range): string | undefined {
    const start = Math.max(range.start - 1, 0);
    const slice = source.split('\n').slice(start, start + 5);
    const trimmed = slice
      .map((l) => l.replace(/\s+$/g, ''))
      .filter((l) => l.length > 0);
    return trimmed.length > 0 ? trimmed.join('\n') : undefined;
  }

  function recordPassOutcome(
    ctx: PipelineContext,
    pass: PipelinePass,
    status: PassHistory['status'],
    opts?: {
      filesTouched?: string[];
      targetSymbols?: TargetSymbols;
      lastError?: string;
    },
  ): void {
    const now = new Date().toISOString();
    const existing = ctx.history[pass];
    ctx.history[pass] = {
      status,
      filesTouched: opts?.filesTouched ?? existing?.filesTouched ?? [],
      attempts: ctx.currentAttempt ?? 1,
      lastError: opts?.lastError,
      commitHash: existing?.commitHash,
      targetSymbols: opts?.targetSymbols ?? existing?.targetSymbols,
      startedAt: existing?.startedAt ?? now,
      completedAt: status !== 'completed' ? undefined : now,
    };
  }

  return setup({
    types: {
      input: {} as PipelineMachineInput,
      context: {} as PipelineMachineContext,
    },

    actors: {
      runPass0: fromPromise<void, { ctx: PipelineContext }>(
        async ({ input }) => {
          const { ctx } = input;

          await fs.writeFile(ctx.designMmdPath, '');
          await fs.writeFile(ctx.specGherkinPath, '');

          ctx.currentPass = 0;
          ctx.currentAttempt = 1;
          emit('PASS_STARTED', 'Starting Pass 0', ctx);

          logger.info('Entering Pass 0 [Attempt 1]');
          const built = contextProvider.build(ctx, ctx.currentPass);
          const prompt = getAgentContextPayload(ctx, built);
          logger.info(
            { payload: { prompt: sanitizeLogPayload(prompt, 'info') } },
            'Dispatching prompt to Opencode',
          );

          const artefacts = await buildArtefacts(ctx, fs, built, undefined, logger);
          const request: AgentRunRequest = {
            pass: 0,
            prompt,
            artefacts,
            runId: ctx.runId,
          };
          await agentRunner.execute(request);

          const mmdContent = (await fs.readFile(ctx.designMmdPath)).trim();
          const gherkinContent = (await fs.readFile(ctx.specGherkinPath)).trim();
          if (mmdContent.length < 30) {
            throw new Error(
              'Design agent failed to produce a valid Mermaid design diagram (content length < 30).',
            );
          }
          if (gherkinContent.length < 30) {
            throw new Error(
              'Spec agent failed to produce a valid Gherkin specification (content length < 30).',
            );
          }

          emit('PASS_COMPLETED', 'Completed Pass 0', ctx);
        },
      ),

      runSimplePass: fromPromise<FileChange[], { ctx: PipelineContext }>(
        async ({ input }) => {
          const { ctx } = input;
          const pass = ctx.currentPass!;

          emit('PASS_STARTED', `Starting Pass ${pass}`, ctx);

          logger.info(`Entering Pass ${pass} [Attempt 1]`);
          const built = contextProvider.build(ctx, pass);
          const prompt = getAgentContextPayload(ctx, built);
          logger.info(
            { payload: { prompt: sanitizeLogPayload(prompt, 'info') } },
            'Dispatching prompt to Opencode',
          );

          const artefacts = await buildArtefacts(ctx, fs, built, undefined, logger);
          const request: AgentRunRequest = {
            pass,
            prompt,
            artefacts,
            runId: ctx.runId,
          };
          const runResult = await agentRunner.execute(request);

          const skip = parseSkipSignal(runResult.output);
          if (skip) {
            logger.info(`Agent returned skip signal for Pass ${pass}: ${skip.reason}`);
            recordPassOutcome(ctx, pass, 'skipped');
            const historyEntry = ctx.history[pass];
            if (historyEntry) {
              historyEntry.skipReason = skip.reason;
            }
            emit('PASS_COMPLETED', `Completed Pass ${pass} (Skipped)`, ctx, { files: [] });
            return [];
          }

          const changes = await git.getPendingChanges();
          const payload: PassCompletedPayload = { files: changes };
          emit('PASS_COMPLETED', `Completed Pass ${pass}`, ctx, payload);
          return changes;
        },
      ),

      prepareHitl: fromPromise<
        { pass: PipelinePass; files: FileChange[] },
        { pass: PipelinePass }
      >(async ({ input }) => {
        const files = await git.getPendingChanges();
        return { pass: input.pass, files };
      }),

      rewindToPassStart: fromPromise<
        void,
        { ctx: PipelineContext; pass: PipelinePass }
      >(async ({ input }) => {
        const { ctx, pass } = input;
        const targetSha: string | undefined =
          pass === 0
            ? ctx.originalBaseSha
            : ctx.history[(pass - 1) as PipelinePass]?.commitHash;
        if (!targetSha) {
          throw new Error(
            `Cannot rewind Pass ${pass}: no previous commit SHA available. ` +
              `Ensure the previous pass completed successfully.`,
          );
        }
        await git.abortToSha(targetSha);
        await git.resetWorkingTree();
      }),

      doAtomicCommit: fromPromise<void, { ctx: PipelineContext }>(
        async ({ input }) => {
          const { ctx } = input;
          const pass = ctx.currentPass!;
          if (!GIT_COMMIT_PASSES.has(pass)) return;

          const historyEntry = ctx.history[pass];
          if (historyEntry?.status === 'skipped') {
            emit('COMMIT_CAPTURED', `Captured change metadata for Pass ${pass} (Skipped)`, ctx, {
              files: [],
              targetSymbols: {},
              fileChanges: {},
              attempts: ctx.currentAttempt,
            } satisfies PassCompletedPayload);
            return;
          }

          const fromRef = resolveFromRef(ctx, pass);
          const files = await git.getPendingChanges();
          const filesTouched = files.map((c) => c.file);

          if (files.length === 0) {
            logger.warn(`Pass ${pass} produced no changes without a skip signal; recording as implicit skip`);
            recordPassOutcome(ctx, pass, 'skipped');
            if (ctx.history[pass]) {
              ctx.history[pass]!.skipReason = 'Implicit skip (no files changed)';
            }
            emit('COMMIT_CAPTURED', `Captured change metadata for Pass ${pass} (Implicit Skip)`, ctx, {
              files: [],
              targetSymbols: {},
              fileChanges: {},
              attempts: ctx.currentAttempt,
            } satisfies PassCompletedPayload);
            if (stateStore) {
              await stateStore.save(ctx);
            }
            return;
          }

          recordPassOutcome(ctx, pass, 'completed', { filesTouched });

          const stagePaths: string[] = ['.'];
          if (stateStore) {
            stagePaths.push(stateStore.path);
          }

          const commitResult = await git.commit(
            stagePaths,
            `chore(ai): completed Pass ${pass} -- ${PASS_LABELS[pass]} - ${ctx.featureName}`,
          );

          const headHash = await git.getCurrentCommitSha();
          const entry = ctx.history[pass];
          if (entry) {
            entry.commitHash = headHash;
          }

          if (
            pass === PipelinePass.Documentation &&
            (commitResult.kind === 'committed' || commitResult.kind === 'add_warning')
          ) {
            await git.tag(`Completed - ${ctx.featureName}`);
          }

          // Always persist defined (possibly empty) descriptors so the state
          // file distinguishes "WRITER ran, nothing targeted" from "not run".
          let targetSymbols: TargetSymbols = {};
          let fileChanges: FileChanges = {};

          if (symbolResolver) {
            try {
              const toRef = headHash;
              const diffChanges = await git.getDiffLineRanges(fromRef, toRef);
              const pendingByFile = new Map(
                files.map((c) => [c.file, c.status] as const),
              );

              for (const change of diffChanges) {
                const fileKind: FileChangeRecord['kind'] =
                  pendingByFile.get(change.file) === 'A'
                    ? 'new-file'
                    : 'edited-file';
                const record: FileChangeRecord = {
                  commitHash: headHash,
                  kind: fileKind,
                  hunks: [],
                };

                if (change.hunks.length > 0) {
                  try {
                    const source = await fs.readFile(change.file);
                    for (const hunk of change.hunks) {
                      const symbols = symbolResolver.mapRangesToSymbols(
                        change.file,
                        source,
                        [hunk.range],
                      );
                      record.hunks.push({
                        ...hunk,
                        symbols,
                        anchor: extractAnchor(source, hunk.range),
                      });
                      if (symbols.length > 0) {
                        const existing = targetSymbols[change.file] ?? [];
                        targetSymbols[change.file] = [
                          ...new Set([...existing, ...symbols]),
                        ].sort();
                      }
                    }
                  } catch {
                    // File read failed — non-fatal degradation
                  }
                }

                if (record.hunks.length > 0) {
                  fileChanges[change.file] = record;
                }
              }
            } catch {
              // Symbol resolution failed — non-fatal degradation (AD-9)
            }
          }

          const finalHistoryEntry = ctx.history[pass];
          if (finalHistoryEntry) {
            finalHistoryEntry.targetSymbols = targetSymbols;
            finalHistoryEntry.fileChanges = fileChanges;
          }

          emit('COMMIT_CAPTURED', `Captured change metadata for Pass ${pass}`, ctx, {
            files,
            targetSymbols,
            fileChanges,
            attempts: ctx.currentAttempt,
          } satisfies PassCompletedPayload);

          if (stateStore) {
            await stateStore.save(ctx);
          }
        },
      ),

      selfCorrectionPass3: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 3 }),
        contextProvider,
      }),

      selfCorrectionPass4: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 4 }),
        contextProvider,
      }),

      selfCorrectionPass5: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 5 }),
        contextProvider,
      }),

      selfCorrectionPass6: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 6 }),
        contextProvider,
      }),

      selfCorrectionPass7: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 7 }),
        contextProvider,
      }),
    },

    actions: {
      emitPipelineStarted: ({
        context,
      }: {
        context: PipelineMachineContext;
      }) => {
        emit(
          'PIPELINE_STARTED',
          `Starting pipeline v${context.ctx.pipelineVersion}`,
          context.ctx,
        );
      },

      emitPipelineCompleted: ({
        context,
      }: {
        context: PipelineMachineContext;
      }) => {
        emit(
          'PIPELINE_COMPLETED',
          'All 8 passes completed successfully.',
          context.ctx,
        );
      },

      emitPipelineError: (
        { context }: { context: PipelineMachineContext },
        params: { error: string },
      ) => {
        emit('ERROR', params.error, context.ctx);
      },

      emitHitlRequired: (
        { context }: { context: PipelineMachineContext },
        params: { pass: PipelinePass; files: FileChange[] },
      ) => {
        emit(
          'HITL_REQUIRED',
          `Review generated artefacts for Pass ${params.pass} before proceeding.`,
          context.ctx,
          { files: params.files } satisfies HitlPayload,
        );
      },

      emitPipelinePaused: ({
        context,
      }: {
        context: PipelineMachineContext;
      }) => {
        emit(
          'PIPELINE_PAUSED',
          'Pipeline paused at inter-pass boundary. Run with --resume to continue.',
          context.ctx,
        );
      },

      emitPipelineResumed: ({
        context,
      }: {
        context: PipelineMachineContext;
      }) => {
        emit(
          'PIPELINE_RESUMED',
          'Pipeline resumed from paused state.',
          context.ctx,
        );
      },
    },

    guards: {
      atPass0: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 0,

      atPass1: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 1,

      atPass2: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 2,

      atPass3: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 3,

      atPass4: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 4,

      atPass5: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 5,

      atPass6: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 6,

      atPass7: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 7,

      skipHitl: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.skipHitl,

      isPauseRequested: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.pauseRequested === true,

      afterPass0: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 0,

      afterPass1: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 1,

      afterPass2: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 2,

      afterPass3: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 3,

      afterPass4: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 4,

      afterPass5: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 5,

      afterPass6: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 6,

      afterPass7: ({ context }: { context: PipelineMachineContext }) =>
        context.ctx.currentPass === 7,
    },
  }).createMachine({
    id: 'pipeline',
    context: ({ input }) => ({
      ctx: {
        ...input.ctx,
        currentPass: input.startPass,
        currentAttempt: 1,
      },
    }),
    initial: '__begin',
    entry: 'emitPipelineStarted',
    on: {
      PAUSE: {
        actions: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            pauseRequested: true,
          }),
        }),
      },
    },
    states: {
      __begin: {
        always: [
          { guard: 'atPass0', target: 'pass_0_design' },
          { guard: 'atPass1', target: 'pass_1_contracts' },
          { guard: 'atPass2', target: 'pass_2_test_generation' },
          { guard: 'atPass3', target: 'pass_3_core_implementation' },
          { guard: 'atPass4', target: 'pass_4_refactor' },
          { guard: 'atPass5', target: 'pass_5_observability' },
          { guard: 'atPass6', target: 'pass_6_security' },
          { guard: 'atPass7', target: 'pass_7_documentation' },
        ],
      },

      pass_0_design: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 0 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'runPass0',
          input: ({ context }: { context: PipelineMachineContext }) => ({
            ctx: context.ctx,
          }),
          onDone: [
            { guard: 'skipHitl', target: 'committing' },
            { target: 'preparing_hitl_pass_0' },
          ],
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      preparing_hitl_pass_0: {
        invoke: {
          src: 'prepareHitl',
          input: () => ({ pass: 0 as PipelinePass }),
          onDone: {
            target: 'awaiting_hitl_pass_0',
            actions: [
              {
                type: 'emitHitlRequired',
                params: ({ event }: { event: { output: { pass: PipelinePass; files: FileChange[] } } }) => ({
                  pass: event.output.pass,
                  files: event.output.files,
                }),
              },
            ],
          },
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      awaiting_hitl_pass_0: {
        on: {
          HITL_APPROVE: 'committing',
          HITL_REWIND: 'rewinding_pass_0',
          HITL_REJECT: 'pipeline_failed',
        },
      },

      rewinding_pass_0: {
        invoke: {
          src: 'rewindToPassStart',
          input: ({ context }: { context: PipelineMachineContext }) => ({
            ctx: context.ctx,
            pass: 0 as PipelinePass,
          }),
          onDone: 'pass_0_design',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      pass_1_contracts: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 1 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'runSimplePass',
          input: ({ context }: { context: PipelineMachineContext }) => ({
            ctx: context.ctx,
          }),
          onDone: 'committing',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      pass_2_test_generation: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 2 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'runSimplePass',
          input: ({ context }: { context: PipelineMachineContext }) => ({
            ctx: context.ctx,
          }),
          onDone: [
            { guard: 'skipHitl', target: 'committing' },
            { target: 'preparing_hitl_pass_2' },
          ],
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      preparing_hitl_pass_2: {
        invoke: {
          src: 'prepareHitl',
          input: () => ({ pass: 2 as PipelinePass }),
          onDone: {
            target: 'awaiting_hitl_pass_2',
            actions: [
              {
                type: 'emitHitlRequired',
                params: ({ event }: { event: { output: { pass: PipelinePass; files: FileChange[] } } }) => ({
                  pass: event.output.pass,
                  files: event.output.files,
                }),
              },
            ],
          },
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      awaiting_hitl_pass_2: {
        on: {
          HITL_APPROVE: 'committing',
          HITL_REWIND: 'rewinding_pass_2',
          HITL_REJECT: 'pipeline_failed',
        },
      },

      rewinding_pass_2: {
        invoke: {
          src: 'rewindToPassStart',
          input: ({ context }: { context: PipelineMachineContext }) => ({
            ctx: context.ctx,
            pass: 2 as PipelinePass,
          }),
          onDone: 'pass_2_test_generation',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      pass_3_core_implementation: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 3 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'selfCorrectionPass3',
          input: ({
            context,
          }: {
            context: PipelineMachineContext;
          }): SelfCorrectionMachineInput => ({
            ctx: context.ctx,
            pass: 3,
          }),
          onDone: 'committing',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      pass_4_refactor: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 4 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'selfCorrectionPass4',
          input: ({
            context,
          }: {
            context: PipelineMachineContext;
          }): SelfCorrectionMachineInput => ({
            ctx: context.ctx,
            pass: 4,
          }),
          onDone: 'committing',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      pass_5_observability: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 5 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'selfCorrectionPass5',
          input: ({
            context,
          }: {
            context: PipelineMachineContext;
          }): SelfCorrectionMachineInput => ({
            ctx: context.ctx,
            pass: 5,
          }),
          onDone: 'committing',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      pass_6_security: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 6 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'selfCorrectionPass6',
          input: ({
            context,
          }: {
            context: PipelineMachineContext;
          }): SelfCorrectionMachineInput => ({
            ctx: context.ctx,
            pass: 6,
          }),
          onDone: 'committing',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      pass_7_documentation: {
        entry: assign({
          ctx: ({ context }: { context: PipelineMachineContext }) => ({
            ...context.ctx,
            currentPass: 7 as PipelinePass,
            currentAttempt: 1,
          }),
        }),
        invoke: {
          src: 'selfCorrectionPass7',
          input: ({
            context,
          }: {
            context: PipelineMachineContext;
          }): SelfCorrectionMachineInput => ({
            ctx: context.ctx,
            pass: 7,
          }),
          onDone: 'committing',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      committing: {
        invoke: {
          src: 'doAtomicCommit',
          input: ({ context }: { context: PipelineMachineContext }) => ({
            ctx: context.ctx,
          }),
          onDone: 'evaluating_next_pass',
          onError: {
            target: 'pipeline_failed',
            actions: [
              {
                type: 'emitPipelineError',
                params: ({ event }: { event: { error: unknown } }) => ({
                  error:
                    event.error instanceof Error
                      ? event.error.message
                      : String(event.error),
                }),
              },
            ],
          },
        },
      },

      evaluating_next_pass: {
        always: [
          { guard: 'isPauseRequested', target: 'paused' },
          { guard: 'afterPass0', target: 'pass_1_contracts' },
          { guard: 'afterPass1', target: 'pass_2_test_generation' },
          { guard: 'afterPass2', target: 'pass_3_core_implementation' },
          { guard: 'afterPass3', target: 'pass_4_refactor' },
          { guard: 'afterPass4', target: 'pass_5_observability' },
          { guard: 'afterPass5', target: 'pass_6_security' },
          { guard: 'afterPass6', target: 'pass_7_documentation' },
          { guard: 'afterPass7', target: 'pipeline_complete' },
        ],
      },

      paused: {
        entry: [
          assign({
            ctx: ({ context }: { context: PipelineMachineContext }) => ({
              ...context.ctx,
              pauseRequested: false,
            }),
          }),
          'emitPipelinePaused',
        ],
        on: {
          RESUME: {
            target: 'evaluating_next_pass',
            actions: 'emitPipelineResumed',
          },
        },
      },

      pipeline_complete: {
        type: 'final',
        entry: 'emitPipelineCompleted',
      },

      pipeline_failed: {
        type: 'final',
        entry: ({ context }: { context: PipelineMachineContext }) => {
          const pass = context.ctx.currentPass;
          if (pass !== undefined) {
            recordPassOutcome(context.ctx, pass, 'failed');
            if (stateStore) {
              stateStore.save(context.ctx).catch(() => {});
            }
          }
        },
      },
    },
  });
}
