import { randomUUID } from 'node:crypto';
import { createActor, type Snapshot } from 'xstate';

import type { IGitService, IFileSystem, ICommandRunner, IAgentRunner, IEventBus, ILogger, IStateStore, PipelineConfig } from './interfaces.js';
import type { PipelineContext, FileChange } from './types.js';
import { PipelinePass } from './types.js';

import { createPipelineMachine } from './machines/pipeline.machine.js';

// ---------------------------------------------------------------------------
// PipelineOrchestrator — DI wrapper over the XState v5 pipeline actor
// ---------------------------------------------------------------------------

export type HitlHandler = (pass?: PipelinePass, files?: FileChange[]) => Promise<void>;

export class PipelineOrchestrator {
  readonly #git: IGitService;
  readonly #fs: IFileSystem;
  readonly #cmd: ICommandRunner;
  readonly #agentRunner: IAgentRunner;
  readonly #events: IEventBus;
  readonly #logger: ILogger;
  readonly #config: PipelineConfig;
  readonly #stateStore: IStateStore | undefined;
  readonly #onHitl: HitlHandler;

  constructor(
    git: IGitService,
    fs: IFileSystem,
    cmd: ICommandRunner,
    agentRunner: IAgentRunner,
    events: IEventBus,
    logger: ILogger,
    config: PipelineConfig,
    stateStore?: IStateStore,
    onHitl: HitlHandler = () => Promise.resolve(),
  ) {
    this.#git = git;
    this.#fs = fs;
    this.#cmd = cmd;
    this.#agentRunner = agentRunner;
    this.#events = events;
    this.#logger = logger;
    this.#config = config;
    this.#stateStore = stateStore;
    this.#onHitl = onHitl;
  }

  // -- Public entry point ----------------------------------------------------

  async run(ctx: PipelineContext, startPass: PipelinePass = PipelinePass.Design): Promise<boolean> {
    ctx.runId = randomUUID();
    ctx.history = ctx.history ?? {};

    if (await this.#fs.exists(ctx.errorLogPath)) {
      await this.#fs.deleteFile(ctx.errorLogPath);
    }

    const machine = createPipelineMachine({
      agentRunner: this.#agentRunner,
      cmd: this.#cmd,
      fs: this.#fs,
      git: this.#git,
      events: this.#events,
      logger: this.#logger,
      stateStore: this.#stateStore,
      onHitl: this.#onHitl,
    });

    let lastErrorMessage: string | undefined;
    const unsubscribeError = this.#events.on('ERROR', (event) => {
      lastErrorMessage = event.message;
    });

    const actor = ctx.xstateSnapshot
      ? createActor(machine, {
          snapshot: ctx.xstateSnapshot as unknown as Snapshot<typeof machine>,
          input: { ctx, startPass },
        })
      : createActor(machine, { input: { ctx, startPass } });

    return new Promise<boolean>((resolve, reject) => {
      actor.subscribe((snapshot) => {
        ctx.xstateSnapshot = actor.getPersistedSnapshot() as unknown as Record<string, unknown>;

        if (snapshot.status === 'done') {
          unsubscribeError();

          if (snapshot.matches('pipeline_complete')) {
            void this.#stateStore?.save(ctx);
            resolve(true);
          } else {
            const pass = ctx.currentPass;
            if (pass !== undefined) {
              const existing = ctx.history[pass];
              ctx.history[pass] = {
                status: 'failed',
                filesTouched: [],
                attempts: ctx.currentAttempt ?? 1,
                commitHash: existing?.commitHash,
                lastError: lastErrorMessage,
              };
            }
            void this.#stateStore?.save(ctx);
            reject(new Error(lastErrorMessage ?? 'Pipeline failed'));
          }
        }
      });

      actor.start();
    });
  }
}
