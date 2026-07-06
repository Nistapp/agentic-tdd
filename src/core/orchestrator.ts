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
      const prompt = this.#getDesignPrompt(ctx);
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
    const prompt = this.#getContractsPrompt(ctx);
    reqLogger().info({ payload: { prompt: sanitizeLogPayload(prompt, 'info') } }, 'Dispatching prompt to Opencode');
    const genAiOutput = await this.#invokeOpenCode(ctx, prompt);
    const changes = await this.#git.getPendingChanges();
    this.#emitPassCompleted(ctx, { files: changes as unknown as Record<string, unknown> }); //TODO: where are we doing git commit or writing to Statefile ?
  }

  async #runPass2(ctx: PipelineContext): Promise<void> {
    this.#emitPassStarted(ctx);
    reqLogger().info(`Entering Pass ${ctx.currentPass} [Attempt 1]`);
    const prompt = this.#getTestGenPrompt(ctx);
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
    const prompt = this.#getImplPrompt(ctx);

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
      const correctionPrompt = this.#getCorrectionPrompt(ctx, humanAttempt);
      reqLogger().info({ payload: { prompt: sanitizeLogPayload(correctionPrompt, 'info') } }, 'Dispatching prompt to Opencode');
      const genAiOutput = await this.#invokeOpenCode(ctx, correctionPrompt, ctx.errorLogPath);
    }
  }

  async #runPass7(ctx: PipelineContext): Promise<void> {
    this.#emitPassStarted(ctx);
    reqLogger().info(`Entering Pass ${ctx.currentPass} [Attempt 1]`);
    const prompt = this.#getDocsPrompt(ctx);
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
    const agentFile = `.opencode/agent/${agentName}.md`;

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
    const issueText = ctx.featureDescription ?? ctx.featureName ?? 'module';
    const scfgLabel = issueText.length > 60
      ? issueText.replace(/\n/g, ' ').slice(0, 57) + '...'
      : issueText;

    if (mmdContent.length < 30) {
      this.#emit('WARNING', `Mermaid artefact is empty or too short — scaffolding fallback content`, ctx);
      const scaffold = this.#scaffoldMermaid(scfgLabel);
      await this.#fs.writeFile(ctx.designMmdPath, scaffold);
    } //REMARK: Generating generic mmd is useless We should probably force the tool to fail with proper error message. 

    if (gherkinContent.length < 30) {
      this.#emit('WARNING', `Gherkin artefact is empty or too short — scaffolding fallback content`, ctx);
      const scaffold = this.#scaffoldGherkin(scfgLabel);
      await this.#fs.writeFile(gherkinPath, scaffold);
    } //REMARK: Generating generic specs is useless. We should probably force the tool to fail with proper error message. 
  }

  #scaffoldMermaid(label: string): string {
    return [
      `%% Module: ${label}`,
      `%% Proposed Target File: src/${label.replace(/[^a-zA-Z0-9]/g, '_')}.ts`,
      `%% Generated by: pass-0-design-agent  Pipeline: v1.0.0`,
      `%% DESIGN-NOTE: This diagram was auto-scaffolded because the design agent`,
      `%%              produced empty output. It MUST be reviewed and expanded.`,
      ``,
      `flowchart TD`,
      `    A[Start] --> B[Process Input]`,
      `    B --> C{Valid?}`,
      `    C -->|yes| D[Produce Output]`,
      `    C -->|no| E[Return Error]`,
      `    D --> F[End]`,
      `    E --> F`,
    ].join('\n');
  }

  #scaffoldGherkin(label: string): string {
    return [
      `Feature: ${label}`,
      `  As a user`,
      `  I want the system to process inputs and return results`,
      `  So that I can achieve my goal`,
      ``,
      `  Background:`,
      `    Given the system is initialised`,
      ``,
      `  @happy-path`,
      `  Scenario: Valid input produces expected output`,
      `    Given a well-formed input`,
      `    When the system processes it`,
      `    Then the expected output is returned`,
      ``,
      `  @edge-case`,
      `  Scenario: Empty input is handled gracefully`,
      `    Given the input is empty`,
      `    When the system processes it`,
      `    Then a meaningful validation error is returned`,
      ``,
      `  @error`,
      `  Scenario: Invalid input raises an error`,
      `    Given the input is malformed`,
      `    When the system processes it`,
      `    Then an error is raised with a descriptive message`,
    ].join('\n');
  }

  // -- Pass prompts (mirrors Python cli.py) ----------------------------------

  #getDesignPrompt(ctx: PipelineContext): string {
    const designMmdName = this.#filename(ctx.designMmdPath);
    const specGherkinName = this.#filename(ctx.specGherkinPath);
    const issueText = ctx.featureDescription ?? '(no description provided)';
    return [
      `You are running as Pass 0 (Design & Architecture) of the v${ctx.pipelineVersion} AI Factory pipeline.`,
      ``,
      `FEATURE REQUIREMENTS:`,
      ...issueText.split('\n').map(line => `  ${line}`),
      ``,
      `PRODUCE TWO ARTEFACTS:`,
      ``,
      `ARTEFACT 1 -- Mermaid diagram (${designMmdName})`,
      `  Write to: ${ctx.designMmdPath}`,
      `  Header comment MUST include:`,
      `    %% Module: ${ctx.featureName}`,
      `    %% Generated by: ${AGENT_NAMES[PipelinePass.Design]}  Pipeline: v${ctx.pipelineVersion}`,
      ``,
      `  The diagram should model the system described in the issue description.`,
      `  Use stateDiagram-v2, sequenceDiagram, or flowchart TD — whichever best`,
      `  represents the logic described in the issue.`,
      ``,
      `ARTEFACT 2 -- Gherkin specification (${specGherkinName})`,
      `  Write to: ${ctx.specGherkinPath}`,
      `  Feature description derived from the issue.`,
      `  Minimum three Scenarios: happy path, edge case, error/exception case.`,
      `  Use concrete values (no <placeholder> tokens).`,
      ``,
      `STRICT RULES:`,
      `  - Do NOT create or modify any source file.  Only create ${designMmdName} and ${specGherkinName}.`,
      `  - Do NOT write executable code of any kind.`,
      `  - Mermaid syntax must be valid and renderable by mermaid.js v10+.`,
    ].join('\n');
  } //REMARK: Evaluate if this Should this prompt go into the agent ? 



  #getContractsPrompt(ctx: PipelineContext): string {
    const designMmdName = this.#filename(ctx.designMmdPath);
    const specGherkinName = this.#filename(ctx.specGherkinPath);
    return [
      `You are running as Pass 1 (Contracts & Types) of the v${ctx.pipelineVersion} AI Factory pipeline.`,
      ``,
      `Attached files:`,
      `  Architecture constraint:                    ${ctx.designMmdPath}`,
      `  Behavioural specification:                  ${ctx.specGherkinPath}`,
      ``,
      `Your task:`,
      `  Read the design artefacts and create/modify the necessary source files to add type contracts:`,
      `    1. Identify every entity, input type, output type, and error condition`,
      `       described in ${designMmdName} and ${specGherkinName}.`,
      `    2. Define a strict type for each (Pydantic BaseModel / TypedDict /`,
      `       dataclass / Protocol for Python; interface / type / enum for TS).`,
      `    3. Add full type annotations to all new/existing function signatures.`,
      `    4. Function bodies must remain as stubs (raise NotImplementedError).`,
      ``,
      `STRICT RULES:`,
      `  - Do NOT write business logic -- stubs only.`,
      `  - Do NOT modify ${designMmdName} or ${specGherkinName}.`,
    ].join('\n');
  } //REMARK: Evaluate if this Should this prompt go into the agent ?

  #getTestGenPrompt(ctx: PipelineContext): string {
    const designMmdName = this.#filename(ctx.designMmdPath);
    const specGherkinName = this.#filename(ctx.specGherkinPath);
    return [
      `You are running as Pass 2 (TDD Test Generation -- Red Phase) of the v${ctx.pipelineVersion} AI Factory pipeline.`,
      ``,
      `Attached files:`,
      `  Architecture constraint:          ${ctx.designMmdPath}`,
      `  Behavioural specification:        ${ctx.specGherkinPath}`,
      ``,
      `Your task:`,
      `  Create the necessary test files to cover the contracts:`,
      `    1. Mirror every Scenario in ${specGherkinName} as a named test case.`,
      `    2. Cover all type contracts defined in Pass 1.`,
      `    3. Cover happy paths, edge cases, boundary conditions, and errors.`,
      `    4. Use pytest (Python) or Jest (TypeScript/JavaScript).`,
      `    5. Be independent, deterministic, and idempotent.`,
      ``,
      `  NOTE: These tests are EXPECTED to fail right now (Red Phase).`,
      `  The function bodies are stubs.  Write the tests against the CONTRACT,`,
      `  not the current (stub) implementation.`,
      ``,
      `STRICT RULES:`,
      `  - Create ONLY test files -- do not modify source implementation files.`,
    ].join('\n');
  } //REMARK: Evaluate if this Should this prompt go into the agent ?

  #getImplPrompt(ctx: PipelineContext): string {
    const designMmdName = this.#filename(ctx.designMmdPath);
    const specGherkinName = this.#filename(ctx.specGherkinPath);
    const pass = ctx.currentPass!;
    const label = PASS_LABELS[pass];
    const guard = pass === PipelinePass.CoreImplementation
      ? [`STRICT RULES:`,
        `  - Do NOT modify any test files, ${designMmdName}, or ${specGherkinName}.`,
        `  - Do NOT add documentation blocks -- that is Pass 7's job.`,
        `  - Do NOT add logging -- that is Pass 6's job.`,
        `  - Do NOT deviate from the type contracts established in Pass 1.`]
      : [
        `STRICT RULES:`,
        `  - Do NOT change public function signatures, names, or return types.`,
        `  - Do NOT add new features or fix out-of-scope bugs.`,
        `  - Do NOT modify test files or design artefacts.`,
        `  - If no improvement is possible, return without changes.`,
      ];
    return [
      `You are running as Pass ${pass} (${label}) of the v${ctx.pipelineVersion} AI Factory pipeline.`,
      ``,
      `Attached files:`,
      `  Architecture constraint:   ${ctx.designMmdPath}`,
      `  Behavioural specification: ${ctx.specGherkinPath}`,
      ``,
      `Your task:`,
      `  Implement the business logic in the source files so all tests pass.`,
      `  The diagram in '${designMmdName}' is your binding architectural contract`,
      `  -- deviate from it only if the test failures prove the diagram is wrong`,
      `  (and leave a comment explaining).`,
      ``,
      ...guard,
    ].join('\n');
  } //REMARK: Evaluate if this Should this prompt go into the agent ?

  #getCorrectionPrompt(ctx: PipelineContext, attemptNum: number): string {
    const pass = ctx.currentPass!;
    const label = PASS_LABELS[pass];
    const errorLogName = this.#filename(ctx.errorLogPath);
    const designMmdName = this.#filename(ctx.designMmdPath);
    const specGherkinName = this.#filename(ctx.specGherkinPath);
    return [
      `You are running as Pass ${pass} (${label}) of the v${ctx.pipelineVersion} AI Factory pipeline.`,
      ``,
      `SELF-CORRECTION CYCLE ${attemptNum} of ${ctx.maxCorrectionRetries}.`,
      ``,
      `Your previous edits caused the test suite to fail.`,
      `The complete failure log is attached as '${errorLogName}'.`,
      `Read that file to diagnose the root cause, then fix the implementation to make the tests pass.`,
      ``,
      `STRICT RULES:`,
      `  - Do NOT modify test files, ${designMmdName}, ${specGherkinName}, or any other non-source file.`,
      `  - Do NOT change test assertions to match broken logic -- fix the logic.`,
      `  - Do NOT add new public functions or change existing signatures.`,
      `  - Fix the ROOT CAUSE of the failure, not just the symptom.`,
    ].join('\n');
  } //REMARK: Evaluate if this Should this prompt go into the agent ?

  #getDocsPrompt(ctx: PipelineContext): string {
    const designMmdName = this.#filename(ctx.designMmdPath);
    const specGherkinName = this.#filename(ctx.specGherkinPath);
    return [
      `You are running as Pass 7 (Documentation) of the v${ctx.pipelineVersion} AI Factory pipeline.`,
      ``,
      `This is the finalised implementation after TDD, Refactor, Security,`,
      `and Observability passes.  Your task -- add complete documentation to all relevant source files:`,
      `  1. A module-level docstring describing the purpose, architecture,`,
      `     and the pipeline version that produced this file.`,
      `  2. JSDoc (JS/TS) or Python docstrings for every public function/class.`,
      `  3. @param / Args, @returns / Returns, @throws / Raises sections.`,
      `  4. An @see / See Also link pointing to '${designMmdName}' on`,
      `     every public function -- this is the Traceability Matrix link.`,
      `     It lets any developer navigate from code to the architectural`,
      `     diagram that dictated it.  This is MANDATORY.`,
      ``,
      `STRICT RULES:`,
      `  - Edit ONLY comments and docstrings.`,
      `  - Do NOT change any logic, variable names, or control flow.`,
      `  - Do NOT modify any test files, ${designMmdName}, or ${specGherkinName}.`,
    ].join('\n');
  } //REMARK: Evaluate if this Should this prompt go into the agent ?

  #filename(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
  } //RESEARCH: Understand this.
}