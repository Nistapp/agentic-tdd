#!/usr/bin/env node

import { program } from 'commander';
import { cwd } from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import { NodeFileSystem } from '../infrastructure/file-system.js';
import { GitService } from '../infrastructure/git-service.js';
import { JsonStateStore } from '../infrastructure/state-store.js';
import { TerminalRenderer, PIPELINE_VERSION } from './terminal-renderer.js';
import { validateAndResolveOptions } from './validators.js';
import { loggers } from '../utils/logger.js';
import {
  abortSession,
  resumeSession,
  startNewSession,
  getActiveOrchestrator,
} from './session.js';

process.on('uncaughtException', (err) => {
  loggers.cli.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  loggers.cli.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});

let sigintCount = 0;
let sigintTimer: ReturnType<typeof setTimeout> | undefined;

process.on('SIGINT', async () => {
  sigintCount++;

  if (sigintCount === 1) {
    console.log(
      '\n  Gracefully pausing after the current pass completes. Press Ctrl+C again to force exit.\n',
    );

    sigintTimer = setTimeout(() => {
      sigintCount = 0;
    }, 2000);

    try {
      const orchestrator = getActiveOrchestrator();
      if (orchestrator) {
        await orchestrator.pause();
      }
      process.exit(0);
    } catch {
      process.exit(130);
    }
  } else {
    if (sigintTimer !== undefined) {
      clearTimeout(sigintTimer);
    }
    process.exit(130);
  }
});

// ---------------------------------------------------------------------------
// Command-line setup
// ---------------------------------------------------------------------------

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
    loadDotEnv({ path: `${cwd()}/.env`, override: false });

    const resume = Boolean(options.resume);
    const abort = Boolean(options.abort);

    if (resume && abort) {
      renderer.fatal('Cannot use --resume and --abort together.');
    }

    if (!process.env.OPENROUTER_API_KEY) {
      renderer.fatal('OPENROUTER_API_KEY is not set.\n  Add it to your .env file:  OPENROUTER_API_KEY=sk-or-...');
    }

    const fs = new NodeFileSystem();
    const git = new GitService();
    const opts = await validateAndResolveOptions(options, renderer);
    const stateStore = new JsonStateStore(fs, opts.featureName);

    if (resume || abort) {
      const stateExists = await stateStore.exists();
      if (!stateExists) {
        renderer.fatal('No active TDD session found. Nothing to resume or abort.');
      }

      if (abort) {
        await abortSession(stateStore, git);
      }

      await resumeSession(stateStore, fs, git, renderer, PIPELINE_VERSION);
      return;
    }

    const stateExists = await stateStore.exists();
    if (stateExists) {
      renderer.fatal('An active TDD session is in progress. Use --resume to continue or --abort to cancel.');
    }

    await startNewSession(opts, stateStore, fs, git, renderer, PIPELINE_VERSION);
  });

program.parse(process.argv);
