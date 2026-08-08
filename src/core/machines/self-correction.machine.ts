import { setup, fromPromise, assign } from 'xstate';
import type { ActorLogic } from 'xstate';

import type {
  PipelineContext,
  PipelinePass,
  AgenticEvent,
  AgentRunRequest,
  TestRunResult,
  PassCompletedPayload,
} from '../types.js';
import {
  PASS_LABELS,
} from '../types.js';
import type {
  IAgentRunner,
  ICommandRunner,
  IFileSystem,
  IGitService,
  IEventBus,
  ILogger,
} from '../interfaces.js';
import { getAgentContextPayload } from '../runners/shared.js';
import { buildArtefacts } from '../runners/shared.js';
import { sanitizeLogPayload } from '../log-sanitizer.js';

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

function notWired(name: string): ActorLogic<any, any> {
  return fromPromise(async () => {
    throw new Error(`Actor "${name}" was not wired via .provide()`);
  });
}

// ---------------------------------------------------------------------------
// Machine context & input
// ---------------------------------------------------------------------------

export interface SelfCorrectionMachineContext {
  ctx: PipelineContext;
  attempt: number;
  _testResult?: TestRunResult;
}

export interface SelfCorrectionMachineInput {
  ctx: PipelineContext;
  pass: PipelinePass;
}

// ---------------------------------------------------------------------------
// Module-level visualisation config (Stately-parsable, stubs only)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const selfCorrectionMachineConfig: any = setup({
  types: {
    input: {} as SelfCorrectionMachineInput,
    context: {} as SelfCorrectionMachineContext,
  },
  actors: {
    dispatchAgent:       notWired('dispatchAgent'),
    runTests:            notWired('runTests'),
    writeErrorLog:       notWired('writeErrorLog'),
    cleanupAfterSuccess: notWired('cleanupAfterSuccess'),
  },
  actions: {
    emitAgentError: () => {},
    emitTestsExhausted: () => {},
    incrementAttempt: assign({
      attempt: ({ context }: { context: SelfCorrectionMachineContext }) =>
        context.attempt + 1,
    }),
    storeTestResult: assign({
      _testResult: ({ event }: { event: unknown }) => {
        const doneEvent = event as { output: TestRunResult };
        return doneEvent.output;
      },
    }),
  },
  guards: {
    testsPassed: ({ context }: { context: SelfCorrectionMachineContext }) =>
      context._testResult?.passed === true,

    canRetry: ({ context }: { context: SelfCorrectionMachineContext }) =>
      context.attempt < context.ctx.maxCorrectionRetries + 1,
  },
}).createMachine({
  id: 'selfCorrection',
  context: ({ input }) => ({
    ctx: input.ctx,
    attempt: 1,
    _testResult: undefined as TestRunResult | undefined,
  }),
  initial: 'dispatching_agent',
  states: {
    dispatching_agent: {
      invoke: {
        src: 'dispatchAgent',
        input: ({
          context,
        }: {
          context: SelfCorrectionMachineContext;
        }) => ({
          ctx: context.ctx,
          pass: context.ctx.currentPass!,
          attempt: context.attempt,
        }),
        onDone: 'running_tests',
        onError: {
          target: 'failed',
          actions: [
            {
              type: 'emitAgentError',
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

    running_tests: {
      invoke: {
        src: 'runTests',
        input: ({
          context,
        }: {
          context: SelfCorrectionMachineContext;
        }) => ({
          testCmd: context.ctx.testCmd,
          pass: context.ctx.currentPass!,
          attempt: context.attempt,
          maxRetries: context.ctx.maxCorrectionRetries,
          ctx: context.ctx,
        }),
        onDone: {
          target: 'evaluating',
          actions: 'storeTestResult',
        },
        onError: {
          target: 'failed',
          actions: [
            {
              type: 'emitAgentError',
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

    evaluating: {
      always: [
        {
          guard: 'testsPassed',
          target: 'success',
        },
        {
          guard: 'canRetry',
          target: 'writing_error_log',
        },
        {
          target: 'failed',
          actions: 'emitTestsExhausted',
        },
      ],
    },

    writing_error_log: {
      invoke: {
        src: 'writeErrorLog',
        input: ({
          context,
        }: {
          context: SelfCorrectionMachineContext;
        }) => ({
          errorLogPath: context.ctx.errorLogPath,
          output: context._testResult?.output ?? '',
        }),
        onDone: {
          target: 'dispatching_agent',
          actions: 'incrementAttempt',
        },
        onError: {
          target: 'failed',
          actions: [
            {
              type: 'emitAgentError',
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

    success: {
      invoke: {
        src: 'cleanupAfterSuccess',
        input: ({
          context,
        }: {
          context: SelfCorrectionMachineContext;
        }) => ({
          ctx: context.ctx,
          errorLogPath: context.ctx.errorLogPath,
          attempt: context.attempt,
        }),
        onDone: 'done',
        onError: {
          target: 'failed',
          actions: [
            {
              type: 'emitAgentError',
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

    done: {
      type: 'final',
    },

    failed: {
      entry: ({ context }: { context: SelfCorrectionMachineContext }) => {
        const pass = context.ctx.currentPass;
        const label = pass !== undefined ? PASS_LABELS[pass] : 'Unknown';
        const attempt = context.attempt;
        throw new Error(
          `Pass ${pass} (${label}) FAILED after ${attempt} attempt(s).`,
        );
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSelfCorrectionMachine(services: {
  agentRunner: IAgentRunner;
  cmd: ICommandRunner;
  fs: IFileSystem;
  git: IGitService;
  events: IEventBus;
  logger: ILogger;
}) {
  const { agentRunner, cmd, fs, git, events, logger } = services;
  const emit = makeEmit(events);

  return setup({
    types: {
      input: {} as SelfCorrectionMachineInput,
      context: {} as SelfCorrectionMachineContext,
    },
    actors: {
      dispatchAgent: fromPromise<void, {
        ctx: PipelineContext;
        pass: PipelinePass;
        attempt: number;
      }>(async ({ input }) => {
          const { ctx, pass, attempt } = input;
          const isFirstAttempt = attempt === 1;

          if (isFirstAttempt) {
            emit('PASS_STARTED', `Starting Pass ${pass}`, ctx);
          } else {
            emit(
              'SELF_CORRECTION_ATTEMPTED',
              `Self-correction cycle ${attempt - 1}/${ctx.maxCorrectionRetries} — error log written to ${ctx.errorLogPath}`,
              ctx,
              { attempt: attempt - 1, maxRetries: ctx.maxCorrectionRetries },
            );
          }

          const prompt = isFirstAttempt
            ? getAgentContextPayload(ctx)
            : getAgentContextPayload(ctx, { attemptNumber: attempt });

          const artefacts = isFirstAttempt
            ? await buildArtefacts(ctx, fs)
            : await buildArtefacts(ctx, fs, ctx.errorLogPath);

          logger.info(`Entering Pass ${pass} [Attempt ${attempt}]`);
          logger.info(
            { payload: { prompt: sanitizeLogPayload(prompt, 'info') } },
            'Dispatching prompt to agent',
          );

          const request: AgentRunRequest = {
            pass,
            prompt,
            artefacts,
            runId: ctx.runId,
          };
          await agentRunner.execute(request);
        },
      ),

      runTests: fromPromise<TestRunResult, {
        testCmd: string[];
        pass: PipelinePass;
        attempt: number;
        maxRetries: number;
        ctx: PipelineContext;
      }>(async ({ input }) => {
          const { testCmd, pass, attempt, maxRetries, ctx } = input;
          const totalAttempts = maxRetries + 1;

          emit(
            'TEST_RUN_STARTED',
            `Running tests — attempt ${attempt}/${totalAttempts}`,
            ctx,
          );

          const result = await cmd.runTests(testCmd);

          if (result.passed) {
            emit(
              'TEST_RUN_COMPLETED',
              `Tests passed on attempt ${attempt}/${totalAttempts}`,
              ctx,
            );
          } else {
            emit(
              'TEST_RUN_FAILED',
              `Tests failed (attempt ${attempt}/${totalAttempts}) — ${result.output.slice(0, 200)}`,
              ctx,
              { output: result.output },
            );
          }

          return result;
        },
      ),

      writeErrorLog: fromPromise<void, { errorLogPath: string; output: string }>(
        async ({ input }) => {
          await fs.writeFile(input.errorLogPath, input.output);
        },
      ),

      cleanupAfterSuccess: fromPromise<void, {
        ctx: PipelineContext;
        errorLogPath: string;
        attempt: number;
      }>(async ({ input }) => {
          const { ctx, errorLogPath, attempt } = input;

          if (await fs.exists(errorLogPath)) {
            await fs.deleteFile(errorLogPath);
          }

          const changes = await git.getPendingChanges();
          const payload: PassCompletedPayload = {
            files: changes,
            attempts: attempt,
          };
          emit('PASS_COMPLETED', `Completed Pass ${ctx.currentPass}`, ctx, payload);
        },
      ),
    },

    actions: {
      emitAgentError: (
        { context }: { context: SelfCorrectionMachineContext },
        params: { error: string },
      ) => {
        emit('ERROR', params.error || 'Agent execution failed', context.ctx);
      },

      emitTestsExhausted: ({
        context,
      }: {
        context: SelfCorrectionMachineContext;
      }) => {
        const { ctx, attempt } = context;
        const totalAttempts = ctx.maxCorrectionRetries + 1;
        emit(
          'ERROR',
          `Pass ${ctx.currentPass} (${PASS_LABELS[ctx.currentPass!]}) FAILED after ${totalAttempts} attempt(s). The test suite still fails after ${ctx.maxCorrectionRetries} self-correction retries.`,
          ctx,
        );
      },

      incrementAttempt: assign({
        attempt: ({ context }: { context: SelfCorrectionMachineContext }) =>
          context.attempt + 1,
      }),

      storeTestResult: assign({
        _testResult: ({
          event,
        }: {
          event: unknown;
        }) => {
          const doneEvent = event as { output: TestRunResult };
          return doneEvent.output;
        },
      }),
    },

    guards: {
      testsPassed: ({ context }: { context: SelfCorrectionMachineContext }) =>
        context._testResult?.passed === true,

      canRetry: ({ context }: { context: SelfCorrectionMachineContext }) =>
        context.attempt < context.ctx.maxCorrectionRetries + 1,
    },
  }).createMachine({
    id: 'selfCorrection',
    context: ({ input }) => ({
      ctx: input.ctx,
      attempt: 1,
      _testResult: undefined as TestRunResult | undefined,
    }),
    initial: 'dispatching_agent',
    states: {
      dispatching_agent: {
        invoke: {
          src: 'dispatchAgent',
          input: ({
            context,
          }: {
            context: SelfCorrectionMachineContext;
          }) => ({
            ctx: context.ctx,
            pass: context.ctx.currentPass!,
            attempt: context.attempt,
          }),
          onDone: 'running_tests',
          onError: {
            target: 'failed',
            actions: [
              {
                type: 'emitAgentError',
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

      running_tests: {
        invoke: {
          src: 'runTests',
          input: ({
            context,
          }: {
            context: SelfCorrectionMachineContext;
          }) => ({
            testCmd: context.ctx.testCmd,
            pass: context.ctx.currentPass!,
            attempt: context.attempt,
            maxRetries: context.ctx.maxCorrectionRetries,
            ctx: context.ctx,
          }),
          onDone: {
            target: 'evaluating',
            actions: 'storeTestResult',
          },
          onError: {
            target: 'failed',
            actions: [
              {
                type: 'emitAgentError',
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

      evaluating: {
        always: [
          {
            guard: 'testsPassed',
            target: 'success',
          },
          {
            guard: 'canRetry',
            target: 'writing_error_log',
          },
          {
            target: 'failed',
            actions: 'emitTestsExhausted',
          },
        ],
      },

      writing_error_log: {
        invoke: {
          src: 'writeErrorLog',
          input: ({
            context,
          }: {
            context: SelfCorrectionMachineContext;
          }) => ({
            errorLogPath: context.ctx.errorLogPath,
            output: context._testResult?.output ?? '',
          }),
          onDone: {
            target: 'dispatching_agent',
            actions: 'incrementAttempt',
          },
          onError: {
            target: 'failed',
            actions: [
              {
                type: 'emitAgentError',
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

      success: {
        invoke: {
          src: 'cleanupAfterSuccess',
          input: ({
            context,
          }: {
            context: SelfCorrectionMachineContext;
          }) => ({
            ctx: context.ctx,
            errorLogPath: context.ctx.errorLogPath,
            attempt: context.attempt,
          }),
          onDone: 'done',
          onError: {
            target: 'failed',
            actions: [
              {
                type: 'emitAgentError',
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

      done: {
        type: 'final',
      },

      failed: {
        entry: ({ context }: { context: SelfCorrectionMachineContext }) => {
          const pass = context.ctx.currentPass;
          const label = pass !== undefined ? PASS_LABELS[pass] : 'Unknown';
          const attempt = context.attempt;
          throw new Error(
            `Pass ${pass} (${label}) FAILED after ${attempt} attempt(s).`,
          );
        },
      },
    },
  });
}
