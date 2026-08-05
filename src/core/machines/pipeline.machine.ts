import { setup, fromPromise, assign } from 'xstate';

import type {
  PipelineContext,
  PipelinePass,
  AgenticEvent,
  AgentRunRequest,
  FileChange,
  HitlPayload,
  PassCompletedPayload,
} from '../types.js';
import {
  PASS_LABELS,
  GIT_COMMIT_PASSES,
} from '../types.js';
import type {
  IAgentRunner,
  ICommandRunner,
  IFileSystem,
  IGitService,
  IEventBus,
  ILogger,
  IStateStore,
} from '../interfaces.js';
import { getAgentContextPayload } from '../runners/shared.js';
import { buildArtefacts } from '../runners/shared.js';
import { sanitizeLogPayload } from '../log-sanitizer.js';

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
}) {
  const {
    agentRunner,
    cmd,
    fs,
    git,
    events,
    logger,
    stateStore,
  } = services;
  const emit = makeEmit(events);

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
          const prompt = getAgentContextPayload(ctx);
          logger.info(
            { payload: { prompt: sanitizeLogPayload(prompt, 'info') } },
            'Dispatching prompt to Opencode',
          );

          const artefacts = await buildArtefacts(ctx, fs, undefined, logger);
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
          const prompt = getAgentContextPayload(ctx);
          logger.info(
            { payload: { prompt: sanitizeLogPayload(prompt, 'info') } },
            'Dispatching prompt to Opencode',
          );

          const artefacts = await buildArtefacts(ctx, fs, undefined, logger);
          const request: AgentRunRequest = {
            pass,
            prompt,
            artefacts,
            runId: ctx.runId,
          };
          await agentRunner.execute(request);

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

          const files = await git.getPendingChanges();
          const filesTouched = files.map((c) => c.file);

          const existing = ctx.history[pass];
          ctx.history[pass] = {
            status: 'completed',
            filesTouched,
            attempts: ctx.currentAttempt ?? 1,
            commitHash: existing?.commitHash,
          };

          const stagePaths: string[] = ['.'];
          if (stateStore) {
            stagePaths.push(stateStore.path);
          }

          await git.commit(
            stagePaths,
            `chore(ai): completed Pass ${pass} -- ${PASS_LABELS[pass]}`,
          );

          if (stateStore) {
            const headHash = await git.getCurrentCommitSha();
            const entry = ctx.history[pass];
            if (entry) {
              entry.commitHash = headHash;
            }
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
      }),

      selfCorrectionPass4: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 4 }),
      }),

      selfCorrectionPass5: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 5 }),
      }),

      selfCorrectionPass6: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 6 }),
      }),

      selfCorrectionPass7: createSelfCorrectionMachine({
        agentRunner,
        cmd,
        fs,
        git,
        events,
        logger: logger.child({ passId: 7 }),
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
            { guard: 'skipHitl', target: 'pass_1_contracts' },
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
          HITL_APPROVE: 'pass_1_contracts',
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
}
