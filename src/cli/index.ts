#!/usr/bin/env node

import { program } from 'commander';
import { resolve, join, basename, extname } from 'node:path';
import { cwd } from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';

import { PipelineOrchestrator } from '../core/orchestrator.js';
import { NodeFileSystem } from '../infrastructure/file-system.js';
import { GitService } from '../infrastructure/git-service.js';
import { CommandRunner } from '../infrastructure/command-runner.js';
import { OpenCodeAgentRunner } from '../infrastructure/open-code-agent-runner.js';
import { SelfCorrectionRunner } from '../core/runners/self-correction-runner.js';
import { EventBus } from '../infrastructure/event-bus.js';
import { JsonStateStore } from '../infrastructure/state-store.js';
import { getStateFilePath, getOpencodeLogPath } from '../utils/paths.js';
import {
  PipelinePass,
  PASS_LABELS,
  DEFAULT_MAX_CORRECTION_RETRIES,
} from '../core/types.js';
import type { PipelineContext, AgenticEvent } from '../core/types.js';
import { TerminalRenderer, PIPELINE_VERSION } from './terminal-renderer.js';
import { attachTerminalListener } from './terminal-event-listener.js';
import type { PipelineConfig } from '../core/interfaces.js';
import { createHitlHandler } from './hitl-handler.js';
import { PinoLoggerAdapter } from '../infrastructure/pino-logger.js';
import { loggers } from '../utils/logger.js';

process.on('uncaughtException', (err) => {
  loggers.cli.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  loggers.cli.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});

/**
 * Read the feature spec file at `specPath` and return its contents.
 * Exits immediately with a [FATAL] message if the file does not exist.
 */
async function readSpecFile(specPath: string, renderer: TerminalRenderer): Promise<string> {
  const abs = resolve(cwd(), specPath);
  try {
    return await readFile(abs, 'utf-8');
  } catch {
    renderer.fatal(`Spec file not found: '${abs}'`);
    return ''; // unreachable
  }
}
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
    const W = 68;
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

      const events = new EventBus();
      attachTerminalListener(events, renderer, PIPELINE_VERSION);

      const cmdRunner = new CommandRunner();
      const hitlHandler = createHitlHandler(ctx);

      const pipelineConfig: PipelineConfig = {
        opencodeLogPath: getOpencodeLogPath(),
        apiKeySet: process.env.OPENROUTER_API_KEY ? 'present' : 'missing',
      };

      const agentRunner = new OpenCodeAgentRunner(fs, new PinoLoggerAdapter(loggers.core), pipelineConfig, cmdRunner);

      const selfCorrectionRunner = new SelfCorrectionRunner(
        agentRunner, cmdRunner, git, fs, events, new PinoLoggerAdapter(loggers.core),
      );

      const orchestrator = new PipelineOrchestrator(git, fs, cmdRunner, agentRunner, selfCorrectionRunner, events, new PinoLoggerAdapter(loggers.core), pipelineConfig, hitlHandler);

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

    // -- New run: validate both required flags before doing any work
    if (!options.featureDescFile) {
      console.error('');
      console.error('┌' + '─'.repeat(W) + '┐');
      console.error('│  ✖  MISSING REQUIRED ARGUMENT: --feature-desc-file'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│  Point this flag at the markdown file that describes the      '.padEnd(W + 1) + '│');
      console.error('│  feature you want the pipeline to implement.                  '.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│  Usage:'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│    agentic-tdd --feature-desc-file <path> --test-cmd <cmd>    '.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│  Examples:'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│    agentic-tdd --feature-desc-file specs/auth.md \\'.padEnd(W + 1) + '│');
      console.error('│               --test-cmd "pytest"'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│    agentic-tdd --feature-desc-file specs/search.md \\'.padEnd(W + 1) + '│');
      console.error('│               --test-cmd "npm test"'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('└' + '─'.repeat(W) + '┘');
      console.error('');
      process.exit(1);
    }

    // Resolve test command — required for the pipeline to know how to run tests
    if (!options.testCmd) {
      console.error('');
      console.error('┌' + '─'.repeat(W) + '┐');
      console.error('│  ✖  MISSING REQUIRED ARGUMENT: --test-cmd'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│  The test command is language-specific and must be provided   '.padEnd(W + 1) + '│');
      console.error('│  explicitly so the pipeline knows how to run your test suite. '.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│  Examples by language / ecosystem:'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('│    Python  →  --test-cmd "pytest"'.padEnd(W + 1) + '│');
      console.error('│    Python  →  --test-cmd "python -m pytest"'.padEnd(W + 1) + '│');
      console.error('│    Node    →  --test-cmd "npm test"'.padEnd(W + 1) + '│');
      console.error('│    Node    →  --test-cmd "npx vitest run"'.padEnd(W + 1) + '│');
      console.error('│    Go      →  --test-cmd "go test ./..."'.padEnd(W + 1) + '│');
      console.error('│    Java    →  --test-cmd "mvn test"'.padEnd(W + 1) + '│');
      console.error('│    Java    →  --test-cmd "./gradlew test"'.padEnd(W + 1) + '│');
      console.error('│    Ruby    →  --test-cmd "bundle exec rspec"'.padEnd(W + 1) + '│');
      console.error('│    Rust    →  --test-cmd "cargo test"'.padEnd(W + 1) + '│');
      console.error('│' + ' '.repeat(W) + '│');
      console.error('└' + '─'.repeat(W) + '┘');
      console.error('');
      process.exit(1);
    }

    const skipHitl = Boolean(options.skipHitl);
    const logLevel = String(options.logLevel ?? 'INFO');
    const specFileAbsPath = resolve(cwd(), String(options.featureDescFile));
    const baseBranch = options.baseBranch ? String(options.baseBranch) : undefined;
    const sourceType = 'file';

    // Read spec file — exits immediately if the file does not exist
    const featureDescription = await readSpecFile(specFileAbsPath, renderer);


    const testCmd = String(options.testCmd).split(/\s+/);

    // Extract featureName from specFile
    const featureName = basename(specFileAbsPath, extname(specFileAbsPath));

    // Compute artefact paths
    const paths = computeArtefactPaths(featureName);

    const git = new GitService();
    const originalBaseSha = await git.getCurrentCommitSha();

    // Ensure specs/ directory exists
    await fs.mkdir(paths.artefactDir);

    console.log(`\n  Feature: ${featureName}`);
    console.log('  Agents will create/modify necessary files to implement the feature.\n');

    // --- Build pipeline context ---
    const ctx: PipelineContext = {
      featureName,
      testCmd,
      skipHitl,
      maxCorrectionRetries: DEFAULT_MAX_CORRECTION_RETRIES,
      pipelineVersion: PIPELINE_VERSION,
      sourceType,
      logLevel,
      specFileAbsPath,
      featureDescription,
      baseBranch,
      originalBaseSha,
      ...paths,
    };

    // --- Persist state file ---
    await stateStore.save(ctx);
    console.log(`  [git]  Saved baseline SHA ${originalBaseSha.slice(0, 8)} to ${getStateFilePath()}.\n`);

    // --- Display banner ---
    renderer.banner(ctx);

    // --- Wire DI ---
    const events = new EventBus();
    attachTerminalListener(events, renderer, PIPELINE_VERSION);

    const cmdRunner = new CommandRunner();
    const hitlHandler = createHitlHandler(ctx);

    const pipelineConfig: PipelineConfig = {
      opencodeLogPath: getOpencodeLogPath(),
      apiKeySet: process.env.OPENROUTER_API_KEY ? 'present' : 'missing',
    };

    const agentRunner = new OpenCodeAgentRunner(fs, new PinoLoggerAdapter(loggers.core), pipelineConfig, cmdRunner);

    const selfCorrectionRunner = new SelfCorrectionRunner(
      agentRunner, cmdRunner, git, fs, events, new PinoLoggerAdapter(loggers.core),
    );

    const orchestrator = new PipelineOrchestrator(git, fs, cmdRunner, agentRunner, selfCorrectionRunner, events, new PinoLoggerAdapter(loggers.core), pipelineConfig, hitlHandler);

    try {
      await orchestrator.run(ctx, PipelinePass.Design);
      await stateStore.delete();
      process.exit(0);
    } catch (err) {
      renderer.fatal(err instanceof Error ? err.message : String(err));
    }
  });

program.parse(process.argv);