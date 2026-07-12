import type { IGitService, IFileSystem, ICommandRunner, IAgentRunner, IEventBus, ILogger, ISelfCorrectionRunner } from '../interfaces.js';
import type { PipelineContext, AgentRunRequest, AgentArtefacts } from '../types.js';
import type { AgenticEvent } from '../types.js';
import type { PassCompletedPayload } from '../types.js';
import { PipelinePass, PASS_LABELS } from '../types.js';
import { sanitizeLogPayload } from '../log-sanitizer.js';

// REMARK: The helpers below (#emit, #emitPassStarted, #emitPassCompleted,
// #getAgentContextPayload, #buildArtefacts) are duplicated from
// PipelineOrchestrator. When each pass becomes an independent runner
// (roadmap), extract these to src/core/pass-utils.ts as shared functions.

export class SelfCorrectionRunner implements ISelfCorrectionRunner {
  readonly #agentRunner: IAgentRunner;
  readonly #cmd: ICommandRunner;
  readonly #git: IGitService;
  readonly #fs: IFileSystem;
  readonly #events: IEventBus;
  readonly #logger: ILogger;

  constructor(
    agentRunner: IAgentRunner,
    cmd: ICommandRunner,
    git: IGitService,
    fs: IFileSystem,
    events: IEventBus,
    logger: ILogger,
  ) {
    this.#agentRunner = agentRunner;
    this.#cmd = cmd;
    this.#git = git;
    this.#fs = fs;
    this.#events = events;
    this.#logger = logger;
  }

  async execute(ctx: PipelineContext): Promise<void> {
    const pass = ctx.currentPass!;
    const label = PASS_LABELS[pass];
    const totalAttempts = ctx.maxCorrectionRetries + 1;

    this.#emitPassStarted(ctx);

    for (let attemptIdx = 0; attemptIdx < totalAttempts; attemptIdx++) {
      const humanAttempt = attemptIdx + 1;
      ctx.currentAttempt = humanAttempt;
      const attemptLogger = this.#logger.child({
        module: 'execution',
        runId: ctx.runId,
        targetFile: ctx.specFileAbsPath,
        passId: pass,
        attemptCount: humanAttempt,
      });

      const isFirstAttempt = attemptIdx === 0;
      const prompt = isFirstAttempt
        ? this.#getAgentContextPayload(ctx)
        : this.#getAgentContextPayload(ctx, { attemptNumber: humanAttempt });
      const artefacts = isFirstAttempt
        ? await this.#buildArtefacts(ctx)
        : await this.#buildArtefacts(ctx, ctx.errorLogPath);

      attemptLogger.info(`Entering Pass ${pass} [Attempt ${humanAttempt}]`);
      attemptLogger.info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to agent');
      const request: AgentRunRequest = { pass, prompt, artefacts, runId: ctx.runId };
      await this.#agentRunner.execute(request);

      this.#emit('TEST_RUN_STARTED', `Running tests — attempt ${humanAttempt}/${totalAttempts}`, ctx);
      const result = await this.#cmd.runTests(ctx.testCmd);

      if (result.passed) {
        this.#emit('TEST_RUN_COMPLETED', `Tests passed on attempt ${humanAttempt}/${totalAttempts}`, ctx);
        if (await this.#fs.exists(ctx.errorLogPath)) {
          await this.#fs.deleteFile(ctx.errorLogPath);
        }
        const changes = await this.#git.getPendingChanges();
        this.#emitPassCompleted(ctx, { files: changes, attempts: humanAttempt });
        return;
      }

      attemptLogger.warn(
        { output: result.output.slice(0, 500), passed: false },
        `Test gate failed for Pass ${pass} [Attempt ${humanAttempt}] -- initiating self-correction loop-back`,
      );
      this.#emit(
        'TEST_RUN_FAILED',
        `Tests failed (attempt ${humanAttempt}/${totalAttempts}) — ${result.output.slice(0, 200)}`,
        ctx,
        { output: result.output },
      );

      await this.#fs.writeFile(ctx.errorLogPath, result.output);

      if (attemptIdx === ctx.maxCorrectionRetries) {
        throw new Error(
          `Pass ${pass} (${label}) FAILED after ${totalAttempts} attempt(s). ` +
          `The test suite still fails after ${ctx.maxCorrectionRetries} self-correction retries.`,
        );
      }

      this.#emit(
        'SELF_CORRECTION_ATTEMPTED',
        `Self-correction cycle ${humanAttempt}/${ctx.maxCorrectionRetries} — error log written to ${ctx.errorLogPath}`,
        ctx,
        { attempt: humanAttempt, maxRetries: ctx.maxCorrectionRetries },
      );
    }
  }

  // -- Helpers ----------------------------------------------------------------

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

  #getAgentContextPayload(ctx: PipelineContext, meta: Record<string, unknown> = {}): string {
    const payload = {
      featureName: ctx.featureName,
      featureDescription: ctx.featureDescription,
      pipelineVersion: ctx.pipelineVersion,
      paths: {
        designMmd: ctx.designMmdPath,
        specGherkin: ctx.specGherkinPath,
        errorLog: ctx.errorLogPath,
      },
      meta,
    };
    return JSON.stringify(payload, null, 2);
  }

  async #buildArtefacts(ctx: PipelineContext, errorLog?: string): Promise<AgentArtefacts> {
    const artefacts: AgentArtefacts = {};

    if (await this.#fs.exists(ctx.designMmdPath)) {
      artefacts.designMmd = ctx.designMmdPath;
    }
    if (await this.#fs.exists(ctx.specGherkinPath)) {
      artefacts.specGherkin = ctx.specGherkinPath;
    }
    if (ctx.specFileAbsPath) {
      const specExists = await this.#fs.exists(ctx.specFileAbsPath);
      if (specExists) {
        artefacts.specFile = ctx.specFileAbsPath;
      }
    }
    if (errorLog) {
      artefacts.errorLog = errorLog;
    }

    return artefacts;
  }
}
