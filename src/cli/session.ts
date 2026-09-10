import { resolve, join } from 'node:path';
import { cwd } from 'node:process';
import { createInterface } from 'node:readline';

import { PipelinePass, DEFAULT_MAX_CORRECTION_RETRIES } from '../core/types.js';
import type { PipelineContext } from '../core/types.js';
import type { IAgentServerHandle, IFileSystem, IGitService, IStateStore } from '../core/interfaces.js';
import type { PipelineOrchestrator } from '../core/orchestrator.js';
import { TerminalRenderer } from './terminal-renderer.js';
import type { ValidatedOptions } from './validators.js';
import { createPipelineServices } from './di-container.js';
import { runWithServer } from './run-with-server.js';
import { resolveModelConfig } from './model-config.js';
import { getErrorLogPath } from '../utils/paths.js';
import type { AgentBackend } from '../infrastructure/agent-runners/index.js';
import { writeMcpConfig, teardownMcpConfig, getMcpTemplateDir } from '../infrastructure/mcp-config.js';
import type { McpConfigResult } from '../infrastructure/mcp-config.js';
import { ensureIndexerAccess } from '../infrastructure/indexer-gate.js';
import type { IndexerGateResult } from '../infrastructure/indexer-gate.js';
import type { ModelConfig } from './model-config.js';
import { PinoLoggerAdapter } from '../infrastructure/pino-logger.js';
import { loggers } from '../utils/logger.js';

let activeOrchestrator: PipelineOrchestrator | undefined;

export function getActiveOrchestrator(): PipelineOrchestrator | undefined {
  return activeOrchestrator;
}

function isPiBackend(backend: AgentBackend | undefined): boolean {
  return backend === 'pi';
}

async function setupMcpConfig(fs: IFileSystem): Promise<McpConfigResult> {
  const templatePath = resolve(getMcpTemplateDir(), 'mcp.template.json');
  const mcpLogger = new PinoLoggerAdapter(loggers.core);
  return writeMcpConfig(fs, mcpLogger, cwd(), templatePath);
}

/**
 * Run the mandatory indexer gate. On the default `opencode` backend the gate
 * also starts the shared opencode server and returns its handle. Any failure
 * is fatal before a pass dispatches.
 */
async function runIndexerGate(
  fs: IFileSystem,
  git: IGitService,
  renderer: TerminalRenderer,
  backend: AgentBackend | undefined,
  modelConfig: ModelConfig,
): Promise<IndexerGateResult> {
  const logger = new PinoLoggerAdapter(loggers.core);
  const result = await ensureIndexerAccess({
    fs,
    git,
    logger,
    backend,
    workDir: cwd(),
    modelConfig,
  });
  if (!result.ok) {
    renderer.fatal(result.message);
  }
  return result;
}

async function teardownMcp(mcpResult: McpConfigResult, fs: IFileSystem): Promise<void> {
  const mcpLogger = new PinoLoggerAdapter(loggers.core);
  await teardownMcpConfig(fs, mcpLogger, cwd(), mcpResult);
}

export interface ArtefactPaths {
  artefactDir: string;
  designMmdPath: string;
  specGherkinPath: string;
  testFilePath: string;
  errorLogPath: string;
}

export function computeArtefactPaths(featureName: string): ArtefactPaths {
  const specsDir = resolve(cwd(), 'specs');
  const tmpTs = Date.now();
  return {
    artefactDir: specsDir,
    designMmdPath: join(specsDir, `${featureName}-${tmpTs}.mmd`),
    specGherkinPath: join(specsDir, `${featureName}-${tmpTs}.gherkin`),
    testFilePath: join(cwd(), 'test', `${featureName}.test.ts`),
    errorLogPath: getErrorLogPath(featureName),
  };
}

export async function abortSession(
  stateStore: IStateStore,
  git: IGitService,
): Promise<never> {
  const ctx = await stateStore.load();

  if (ctx.originalBaseSha) {
    await git.abortToSha(ctx.originalBaseSha);
    console.log(
      `\n  Abort: rewound Git tree to original SHA ${ctx.originalBaseSha.slice(0, 8)}.\n`,
    );
  } else {
    await git.resetWorkingTree();
    console.log('\n  Abort: reset working tree to HEAD.\n');
  }

  await stateStore.delete();
  console.log('  Session cancelled.  Repository state restored.\n');
  process.exit(0);
}

/**
 * Run the orchestrator for one session entry point with guaranteed server
 * teardown. `.mcp.json` is only materialised/torn down for the pi backend.
 */
async function runPipeline(
  orchestrator: PipelineOrchestrator,
  ctx: PipelineContext,
  startPass: PipelinePass,
  server: IAgentServerHandle | undefined,
  mcpResult: McpConfigResult | undefined,
  stateStore: IStateStore,
  fs: IFileSystem,
  renderer: TerminalRenderer,
): Promise<void> {
  activeOrchestrator = orchestrator;
  try {
    await runWithServer(server, async () => {
      await orchestrator.run(ctx, startPass);
    });
    if (mcpResult !== undefined) await teardownMcp(mcpResult, fs);
    await stateStore.delete();
    activeOrchestrator = undefined;
    process.exit(0);
  } catch (err) {
    activeOrchestrator = undefined;
    renderer.fatal(err instanceof Error ? err.message : String(err));
  }
}

export async function resumeSession(
  stateStore: IStateStore,
  fs: IFileSystem,
  git: IGitService,
  renderer: TerminalRenderer,
  version: string,
  noContextEnrich?: boolean,
  model?: string,
  configPath?: string,
  backend?: string,
): Promise<void> {
  const ctx = await stateStore.load();
  ctx.originalBaseSha = ctx.originalBaseSha ?? undefined;

  const modelConfig = await resolveModelConfig(
    { model, configPath },
    { userPath: resolve(cwd(), '.agentic-tdd/config.json'), fs },
  );

  const typedBackend = backend as AgentBackend | undefined;
  const snap = ctx.xstateSnapshot as Record<string, unknown> | undefined;
  const isPaused: boolean = snap?.status === 'active' && snap?.value === 'paused';

  if (isPaused) {
    await fs.mkdir(ctx.artefactDir);
    renderer.banner(ctx);

    const mcpResult = isPiBackend(typedBackend) ? await setupMcpConfig(fs) : undefined;
    const gateResult = await runIndexerGate(fs, git, renderer, typedBackend, modelConfig);
    const { orchestrator } = createPipelineServices({
      ctx,
      fs,
      git,
      renderer,
      version,
      stateStore,
      noContextEnrich,
      modelConfig,
      backend: typedBackend,
      agentServer: gateResult.ok ? gateResult.server : undefined,
    });

    await runPipeline(
      orchestrator,
      ctx,
      ctx.currentPass ?? PipelinePass.Design,
      gateResult.ok ? gateResult.server : undefined,
      mcpResult,
      stateStore,
      fs,
      renderer,
    );
    return;
  }

  await git.resetWorkingTree();
  console.log('\n  Resume: working tree cleaned.\n');

  let startPass: PipelinePass;
  let lastCompletedPass: number | null = null;

  if (ctx.currentPass !== undefined && Object.keys(ctx.history).length > 0) {
    const entry = ctx.history[ctx.currentPass];
    if (entry?.status === 'completed') {
      lastCompletedPass = ctx.currentPass;
      startPass = (ctx.currentPass + 1) as PipelinePass;
    } else {
      startPass = ctx.currentPass;
    }
  } else {
    lastCompletedPass = null;
    startPass = PipelinePass.Design;
  }

  if (startPass > PipelinePass.Documentation) {
    await stateStore.delete();
    console.log('  All passes already completed — nothing to resume.\n');
    process.exit(0);
  }

  console.log(
    `  Resume: fast-forwarding — last completed pass is ${lastCompletedPass}, starting at Pass ${startPass}.\n`,
  );

  await fs.mkdir(ctx.artefactDir);

  renderer.banner(ctx);

  const mcpResult = isPiBackend(typedBackend) ? await setupMcpConfig(fs) : undefined;
  const gateResult = await runIndexerGate(fs, git, renderer, typedBackend, modelConfig);
  const { orchestrator } = createPipelineServices({
    ctx,
    fs,
    git,
    renderer,
    version,
    stateStore,
    noContextEnrich,
    modelConfig,
    backend: typedBackend,
    agentServer: gateResult.ok ? gateResult.server : undefined,
  });

  await runPipeline(
    orchestrator,
    ctx,
    startPass,
    gateResult.ok ? gateResult.server : undefined,
    mcpResult,
    stateStore,
    fs,
    renderer,
  );
}

export async function startNewSession(
  options: ValidatedOptions,
  stateStore: IStateStore,
  fs: IFileSystem,
  git: IGitService,
  renderer: TerminalRenderer,
  version: string,
  noContextEnrich?: boolean,
  backend?: string,
): Promise<void> {
  const paths = computeArtefactPaths(options.featureName);

  const promptUser = async (question: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<boolean>((resolve) => {
      rl.question(question + ' ', (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  };

  const branchOutcome = await git.createFeatureBranch(
    options.featureName,
    options.baseBranch ?? null,
    options.skipHitl,
    promptUser,
  );

  if (
    branchOutcome.kind === 'abort_dirty' ||
    branchOutcome.kind === 'abort_main' ||
    branchOutcome.kind === 'abort_user_declined'
  ) {
    renderer.fatal(branchOutcome.message);
  }
  renderer.gitInfo(`Switched to branch ${branchOutcome.branch} [${branchOutcome.kind}]`);

  const originalBaseSha = await git.getCurrentCommitSha();

  await fs.mkdir(paths.artefactDir);

  console.log(`\n  Feature: ${options.featureName}`);
  console.log(
    '  Agents will create/modify necessary files to implement the feature.\n',
  );

  const ctx: PipelineContext = {
    featureName: options.featureName,
    testCmd: options.testCmd,
    skipHitl: options.skipHitl,
    maxCorrectionRetries: DEFAULT_MAX_CORRECTION_RETRIES,
    pipelineVersion: version,
    sourceType: 'file',
    logLevel: options.logLevel,
    specFileAbsPath: options.specFileAbsPath,
    featureDescription: options.featureDescription,
    baseBranch: options.baseBranch,
    originalBaseSha,
    history: {},
    ...paths,
  };

  await stateStore.save(ctx);
  console.log(
    `  [git]  Saved baseline SHA ${originalBaseSha.slice(0, 8)} to ${stateStore.path}.\n`,
  );

  renderer.banner(ctx);

  const modelConfig = await resolveModelConfig(
    { model: options.model, configPath: options.configPath },
    { userPath: resolve(cwd(), '.agentic-tdd/config.json'), fs },
  );

  const typedBackend = backend as AgentBackend | undefined;
  const mcpResult = isPiBackend(typedBackend) ? await setupMcpConfig(fs) : undefined;
  const gateResult = await runIndexerGate(fs, git, renderer, typedBackend, modelConfig);
  const { orchestrator } = createPipelineServices({
    ctx,
    fs,
    git,
    renderer,
    version,
    stateStore,
    noContextEnrich,
    modelConfig,
    backend: typedBackend,
    agentServer: gateResult.ok ? gateResult.server : undefined,
  });

  await runPipeline(
    orchestrator,
    ctx,
    PipelinePass.Design,
    gateResult.ok ? gateResult.server : undefined,
    mcpResult,
    stateStore,
    fs,
    renderer,
  );
}
