import { randomUUID } from 'node:crypto';
import { createActor, waitFor, type Snapshot } from 'xstate';

import type { IGitService, IFileSystem, ICommandRunner, IAgentRunner, IEventBus, ILogger, IStateStore, PipelineConfig, IContextProvider, ISymbolResolver } from './interfaces.js';
import type { PipelineContext, FileChange, HitlAction } from './types.js';
import { PipelinePass } from './types.js';

import { createPipelineMachine } from './machines/pipeline.machine.js';

// ---------------------------------------------------------------------------
// PipelineOrchestrator — DI wrapper over the XState v5 pipeline actor
// ---------------------------------------------------------------------------

export type HitlHandler = (pass?: PipelinePass, files?: FileChange[]) => Promise<HitlAction>;

const HITL_EVENT_MAP: Record<HitlAction, 'HITL_APPROVE' | 'HITL_REJECT' | 'HITL_REWIND'> = {
  APPROVE: 'HITL_APPROVE',
  REJECT: 'HITL_REJECT',
  REWIND: 'HITL_REWIND',
};

export class PipelineOrchestrator {
  readonly #git: IGitService;
  readonly #fs: IFileSystem;
  readonly #cmd: ICommandRunner;
  readonly #agentRunner: IAgentRunner;
  readonly #events: IEventBus;
  readonly #logger: ILogger;
  readonly #config: PipelineConfig;
  readonly #stateStore: IStateStore | undefined;
  readonly #contextProvider: IContextProvider;
  readonly #symbolResolver: ISymbolResolver | undefined;
  readonly #onHitl: HitlHandler;
  #actor: ReturnType<typeof createActor> | undefined;
  #currentCtx: PipelineContext | undefined;

  constructor(
    git: IGitService,
    fs: IFileSystem,
    cmd: ICommandRunner,
    agentRunner: IAgentRunner,
    events: IEventBus,
    logger: ILogger,
    config: PipelineConfig,
    contextProvider: IContextProvider,
    symbolResolver?: ISymbolResolver,
    stateStore?: IStateStore,
    onHitl: HitlHandler = () => Promise.resolve('APPROVE'),
  ) {
    this.#git = git;
    this.#fs = fs;
    this.#cmd = cmd;
    this.#agentRunner = agentRunner;
    this.#events = events;
    this.#logger = logger;
    this.#config = config;
    this.#stateStore = stateStore;
    this.#contextProvider = contextProvider;
    this.#symbolResolver = symbolResolver;
    this.#onHitl = onHitl;
  }

  // -- Public entry point ----------------------------------------------------

  async pause(): Promise<void> {
    if (!this.#actor) return;

    const snap = this.#actor.getSnapshot();
    if (snap.status === 'done' || snap.status === 'error') return;

    this.#actor.send({ type: 'PAUSE' });
    await waitFor(this.#actor, (s: { matches: (state: string) => boolean }) => s.matches('paused'));

    if (this.#currentCtx) {
      this.#currentCtx.xstateSnapshot = this.#actor.getPersistedSnapshot() as unknown as Record<string, unknown>;
      await this.#stateStore?.save(this.#currentCtx);
    }
  }

  async run(ctx: PipelineContext, startPass: PipelinePass = PipelinePass.Design): Promise<boolean> {
    ctx.runId = randomUUID();
    ctx.history = ctx.history ?? {};

    if (await this.#fs.exists(ctx.errorLogPath)) {
      await this.#fs.deleteFile(ctx.errorLogPath);
    }

    this.#currentCtx = ctx;

    const machine = createPipelineMachine({
      agentRunner: this.#agentRunner,
      cmd: this.#cmd,
      fs: this.#fs,
      git: this.#git,
      events: this.#events,
      logger: this.#logger,
      stateStore: this.#stateStore,
      symbolResolver: this.#symbolResolver,
      contextProvider: this.#contextProvider,
    });

    let lastErrorMessage: string | undefined;
    const unsubscribeError = this.#events.on('ERROR', (event) => {
      lastErrorMessage = event.message;
    });

    const snap = ctx.xstateSnapshot as Record<string, unknown> | undefined;
    const isValidSnapshot: boolean =
      snap !== undefined &&
      typeof snap === 'object' &&
      snap !== null &&
      'status' in snap &&
      'value' in snap &&
      'context' in snap &&
      'children' in snap;

    if (ctx.xstateSnapshot && !isValidSnapshot) {
      this.#logger.warn(
        'Corrupt xstateSnapshot detected — falling back to startPass-based resume.',
      );
      ctx.xstateSnapshot = undefined;
    }

    const actor = ctx.xstateSnapshot
      ? createActor(machine, {
          snapshot: ctx.xstateSnapshot as unknown as Snapshot<typeof machine>,
          input: { ctx, startPass },
        })
      : createActor(machine, { input: { ctx, startPass } });

    this.#actor = actor;

    const isPausedSnapshot: boolean =
      snap?.status === 'active' && snap?.value === 'paused';

    return new Promise<boolean>((resolve, reject) => {
      const unsubscribeHitl = this.#events.on(
        'HITL_REQUIRED',
        async (event) => {
          try {
            const action = await this.#onHitl(
              event.pass,
              (event.payload?.files as FileChange[]) ?? [],
            );
            actor.send({ type: HITL_EVENT_MAP[action], pass: event.pass! });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );

      actor.subscribe((snapshot) => {
        ctx.xstateSnapshot = actor.getPersistedSnapshot() as unknown as Record<string, unknown>;

        if (snapshot.status === 'done') {
          unsubscribeError();
          unsubscribeHitl();
          this.#actor = undefined;
          this.#currentCtx = undefined;

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

      if (isPausedSnapshot) {
        actor.send({ type: 'RESUME' });
      }
    });
  }
}
