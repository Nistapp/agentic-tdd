import { resolve, dirname, basename, extname, join } from 'node:path';
import { cwd } from 'node:process';
import { randomUUID } from 'node:crypto';
import type { IGitService, IFileSystem, ICommandRunner, IEventBus } from './interfaces.js';
import type { PipelineContext, AgenticEvent, ExecutionMetadata } from './types.js';
import {
  PipelinePass,
  AGENT_NAMES,
  PASS_LABELS,
  SELF_CORRECTION_PASSES,
  GIT_COMMIT_PASSES,
} from './types.js';
import { loggers, createExecutionContextLogger, executionContextStorage, reqLogger, sanitizeLogPayload, type ExecutionContext } from '../utils/logger.js';
import { PACKAGE_AGENTS_DIR } from '../infrastructure/command-runner.js';

const STATE_FILE = join(cwd(), '.opencode', 'active-run.json');

// ---------------------------------------------------------------------------
// PipelineOrchestrator — Pure-DI 8-pass state machine
// ---------------------------------------------------------------------------

export type HitlHandler = () => Promise<void>;

export class PipelineOrchestrator {
  readonly #git: IGitService;
  readonly #fs: IFileSystem;
  readonly #cmd: ICommandRunner;
  readonly #events: IEventBus;
  readonly #onHitl: HitlHandler;

  constructor(
    git: IGitService,
    fs: IFileSystem,
    cmd: ICommandRunner,
    events: IEventBus,
    onHitl: HitlHandler = () => Promise.resolve(),
  ) {
    this.#git = git;
    this.#fs = fs;
    this.#cmd = cmd;
    this.#events = events;
    this.#onHitl = onHitl;
  }

  #buildExecContext(ctx: PipelineContext, pass: PipelinePass, attempt: number): ExecutionContext {
    const metadata: ExecutionMetadata = {
      runId: ctx.runId!,
      targetFile: ctx.specFileAbsPath,
      passId: pass,
      attemptCount: attempt,
    };
    return { metadata, logger: createExecutionContextLogger(metadata) };
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
        const exec = this.#buildExecContext(ctx, PipelinePass.Design, 1);
        await executionContextStorage.run(exec, () => this.#runPass0(ctx));

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
        const exec = this.#buildExecContext(ctx, PipelinePass.Contracts, 1);
        await executionContextStorage.run(exec, () => this.#runPass1(ctx)); // TODO: what does ctx contain ?
        await this.#maybeCommit(ctx); //Review: why maybe ? In what situation will we not have git commit ?
        // TODO: not sure if we decided to implement a state file. If so, I will assume that we need to write something to statefile.
        //        This state file need not be committed to git I think.
      }

      // Pass 2 — Test generation, commit test file
      if (startPass <= PipelinePass.TestGeneration) {
        ctx.currentPass = PipelinePass.TestGeneration;
        ctx.currentAttempt = 1;
        const exec = this.#buildExecContext(ctx, PipelinePass.TestGeneration, 1);
        await executionContextStorage.run(exec, () => this.#runPass2(ctx));
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
          const exec = this.#buildExecContext(ctx, pass, 1);
          await executionContextStorage.run(exec, () => this.#runSelfCorrectingPass(ctx));
          await this.#maybeCommit(ctx);
        }
      }

      // Pass 7 — Documentation, commit target
      if (startPass <= PipelinePass.Documentation) {
        ctx.currentPass = PipelinePass.Documentation;
        ctx.currentAttempt = 1;
        const exec = this.#buildExecContext(ctx, PipelinePass.Documentation, 1);
        await executionContextStorage.run(exec, () => this.#runPass7(ctx));
        await this.#maybeCommit(ctx);
      }

      // Delete state file to free the lock
      if (await this.#fs.exists(STATE_FILE)) {
        await this.#fs.deleteFile(STATE_FILE);
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
    try {
      await this.#fs.writeFile(ctx.designMmdPath, '');
      await this.#fs.writeFile(ctx.specGherkinPath, '');

      ctx.currentPass = PipelinePass.Design;
      this.#emitPassStarted(ctx);
      reqLogger().info(`Entering Pass ${PipelinePass.Design} [Attempt 1]`);
      const prompt = this.#getAgentContextPayload(ctx);
      reqLogger().info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
      const genAiOutput = await this.#invokeOpenCode(ctx, prompt);
      this.#emitPassCompleted(ctx);

      await this.#ensureNonEmptyArtefacts(ctx);

    } finally {
      // Nothing to clean up anymore
    }
  }





  async #runPass1(ctx: PipelineContext): Promise<void> {
    this.#emitPassStarted(ctx);
    reqLogger().info(`Entering Pass ${ctx.currentPass} [Attempt 1]`);
    const prompt = this.#getAgentContextPayload(ctx);
    reqLogger().info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    const genAiOutput = await this.#invokeOpenCode(ctx, prompt);
    const changes = await this.#git.getPendingChanges();
    this.#emitPassCompleted(ctx, { files: changes as unknown as Record<string, unknown> }); //TODO: where are we doing git commit or writing to Statefile ?
  }

  async #runPass2(ctx: PipelineContext): Promise<void> {
    this.#emitPassStarted(ctx);
    reqLogger().info(`Entering Pass ${ctx.currentPass} [Attempt 1]`);
    const prompt = this.#getAgentContextPayload(ctx);
    reqLogger().info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    const genAiOutput = await this.#invokeOpenCode(ctx, prompt);
    const changes = await this.#git.getPendingChanges();
    this.#emitPassCompleted(ctx, { files: changes as unknown as Record<string, unknown> });//REMARK: Looks like Statefile has not been implemented at all
  }

  async #runSelfCorrectingPass(ctx: PipelineContext): Promise<void> {
    const pass = ctx.currentPass!;
    const label = PASS_LABELS[pass];
    const agent = AGENT_NAMES[pass];
    const totalAttempts = ctx.maxCorrectionRetries + 1;
    const prompt = this.#getAgentContextPayload(ctx);

    this.#emitPassStarted(ctx);

    // Initial agent run
    reqLogger().info(`Entering Pass ${pass} [Attempt 1]`);
    reqLogger().info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    const genAiOutput = await this.#invokeOpenCode(ctx, prompt);

    for (let attemptIdx = 0; attemptIdx < totalAttempts; attemptIdx++) {
      const humanAttempt = attemptIdx + 1;
      ctx.currentAttempt = humanAttempt;
      const store = executionContextStorage.getStore()!;
      const fresh = this.#buildExecContext(ctx, pass, humanAttempt);
      store.metadata = fresh.metadata;
      store.logger = fresh.logger;

      reqLogger().info(`Entering Pass ${pass} [Attempt ${humanAttempt}]`);

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
        this.#emitPassCompleted(ctx, { files: changes as unknown as Record<string, unknown>, attempts: humanAttempt });
        return;
      }

      // Tests failed
      reqLogger().warn(
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
      reqLogger().info(`Entering Pass ${pass} [Attempt ${humanAttempt}]`);
      const correctionPrompt = this.#getAgentContextPayload(ctx, { attemptNumber: humanAttempt });
      reqLogger().info({ payload: { prompt: sanitizeLogPayload(correctionPrompt, 'info') } }, 'Dispatching prompt to Opencode');
      const genAiOutput = await this.#invokeOpenCode(ctx, correctionPrompt, ctx.errorLogPath);
    }
  }

  async #runPass7(ctx: PipelineContext): Promise<void> {
    this.#emitPassStarted(ctx);
    reqLogger().info(`Entering Pass ${ctx.currentPass} [Attempt 1]`);
    const prompt = this.#getAgentContextPayload(ctx);
    reqLogger().info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    const genAiOutput = await this.#invokeOpenCode(ctx, prompt);
    const changes = await this.#git.getPendingChanges();
    this.#emitPassCompleted(ctx, { files: changes as unknown as Record<string, unknown> });
  } //REMARK: What is happening with Git here ? What is happening with statefile here?
  //        Do we automate the final PR too ? 

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

  #emitPassCompleted(ctx: PipelineContext, payload?: Record<string, unknown>): void {
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
      loggers.core.debug(`buildArgs: specFileAbsPath='${ctx.specFileAbsPath}' exists=${specExists}`);
      if (specExists) {
        args.push('--file', ctx.specFileAbsPath);
      } else {
        loggers.core.debug(`buildArgs: specFileAbsPath does not exist — not attaching as --file`);
      }
    } else if (ctx.featureDescription) {
      loggers.core.debug(`buildArgs: featureDescription present but specFileAbsPath is not set — spec will NOT be attached as --file`);
    }
    if (errorLog && (await this.#fs.exists(errorLog))) {
      args.push('--file', errorLog);
    }
    const level = reqLogger().level;
    if (level === 'debug' || level === 'trace') {
      loggers.core.debug(`buildArgs: active log level is '${level}' — injecting --print-logs and --log-level DEBUG`);
      args.push('--print-logs', '--log-level', 'DEBUG');
    }
    args.push('--dangerously-skip-permissions', prompt);
    return args;
  }

  async #invokeOpenCode(ctx: PipelineContext, prompt: string, errorLog?: string): Promise<string> {
    try {
      await this.#logPreFlight(ctx);
      const response = await this.#cmd.runOpenCode(await this.#buildArgs(ctx, prompt, errorLog));
      reqLogger().debug('Received completion from Opencode');
      reqLogger().debug({ payload: { completion: sanitizeLogPayload(response, 'debug') } }, 'Opencode completion payload');
      loggers.agent(ctx.currentPass!).debug({ payload: response }, 'LLM response received');
      await this.#persistPassLog(ctx, response);
      return response;
    } catch (err) {
      const opencodeLog = `${process.env.HOME ?? '~'}/.local/share/opencode/log/opencode.log`;
      reqLogger().error(
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
      loggers.core.warn({ agentFile }, 'Could not read agent model');
    }

    const apiKeySet = process.env.OPENROUTER_API_KEY ? 'present' : 'missing';
    loggers.core.info(
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
      reqLogger().debug({ logFile }, 'Persisted opencode output to per-pass log');
    } catch (err) {
      reqLogger().warn({ err }, 'Failed to persist per-pass opencode log');
    }
  }

  async #ensureNonEmptyArtefacts(
    ctx: PipelineContext,
    altGherkinPath?: string,
  ): Promise<void> {
    const gherkinPath = altGherkinPath ?? ctx.specGherkinPath;
    const mmdContent = (await this.#fs.readFile(ctx.designMmdPath)).trim();
    const gherkinContent = (await this.#fs.readFile(gherkinPath)).trim();
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