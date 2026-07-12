#!/usr/bin/env node

import { program } from 'commander';
import { resolve, join, basename, extname } from 'node:path';
import { cwd } from 'node:process';
import { createInterface } from 'node:readline';
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
  SELF_CORRECTION_PASSES,
  GIT_COMMIT_PASSES,
  DEFAULT_MAX_CORRECTION_RETRIES,
} from '../core/types.js';
import type { PipelineContext, AgenticEvent } from '../core/types.js';
import type { PipelineConfig } from '../core/interfaces.js';
import type { HitlHandler } from '../core/orchestrator.js';
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

const PIPELINE_VERSION = '1.0.0';
const W = 68;

// ---------------------------------------------------------------------------
// Terminal helpers — mirror Python _banner / _pass_header / _pass_ok / etc.
// ---------------------------------------------------------------------------

function banner(ctx: PipelineContext): void {
  const testStr = ctx.testCmd.join(' ');
  const hitl = ctx.skipHitl ? 'disabled (--skip-hitl)' : 'enabled';
  const source = ctx.specFileAbsPath;
  console.log('');
  console.log('┌' + '─'.repeat(W) + '┐');
  console.log(`│  agentic-tdd  •  v${PIPELINE_VERSION} Pipeline  •  8-Pass State Machine`.padEnd(W + 1) + '│');
  console.log('└' + '─'.repeat(W) + '┘');
  console.log('');
  console.log(`  Input source : ${source}`);
  console.log(`  Source type  : ${ctx.sourceType}`);
  console.log(`  Test cmd     : ${testStr}`);
  console.log(`  HITL gate    : ${hitl}`);
  console.log(`  Max retries  : ${ctx.maxCorrectionRetries} (per guarded pass)`);
  console.log(`  CWD          : ${cwd()}`);
  console.log('');
  const artefactsStr = 'specs/<feature>.mmd, specs/<feature>.gherkin (dynamic)';
  console.log(`  Artefacts    : ${artefactsStr}`);
  console.log('');
  console.log('  Cache strategy: Static Prefix  +  Context Compaction');
  console.log('');
  console.log('  Pass schedule:');
  const passes = [0, 1, 2, 3, 4, 5, 6, 7] as PipelinePass[];
  for (const pass of passes) {
    const label = PASS_LABELS[pass];
    let gate = '  <- HITL gate';
    if (SELF_CORRECTION_PASSES.has(pass)) gate = '  <- self-correction + git commit';
    else if (GIT_COMMIT_PASSES.has(pass)) gate = '  <- git commit';
    console.log(`    ${pass}  ${label.padEnd(36)}${gate}`);
  }
  console.log('');
}

function passHeader(label: string): void {
  console.log('');
  console.log('━'.repeat(W));
  console.log(`  ${label}`);
  console.log('━'.repeat(W));
  console.log('');
}

function passOk(label: string): void {
  console.log(`\n  ✓  ${label} — complete.\n`);
}

function warnBox(lines: string[]): void {
  console.warn('');
  console.warn('┌' + '─'.repeat(W) + '┐');
  console.warn('│  ⚠  WARNING'.padEnd(W + 1) + '│');
  console.warn('│' + ' '.repeat(W) + '│');
  for (const line of lines) {
    console.warn(('│  ' + line).padEnd(W + 1) + '│');
  }
  console.warn('│' + ' '.repeat(W) + '│');
  console.warn('└' + '─'.repeat(W) + '┘');
  console.warn('');
}

function fatal(msg: string): void {
  console.error(`\n[FATAL]  ${msg}\n`);
  process.exit(1);
}

/**
 * Read the feature spec file at `specPath` and return its contents.
 * Exits immediately with a [FATAL] message if the file does not exist.
 */
async function readSpecFile(specPath: string): Promise<string> {
  const abs = resolve(cwd(), specPath);
  try {
    return await readFile(abs, 'utf-8');
  } catch {
    fatal(`Spec file not found: '${abs}'`);
    return ''; // unreachable — fatal() calls process.exit(1)
  }
}

function gitInfo(msg: string): void {
  console.log(`  [git]  ${msg}`);
}

function fp(p: string, max: number): string {
  if (p.length <= max) return p.padEnd(max);
  return ('...' + p.slice(-(max - 3))).padEnd(max);
}

// ---------------------------------------------------------------------------
// HITL handler factory
// ---------------------------------------------------------------------------

function createHitlHandler(ctx: PipelineContext): HitlHandler {
  return async () => {
    const mmd = ctx.designMmdPath;
    const gh = ctx.specGherkinPath;
    const max = W - 10;

    const fmt = (p: string) => p.length > max ? '...' + p.slice(-(max - 3)) : p;

    console.log('');
    console.log('┌' + '─'.repeat(W) + '┐');
    console.log('│  HUMAN-IN-THE-LOOP GATE (After Pass 0)                        │');
    console.log('│  Review the design artefacts before any code is written.      │');
    console.log('│' + ' '.repeat(W) + '│');
    console.log(`│  1. Mermaid diagram  ->  ${fmt(mmd).padEnd(max)}│`);
    console.log(`│  2. Gherkin spec     ->  ${fmt(gh).padEnd(max)}│`);
    console.log('│' + ' '.repeat(W) + '│');
    console.log('│  Tip: VS Code + \'Mermaid Preview\' extension to render .mmd    │');
    console.log('│  Press Ctrl+C to abort -- no code will be written.             │');
    console.log('└' + '─'.repeat(W) + '┘');
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
      rl.question('  Press Enter to approve and advance to Pass 1 (Contracts)...  ', () => {
        rl.close();
        resolve();
      });
    });
    rl.close();
    console.log('\n  Design approved.  Continuing to Pass 1 (Contracts & Types)...\n');
  };
}

// ---------------------------------------------------------------------------
// Terminal event listener — subscribes to EventBus for structured logging
// ---------------------------------------------------------------------------

function attachTerminalListener(events: EventBus): void {
  events.on('PIPELINE_STARTED', (evt: AgenticEvent) => {
    loggers.core.info(`PIPELINE_STARTED: ${evt.message}`);
  });

  events.on('PASS_STARTED', (evt: AgenticEvent) => {
    const p = evt.pass ?? 0;
    const label = PASS_LABELS[p] ?? '';
    const agents = [
      'pass-0-design-agent', 'pass-1-contracts-agent', 'pass-2-test-generation-agent',
      'pass-3-core-implementation-agent', 'pass-4-refactor-agent', 'pass-5-security-agent',
      'pass-6-observability-agent', 'pass-7-documentation-agent',
    ];
    passHeader(`Pass ${p} -- ${label}  [${agents[p] ?? ''}]`);
  });

  events.on('PASS_COMPLETED', (evt: AgenticEvent) => {
    const label = evt.pass !== undefined ? PASS_LABELS[evt.pass] : '';
    passOk(`Pass ${evt.pass} -- ${label}`);

    if (evt.payload) {
      if (evt.payload.attempts !== undefined) {
        console.log(`  Completed in ${evt.payload.attempts} attempt(s).\n`);
      }
      
      const files = evt.payload.files as { status: string; file: string }[];
      if (files && files.length > 0) {
        console.log(`  Files modified:`);
        for (const f of files) {
          console.log(`    [${f.status}] ${f.file}`);
        }
        console.log('');
      } else if (evt.pass && evt.pass >= PipelinePass.Refactor && evt.pass <= PipelinePass.Security) {
        console.log(`  No files were changed.\n`);
      }
    }
  });

  events.on('TEST_RUN_STARTED', (evt: AgenticEvent) => {
    console.log(`  ${evt.message}`);
  });

  events.on('TEST_RUN_COMPLETED', (evt: AgenticEvent) => {
    console.log(`  ${evt.message}`);
  });

  events.on('TEST_RUN_FAILED', (evt: AgenticEvent) => {
    console.log(`  ${evt.message}`);
  });

  events.on('SELF_CORRECTION_ATTEMPTED', (evt: AgenticEvent) => {
    console.log(`  [compaction]  ${evt.message}`);
  });

  events.on('WARNING', (evt: AgenticEvent) => {
    console.log(`  [WARN]  ${evt.message}`);
  });

  events.on('ERROR', (evt: AgenticEvent) => {
    console.error(`  [FATAL]  ${evt.message}`);
  });

  events.on('PIPELINE_COMPLETED', (_: AgenticEvent) => {
    console.log('');
    console.log('┌' + '─'.repeat(W) + '┐');
    console.log(`│  v${PIPELINE_VERSION} Pipeline complete -- all 8 passes ran successfully.`.padEnd(W + 1) + '│');
    console.log('│' + ' '.repeat(W) + '│');
    console.log('│  Git:  7 atomic commits created (Passes 1-7).'.padEnd(W + 1) + '│');
    console.log('│  Next: git log --oneline  to review the commit trail.'.padEnd(W + 1) + '│');
    console.log('│        Open a PR when satisfied.'.padEnd(W + 1) + '│');
    console.log('└' + '─'.repeat(W) + '┘');
    console.log('');
  });
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
      fatal('Cannot use --resume and --abort together.');
    }

    if (!process.env.OPENROUTER_API_KEY) {
      fatal('OPENROUTER_API_KEY is not set.\n  Add it to your .env file:  OPENROUTER_API_KEY=sk-or-...');
    }

    const fs = new NodeFileSystem();
    const stateStore = new JsonStateStore(fs);
    const stateExists = await stateStore.exists();

    // ---------------------------------------------------------------------
    // Branch: State file exists — guard, abort, or resume
    // ---------------------------------------------------------------------
    if (stateExists) {
      if (!resume && !abort) {
        fatal('An active TDD session is in progress. Use --resume to continue or --abort to cancel.');
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

      banner(ctx);

      const events = new EventBus();
      attachTerminalListener(events);

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
        fatal(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // ---------------------------------------------------------------------
    // Branch: No state file
    // ---------------------------------------------------------------------
    if (resume || abort) {
      fatal('No active TDD session found. Nothing to resume or abort.');
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
    const featureDescription = await readSpecFile(specFileAbsPath);


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
    banner(ctx);

    // --- Wire DI ---
    const events = new EventBus();
    attachTerminalListener(events);

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
      fatal(err instanceof Error ? err.message : String(err));
    }
  });

program.parse(process.argv);