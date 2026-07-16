import { randomUUID } from 'node:crypto';
import type { IGitService, IFileSystem, ICommandRunner, IAgentRunner, ISelfCorrectionRunner, IEventBus, ILogger, PipelineConfig } from './interfaces.js';
import type { PipelineContext, AgenticEvent, AgentRunRequest } from './types.js';
import {
  PipelinePass,
  PASS_LABELS,
  GIT_COMMIT_PASSES,
} from './types.js';
import type { PassCompletedPayload } from './types.js';
// DEFERRED: StateFile — see docs/statefile-design.md

import { sanitizeLogPayload } from './log-sanitizer.js';
import { getAgentContextPayload, buildArtefacts } from './runners/shared.js';

// ---------------------------------------------------------------------------
// PipelineOrchestrator — Pure-DI 8-pass state machine
// ---------------------------------------------------------------------------

export type HitlHandler = () => Promise<void>;

export class PipelineOrchestrator {
  readonly #git: IGitService;
  readonly #fs: IFileSystem;
  readonly #cmd: ICommandRunner;
  readonly #agentRunner: IAgentRunner;
  readonly #selfCorrectionRunner: ISelfCorrectionRunner;
  readonly #events: IEventBus;
  readonly #logger: ILogger;
  readonly #config: PipelineConfig;
  readonly #onHitl: HitlHandler;
  #passLogger: ILogger;

  constructor(
    git: IGitService,
    fs: IFileSystem,
    cmd: ICommandRunner,
    agentRunner: IAgentRunner,
    selfCorrectionRunner: ISelfCorrectionRunner,
    events: IEventBus,
    logger: ILogger,
    config: PipelineConfig,
    onHitl: HitlHandler = () => Promise.resolve(),
  ) {
    this.#git = git;
    this.#fs = fs;
    this.#cmd = cmd;
    this.#agentRunner = agentRunner;
    this.#selfCorrectionRunner = selfCorrectionRunner;
    this.#events = events;
    this.#logger = logger;
    this.#config = config;
    this.#onHitl = onHitl;
    this.#passLogger = logger;
  }

  #childLogger(ctx: PipelineContext, pass: PipelinePass, attempt: number): ILogger {
    return this.#logger.child({
      module: 'execution',
      runId: ctx.runId,
      targetFile: ctx.specFileAbsPath,
      passId: pass,
      attemptCount: attempt,
    });
  }

  // -- Public entry point ----------------------------------------------------

  async run(ctx: PipelineContext, startPass: PipelinePass = PipelinePass.Design): Promise<boolean> {
    this.#emit('PIPELINE_STARTED', `Starting pipeline v${ctx.pipelineVersion}`, ctx);

    ctx.runId = randomUUID();

    try {
      // Clean up any stale error log from a previous failed run
      if (await this.#fs.exists(ctx.errorLogPath)) {
        await this.#fs.deleteFile(ctx.errorLogPath);
      }

      // Pass 0 — Design & Architecture (only when starting fresh)
      if (startPass <= PipelinePass.Design) {
        ctx.currentPass = PipelinePass.Design;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.Design, 1);
        await this.#runPass0(ctx);

        if (!ctx.skipHitl) {
          this.#emit(
            'HITL_REQUIRED',
            `Review ${ctx.designMmdPath} and ${ctx.specGherkinPath} before proceeding.`,
            ctx, //TODO: we should probably print ctx when debug is turned on
          );
          await this.#onHitl(); //TODO: We need to commit final to git and create the 'state file' for resume ?
        }
      }

      // Pass 1 — Contracts, commit target
      if (startPass <= PipelinePass.Contracts) { //check if we are saving startPass to file. Consider renaming this variable.
        ctx.currentPass = PipelinePass.Contracts;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.Contracts, 1);
        await this.#runPass1(ctx); // TODO: what does ctx contain ?
        await this.#maybeCommit(ctx); //Review: why maybe ? In what situation will we not have git commit ?
        // TODO: not sure if we decided to implement a state file. If so, I will assume that we need to write something to statefile.
        //        This state file need not be committed to git I think.
      }

      // Pass 2 — Test generation, commit test file
      if (startPass <= PipelinePass.TestGeneration) {
        ctx.currentPass = PipelinePass.TestGeneration;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.TestGeneration, 1);
        await this.#runPass2(ctx);
        await this.#maybeCommitTestFile(ctx);
      }

      // Pass 3 — Core Implementation
      if (startPass <= PipelinePass.CoreImplementation) {
        ctx.currentPass = PipelinePass.CoreImplementation;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.CoreImplementation, 1);
        await this.#runPass3(ctx);
        await this.#maybeCommit(ctx);
      }

      // Pass 4 — Refactor & Optimise
      if (startPass <= PipelinePass.Refactor) {
        ctx.currentPass = PipelinePass.Refactor;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.Refactor, 1);
        await this.#runPass4(ctx);
        await this.#maybeCommit(ctx);
      }

      // Pass 5 — Security Hardening
      if (startPass <= PipelinePass.Security) {
        ctx.currentPass = PipelinePass.Security;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.Security, 1);
        await this.#runPass5(ctx);
        await this.#maybeCommit(ctx);
      }

      // Pass 6 — Observability & Logging
      if (startPass <= PipelinePass.Observability) {
        ctx.currentPass = PipelinePass.Observability;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.Observability, 1);
        await this.#runPass6(ctx);
        await this.#maybeCommit(ctx);
      }

      // Pass 7 — Documentation
      if (startPass <= PipelinePass.Documentation) {
        ctx.currentPass = PipelinePass.Documentation;
        ctx.currentAttempt = 1;
        this.#passLogger = this.#childLogger(ctx, PipelinePass.Documentation, 1);
        await this.#runPass7(ctx);
        await this.#maybeCommit(ctx);
      }

      this.#emit('PIPELINE_COMPLETED', 'All 8 passes completed successfully.', ctx);
      return true;
    } catch (err) {
      this.#emit('ERROR', err instanceof Error ? err.message : String(err), ctx);
      throw err;
    }
  }

  // -- Pass implementations --------------------------------------------------

  /**
   * Pass 0 — Design and Architecture
   * Runs the design agent with a spec file.
   */
  async #runPass0(ctx: PipelineContext): Promise<void> {
    await this.#fs.writeFile(ctx.designMmdPath, '');
    await this.#fs.writeFile(ctx.specGherkinPath, '');

    ctx.currentPass = PipelinePass.Design;
    this.#emitPassStarted(ctx);
    this.#passLogger.info(`Entering Pass ${PipelinePass.Design} [Attempt 1]`);
    const prompt = getAgentContextPayload(ctx);
    this.#passLogger.info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    const agentRequest: AgentRunRequest = {
      pass: ctx.currentPass!,
      prompt,
      artefacts: await buildArtefacts(ctx, this.#fs, undefined, this.#passLogger),
      runId: ctx.runId,
    };
    await this.#agentRunner.execute(agentRequest);
    this.#emitPassCompleted(ctx);

    await this.#ensureNonEmptyArtefacts(ctx);
  }

  async #runSimplePass(ctx: PipelineContext): Promise<void> {
    this.#emitPassStarted(ctx);
    this.#passLogger.info(`Entering Pass ${ctx.currentPass} [Attempt 1]`);
    const prompt = getAgentContextPayload(ctx);
    this.#passLogger.info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    const agentRequest: AgentRunRequest = {
      pass: ctx.currentPass!,
      prompt,
      artefacts: await buildArtefacts(ctx, this.#fs, undefined, this.#passLogger),
      runId: ctx.runId,
    };
    await this.#agentRunner.execute(agentRequest);
    const changes = await this.#git.getPendingChanges();
    this.#emitPassCompleted(ctx, { files: changes });
  }

  async #runPass1(ctx: PipelineContext): Promise<void> {
    //TODO: where are we doing git commit or writing to Statefile ?
    await this.#runSimplePass(ctx);
  }

  async #runPass2(ctx: PipelineContext): Promise<void> {
    //REMARK: Looks like Statefile has not been implemented at all
    await this.#runSimplePass(ctx);
  }

  async #runPass3(ctx: PipelineContext): Promise<void> {
    await this.#selfCorrectionRunner.execute(ctx);
  }

  async #runPass4(ctx: PipelineContext): Promise<void> {
    await this.#selfCorrectionRunner.execute(ctx);
  }

  async #runPass5(ctx: PipelineContext): Promise<void> {
    await this.#selfCorrectionRunner.execute(ctx);
  }

  async #runPass6(ctx: PipelineContext): Promise<void> {
    await this.#selfCorrectionRunner.execute(ctx);
  }

  async #runPass7(ctx: PipelineContext): Promise<void> {
    await this.#selfCorrectionRunner.execute(ctx);
  }

  // -- Helpers ---------------------------------------------------------------

  #emit(kind: AgenticEvent['kind'], message: string, ctx: PipelineContext, payload?: Record<string, unknown>): void {
    this.#events.emit({
      kind,
      message,
      timestamp: new Date(),
      pass: ctx.currentPass,
      passLabel: ctx.currentPass !== undefined ? PASS_LABELS[ctx.currentPass] : undefined,
      payload,
    });
  }

  #emitPassStarted(ctx: PipelineContext): void {
    this.#emit('PASS_STARTED', `Starting Pass ${ctx.currentPass}`, ctx);
  }

  #emitPassCompleted(ctx: PipelineContext, payload?: PassCompletedPayload): void {
    this.#emit('PASS_COMPLETED', `Completed Pass ${ctx.currentPass}`, ctx, payload);
  }

  async #maybeCommit(ctx: PipelineContext): Promise<void> {
    const pass = ctx.currentPass!;
    if (!GIT_COMMIT_PASSES.has(pass)) return;
    await this.#git.commit(
      ['.'],
      `chore(ai): completed Pass ${pass} -- ${PASS_LABELS[pass]}`,
    );
  }

  async #maybeCommitTestFile(ctx: PipelineContext): Promise<void> {
    await this.#git.commit(
      ['.'],
      `chore(ai): completed Pass ${PipelinePass.TestGeneration} -- ${PASS_LABELS[PipelinePass.TestGeneration]}`,
    );
  } // TODO: Check if this is even required once we fix the issues of git commit and statefile. We do not need to generate if tests already exist.

  async #ensureNonEmptyArtefacts(ctx: PipelineContext): Promise<void> {
    const mmdContent = (await this.#fs.readFile(ctx.designMmdPath)).trim();
    const gherkinContent = (await this.#fs.readFile(ctx.specGherkinPath)).trim();
    if (mmdContent.length < 30) {
      throw new Error(`Design agent failed to produce a valid Mermaid design diagram (content length < 30). This usually means the agent failed to generate a concrete design for the feature.`);
    }

    if (gherkinContent.length < 30) {
      throw new Error(`Spec agent failed to produce a valid Gherkin specification (content length < 30). This usually means the agent failed to generate concrete test scenarios for the feature.`);
    }
  }
}
