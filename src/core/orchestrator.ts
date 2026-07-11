import { resolve, dirname, basename, extname, join } from 'node:path';
import { cwd } from 'node:process';
import { randomUUID } from 'node:crypto';
import type { IGitService, IFileSystem, ICommandRunner, IEventBus, ILogger, PipelineConfig } from './interfaces.js';
import type { PipelineContext, AgenticEvent } from './types.js';
import {
  PipelinePass,
  AGENT_NAMES,
  PASS_LABELS,
  SELF_CORRECTION_PASSES,
  GIT_COMMIT_PASSES,
} from './types.js';
import type { PassCompletedPayload } from './types.js';
// DEFERRED: StateFile — see docs/statefile-design.md

import { sanitizeLogPayload } from './log-sanitizer.js';
import { PACKAGE_AGENTS_DIR } from '../infrastructure/command-runner.js';

// ---------------------------------------------------------------------------
// PipelineOrchestrator — Pure-DI 8-pass state machine
// ---------------------------------------------------------------------------

export type HitlHandler = () => Promise<void>;

export class PipelineOrchestrator {
  readonly #git: IGitService;
  readonly #fs: IFileSystem;
  readonly #cmd: ICommandRunner;
  readonly #events: IEventBus;
  readonly #logger: ILogger;
  readonly #config: PipelineConfig;
  readonly #onHitl: HitlHandler;
  #passLogger: ILogger;

  constructor(
    git: IGitService,
    fs: IFileSystem,
    cmd: ICommandRunner,
    events: IEventBus,
    logger: ILogger,
    config: PipelineConfig,
    onHitl: HitlHandler = () => Promise.resolve(),
  ) {
    this.#git = git;
    this.#fs = fs;
    this.#cmd = cmd;
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

      // Passes 3–6 — self-correction guarded
      for (const pass of [
        PipelinePass.CoreImplementation,
        PipelinePass.Refactor,
        PipelinePass.Security,
        PipelinePass.Observability,
      ]) {
        if (startPass <= pass) {
          ctx.currentPass = pass;
          ctx.currentAttempt = 1;
          this.#passLogger = this.#childLogger(ctx, pass, 1);
          await this.#runSelfCorrectingPass(ctx);
          await this.#maybeCommit(ctx);
        }
      }

      // Pass 7 — Documentation, commit target
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
    const prompt = this.#getAgentContextPayload(ctx);
    this.#passLogger.info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    await this.#invokeOpenCode(ctx, prompt);
    this.#emitPassCompleted(ctx);

    await this.#ensureNonEmptyArtefacts(ctx);
  }





  async #runSimplePass(ctx: PipelineContext): Promise<void> {
    this.#emitPassStarted(ctx);
    this.#passLogger.info(`Entering Pass ${ctx.currentPass} [Attempt 1]`);
    const prompt = this.#getAgentContextPayload(ctx);
    this.#passLogger.info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    await this.#invokeOpenCode(ctx, prompt);
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

  async #runSelfCorrectingPass(ctx: PipelineContext): Promise<void> {
    const pass = ctx.currentPass!;
    const label = PASS_LABELS[pass];
    const agent = AGENT_NAMES[pass];
    const totalAttempts = ctx.maxCorrectionRetries + 1;
    const prompt = this.#getAgentContextPayload(ctx);

    this.#emitPassStarted(ctx);

    // Initial agent run
    this.#passLogger.info(`Entering Pass ${pass} [Attempt 1]`);
    this.#passLogger.info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    await this.#invokeOpenCode(ctx, prompt);

    for (let attemptIdx = 0; attemptIdx < totalAttempts; attemptIdx++) {
      const humanAttempt = attemptIdx + 1;
      ctx.currentAttempt = humanAttempt;
      this.#passLogger = this.#childLogger(ctx, pass, humanAttempt);

      this.#passLogger.info(`Entering Pass ${pass} [Attempt ${humanAttempt}]`);

      // Run the test suite
      this.#emit('TEST_RUN_STARTED', `Running tests — attempt ${humanAttempt}/${totalAttempts}`, ctx);
      const result = await this.#cmd.runTests(ctx.testCmd);

      if (result.passed) {
        this.#emit('TEST_RUN_COMPLETED', `Tests passed on attempt ${humanAttempt}/${totalAttempts}`, ctx);
        // Context Compaction: flush stale error log
        if (await this.#fs.exists(ctx.errorLogPath)) {
          await this.#fs.deleteFile(ctx.errorLogPath);
        }
        const changes = await this.#git.getPendingChanges();
        this.#emitPassCompleted(ctx, { files: changes, attempts: humanAttempt });
        return;
      }

      // Tests failed
      this.#passLogger.warn(
        { output: result.output.slice(0, 500), passed: false },
        `Test gate failed for Pass ${pass} [Attempt ${humanAttempt}] -- initiating self-correction loop-back`,
      );
      this.#emit(
        'TEST_RUN_FAILED',
        `Tests failed (attempt ${humanAttempt}/${totalAttempts}) — ${result.output.slice(0, 200)}`,
        ctx,
        { output: result.output },
      ); //REMARK: We could ask the dev to review the generated code, make any minor corrections if necessary and continue for anothe cycle of corrections. How many cycles do we limit this to ?

      // Last attempt exhausted → abort
      if (attemptIdx === ctx.maxCorrectionRetries) {
        // Context Compaction: write the final error log so it can be inspected
        await this.#fs.writeFile(ctx.errorLogPath, result.output);

        throw new Error(
          `Pass ${pass} (${label}) FAILED after ${totalAttempts} attempt(s). ` +
          `The test suite still fails after ${ctx.maxCorrectionRetries} self-correction retries.`,
        );
      }

      // Context Compaction: write error to a disposable file
      await this.#fs.writeFile(ctx.errorLogPath, result.output);
      this.#emit(
        'SELF_CORRECTION_ATTEMPTED',
        `Self-correction cycle ${humanAttempt}/${ctx.maxCorrectionRetries} — error log written to ${ctx.errorLogPath}`,
        ctx,
        { attempt: humanAttempt, maxRetries: ctx.maxCorrectionRetries },
      );

      // Re-invoke agent with correction prompt + error log
      this.#passLogger.info(`Entering Pass ${pass} [Attempt ${humanAttempt}]`);
      const correctionPrompt = this.#getAgentContextPayload(ctx, { attemptNumber: humanAttempt });
      this.#passLogger.info({ payload: { prompt: sanitizeLogPayload(correctionPrompt, 'info') } }, 'Dispatching prompt to Opencode');
      await this.#invokeOpenCode(ctx, correctionPrompt, ctx.errorLogPath);
    }
  }

  async #runPass7(ctx: PipelineContext): Promise<void> {
    //REMARK: What is happening with Git here ? What is happening with statefile here?
    //        Do we automate the final PR too ?
    await this.#runSimplePass(ctx);
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

  // -- Command building ------------------------------------------------------

  async #buildArgs(ctx: PipelineContext, prompt: string, errorLog?: string): Promise<string[]> {
    const args = ['run', '--agent', AGENT_NAMES[ctx.currentPass!]];

    if (await this.#fs.exists(ctx.designMmdPath)) {
      args.push('--file', ctx.designMmdPath);
    }
    if (await this.#fs.exists(ctx.specGherkinPath)) {
      args.push('--file', ctx.specGherkinPath);
    }
    if (ctx.specFileAbsPath) {
      const specExists = await this.#fs.exists(ctx.specFileAbsPath);
      this.#passLogger.debug(`buildArgs: specFileAbsPath='${ctx.specFileAbsPath}' exists=${specExists}`);
      if (specExists) {
        args.push('--file', ctx.specFileAbsPath);
      } else {
        this.#passLogger.debug(`buildArgs: specFileAbsPath does not exist — not attaching as --file`);
      }
    } else if (ctx.featureDescription) {
      this.#passLogger.debug(`buildArgs: featureDescription present but specFileAbsPath is not set — spec will NOT be attached as --file`);
    }
    if (errorLog && (await this.#fs.exists(errorLog))) {
      args.push('--file', errorLog);
    }
    const level = this.#logger.level;
    if (level === 'debug' || level === 'trace') {
      this.#passLogger.debug(`buildArgs: active log level is '${level}' — injecting --print-logs and --log-level DEBUG`);
      args.push('--print-logs', '--log-level', 'DEBUG');
    }
    args.push('--dangerously-skip-permissions', prompt);
    return args;
  }

  async #invokeOpenCode(ctx: PipelineContext, prompt: string, errorLog?: string): Promise<string> {
    try {
      await this.#logPreFlight(ctx);
      const response = await this.#cmd.runOpenCode(await this.#buildArgs(ctx, prompt, errorLog));
      this.#passLogger.debug('Received completion from Opencode');
      this.#passLogger.debug({ payload: { completion: sanitizeLogPayload(response, 'debug') } }, 'Opencode completion payload');
      this.#passLogger.child({ module: `agent:${AGENT_NAMES[ctx.currentPass!]}` }).debug({ payload: response }, 'LLM response received');
      await this.#persistPassLog(ctx, response);
      return response;
    } catch (err) {
      const opencodeLog = this.#config.opencodeLogPath;
      this.#passLogger.error(
        { err, hint: `Check opencode self-log at ${opencodeLog} for upstream error diagnostics` },
        'Opencode invocation failed',
      );
      throw err;
    }
  }

  async #logPreFlight(ctx: PipelineContext): Promise<void> {
    const pass = ctx.currentPass!;
    const agentName = AGENT_NAMES[pass];
    const agentFile = resolve(PACKAGE_AGENTS_DIR, `${agentName}.md`);

    let model = '<unknown>';
    try {
      if (await this.#fs.exists(agentFile)) {
        const content = await this.#fs.readFile(agentFile);
        const match = content.match(/^model:\s*(.+)$/m);
        if (match) model = (match[1] ?? '').trim() || '<unknown>';
      }
    } catch {
      this.#passLogger.warn({ agentFile }, 'Could not read agent model');
    }

    const apiKeySet = this.#config.apiKeySet;
    this.#passLogger.info(
      { pass, agent: agentName, model, apiKey: apiKeySet },
      'Pre-flight: invoking opencode agent',
    );
  }

  async #persistPassLog(ctx: PipelineContext, response: string): Promise<void> {
    try {
      const logDir = join(cwd(), '.opencode', 'log');
      if (!(await this.#fs.exists(logDir))) {
        await this.#fs.mkdir(logDir);
      }
      const pass = ctx.currentPass!;
      const runId = ctx.runId ?? 'unknown';
      const logFile = join(logDir, `pass-${pass}-${runId}.log`);
      await this.#fs.writeFile(logFile, response);
      this.#passLogger.debug({ logFile }, 'Persisted opencode output to per-pass log');
    } catch (err) {
      this.#passLogger.warn({ err }, 'Failed to persist per-pass opencode log');
    }
  }

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

  // -- Pass prompts (mirrors Python cli.py) ----------------------------------

  #getAgentContextPayload(ctx: PipelineContext, meta: Record<string, unknown> = {}): string {
    const payload = {
      featureName: ctx.featureName,
      featureDescription: ctx.featureDescription,
      pipelineVersion: ctx.pipelineVersion,
      paths: {
        designMmd: ctx.designMmdPath,
        specGherkin: ctx.specGherkinPath,
        errorLog: ctx.errorLogPath
      },
      meta
    };
    return JSON.stringify(payload, null, 2);
  }
}
