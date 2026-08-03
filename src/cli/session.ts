import { resolve, join } from 'node:path';
import { cwd } from 'node:process';

import { PipelinePass, DEFAULT_MAX_CORRECTION_RETRIES } from '../core/types.js';
import type { PipelineContext } from '../core/types.js';
import type { IFileSystem, IGitService, IStateStore } from '../core/interfaces.js';
import type { PipelineOrchestrator } from '../core/orchestrator.js';
import { TerminalRenderer } from './terminal-renderer.js';
import type { ValidatedOptions } from './validators.js';
import { createPipelineServices } from './di-container.js';

let activeOrchestrator: PipelineOrchestrator | undefined;

export function getActiveOrchestrator(): PipelineOrchestrator | undefined {
  return activeOrchestrator;
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
    errorLogPath: join(specsDir, '.opencode_error.log'),
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

export async function resumeSession(
  stateStore: IStateStore,
  fs: IFileSystem,
  git: IGitService,
  renderer: TerminalRenderer,
  version: string,
): Promise<void> {
  const ctx = await stateStore.load();
  ctx.originalBaseSha = ctx.originalBaseSha ?? undefined;

  const snap = ctx.xstateSnapshot as Record<string, unknown> | undefined;
  const isPaused: boolean = snap?.status === 'active' && snap?.value === 'paused';

  let startPass: PipelinePass;
  let lastCompletedPass: number | null = null;

  if (isPaused) {
    await fs.mkdir(ctx.artefactDir);
    renderer.banner(ctx);

    const { orchestrator } = createPipelineServices({
      ctx,
      fs,
      git,
      renderer,
      version,
      stateStore,
    });

    activeOrchestrator = orchestrator;

    try {
      await orchestrator.run(ctx);
      await stateStore.delete();
      activeOrchestrator = undefined;
      process.exit(0);
    } catch (err) {
      renderer.fatal(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  await git.resetWorkingTree();
  console.log('\n  Resume: working tree cleaned.\n');

  if (ctx.currentPass !== undefined && Object.keys(ctx.history).length > 0) {
    const entry = ctx.history[ctx.currentPass];
    if (entry?.status === 'completed') {
      lastCompletedPass = ctx.currentPass;
      startPass = (ctx.currentPass + 1) as PipelinePass;
    } else if (entry?.status === 'failed') {
      startPass = ctx.currentPass;
    } else {
      startPass = ctx.currentPass;
    }
  } else {
    lastCompletedPass = await git.getLastCompletedPass();
    startPass =
      lastCompletedPass !== null
        ? ((lastCompletedPass + 1) as PipelinePass)
        : PipelinePass.Design;
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

  const { orchestrator } = createPipelineServices({
    ctx,
    fs,
    git,
    renderer,
    version,
    stateStore,
  });

  activeOrchestrator = orchestrator;

  try {
    await orchestrator.run(ctx, startPass);
    await stateStore.delete();
    activeOrchestrator = undefined;
    process.exit(0);
  } catch (err) {
    activeOrchestrator = undefined;
    renderer.fatal(err instanceof Error ? err.message : String(err));
  }
}

export async function startNewSession(
  options: ValidatedOptions,
  stateStore: IStateStore,
  fs: IFileSystem,
  git: IGitService,
  renderer: TerminalRenderer,
  version: string,
): Promise<void> {
  const paths = computeArtefactPaths(options.featureName);
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

  const { orchestrator } = createPipelineServices({
    ctx,
    fs,
    git,
    renderer,
    version,
    stateStore,
  });

  activeOrchestrator = orchestrator;

  try {
    await orchestrator.run(ctx, PipelinePass.Design);
    await stateStore.delete();
    activeOrchestrator = undefined;
    process.exit(0);
  } catch (err) {
    activeOrchestrator = undefined;
    renderer.fatal(err instanceof Error ? err.message : String(err));
  }
}
