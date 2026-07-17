#!/usr/bin/env node

import { program } from 'commander';
import { resolve, join } from 'node:path';
import { cwd } from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import { NodeFileSystem } from '../infrastructure/file-system.js';
import { GitService } from '../infrastructure/git-service.js';
import { JsonStateStore } from '../infrastructure/state-store.js';
import { getStateFilePath } from '../utils/paths.js';
import {
  PipelinePass,
  DEFAULT_MAX_CORRECTION_RETRIES,
} from '../core/types.js';
import type { PipelineContext } from '../core/types.js';
import { TerminalRenderer, PIPELINE_VERSION } from './terminal-renderer.js';
import { validateAndResolveOptions } from './validators.js';
import { createPipelineServices } from './di-container.js';
import { loggers } from '../utils/logger.js';

process.on('uncaughtException', (err) => {
  loggers.cli.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  loggers.cli.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Utility: compute artefact paths
// ---------------------------------------------------------------------------

interface ArtefactPaths {
  artefactDir: string;
  designMmdPath: string;
  specGherkinPath: string;
  testFilePath: string;
  errorLogPath: string;
}

function computeArtefactPaths(featureName: string): ArtefactPaths {
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

// ---------------------------------------------------------------------------
// Command-line setup
// ---------------------------------------------------------------------------

// DEFERRED: StateFile — see docs/statefile-design.md

program
  .name('agentic-tdd')
  .description('Agentic TDD pipeline orchestration tool')
  .version(PIPELINE_VERSION)
  .option('--feature-desc-file <path>', 'Path to the feature description file (e.g. specs/feature.md)')
  .option('--test-cmd <command>', 'Test command to run after each pass (language-specific)')
  .option('--skip-hitl', 'Skip human-in-the-loop prompts')
  .option('--base-branch <branch>', 'Base branch to create the feature branch from')
  .option('--log-level <level>', 'Log level (DEBUG, INFO, WARNING, ERROR)', 'INFO')
  .option('--resume', 'Resume an active Agentic TDD session')
  .option('--abort', 'Abort the active session and rewind Git history')
  .action(async (options: Record<string, unknown>) => {
    const renderer = new TerminalRenderer();
    // Load .env from CWD
    loadDotEnv({ path: `${cwd()}/.env`, override: false });

    // Log level is handled internally by logger.ts
    const rawLogLevel = String(options.logLevel ?? 'INFO');
    if (rawLogLevel.toUpperCase() === 'DEBUG') {
      // debug logic is initialized directly in logger.ts via process.argv
    }

    const resume = Boolean(options.resume);
    const abort = Boolean(options.abort);

    if (resume && abort) {
      renderer.fatal('Cannot use --resume and --abort together.');
    }

    if (!process.env.OPENROUTER_API_KEY) {
      renderer.fatal('OPENROUTER_API_KEY is not set.\n  Add it to your .env file:  OPENROUTER_API_KEY=sk-or-...');
    }

    const fs = new NodeFileSystem();
    const stateStore = new JsonStateStore(fs);
    const stateExists = await stateStore.exists();

    // ---------------------------------------------------------------------
    // Branch: State file exists — guard, abort, or resume
    // ---------------------------------------------------------------------
    if (stateExists) {
      if (!resume && !abort) {
        renderer.fatal('An active TDD session is in progress. Use --resume to continue or --abort to cancel.');
      }

      if (abort) {
        const ctx = await stateStore.load();
        const git = new GitService();

        if (ctx.originalBaseSha) {
          await git.abortToSha(ctx.originalBaseSha);
          console.log(`\n  Abort: rewound Git tree to original SHA ${ctx.originalBaseSha.slice(0, 8)}.\n`);
        } else {
          await git.resetWorkingTree();
          console.log('\n  Abort: reset working tree to HEAD.\n');
        }

        await stateStore.delete();
        console.log('  Session cancelled.  Repository state restored.\n');
        process.exit(0);
      }

      // --resume branch
      const ctx = await stateStore.load();
      ctx.originalBaseSha = ctx.originalBaseSha ?? undefined;
      const git = new GitService();

      await git.resetWorkingTree();
      console.log('\n  Resume: working tree cleaned.\n');

      const lastCompletedPass = await git.getLastCompletedPass();
      const startPass = lastCompletedPass !== null ? (lastCompletedPass + 1) as PipelinePass : PipelinePass.Design;

      if (startPass > PipelinePass.Documentation) {
        await stateStore.delete();
        console.log('  All passes already completed — nothing to resume.\n');
        process.exit(0);
      }

      console.log(`  Resume: fast-forwarding — last completed pass is ${lastCompletedPass}, starting at Pass ${startPass}.\n`);

      // Ensure specs/ directory exists
      await fs.mkdir(ctx.artefactDir);

      const skipHitl = Boolean(ctx.skipHitl);
      const logLevel = String(ctx.logLevel ?? 'INFO');

      renderer.banner(ctx);

      const { orchestrator } = createPipelineServices({
        ctx,
        fs,
        git,
        renderer,
        version: PIPELINE_VERSION,
      });

      try {
        await orchestrator.run(ctx, startPass);
        await stateStore.delete();
        process.exit(0);
      } catch (err) {
        renderer.fatal(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // ---------------------------------------------------------------------
    // Branch: No state file
    // ---------------------------------------------------------------------
    if (resume || abort) {
      renderer.fatal('No active TDD session found. Nothing to resume or abort.');
    }

    const opts = await validateAndResolveOptions(options, renderer);
    const sourceType = 'file';

    const paths = computeArtefactPaths(opts.featureName);

    const git = new GitService();
    const originalBaseSha = await git.getCurrentCommitSha();

    // Ensure specs/ directory exists
    await fs.mkdir(paths.artefactDir);

    console.log(`\n  Feature: ${opts.featureName}`);
    console.log('  Agents will create/modify necessary files to implement the feature.\n');

    // --- Build pipeline context ---
    const ctx: PipelineContext = {
      featureName: opts.featureName,
      testCmd: opts.testCmd,
      skipHitl: opts.skipHitl,
      maxCorrectionRetries: DEFAULT_MAX_CORRECTION_RETRIES,
      pipelineVersion: PIPELINE_VERSION,
      sourceType,
      logLevel: opts.logLevel,
      specFileAbsPath: opts.specFileAbsPath,
      featureDescription: opts.featureDescription,
      baseBranch: opts.baseBranch,
      originalBaseSha,
      ...paths,
    };

    // --- Persist state file ---
    await stateStore.save(ctx);
    console.log(`  [git]  Saved baseline SHA ${originalBaseSha.slice(0, 8)} to ${getStateFilePath()}.\n`);

    // --- Display banner ---
    renderer.banner(ctx);

    // --- Wire DI ---
    const { orchestrator } = createPipelineServices({
      ctx,
      fs,
      git,
      renderer,
      version: PIPELINE_VERSION,
    });

    try {
      await orchestrator.run(ctx, PipelinePass.Design);
      await stateStore.delete();
      process.exit(0);
    } catch (err) {
      renderer.fatal(err instanceof Error ? err.message : String(err));
    }
  });

program.parse(process.argv);