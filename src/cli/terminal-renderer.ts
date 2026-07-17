import boxen from 'boxen';
import { cwd } from 'node:process';

import {
  PipelinePass,
  PASS_LABELS,
  SELF_CORRECTION_PASSES,
  GIT_COMMIT_PASSES,
} from '../core/types.js';
import type { PipelineContext } from '../core/types.js';

export const PIPELINE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// TerminalWriter — injected abstraction over console.*  (enables snapshot tests)
// ---------------------------------------------------------------------------

export interface TerminalWriter {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleWriter: TerminalWriter = {
  log:   (msg) => console.log(msg),
  warn:  (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

// ---------------------------------------------------------------------------
// fp — path truncation utility (currently dead, retained for a future step)
// ---------------------------------------------------------------------------

export function fp(p: string, max: number): string {
  if (p.length <= max) return p.padEnd(max);
  return ('...' + p.slice(-(max - 3))).padEnd(max);
}

// ---------------------------------------------------------------------------
// TerminalRenderer — all terminal presentation through one injectable class
// ---------------------------------------------------------------------------

export class TerminalRenderer {
  readonly #w: TerminalWriter;
  readonly #boxWidth: number;

  constructor(writer: TerminalWriter = consoleWriter, boxWidth = 68) {
    this.#w = writer;
    this.#boxWidth = boxWidth;
  }

  banner(ctx: PipelineContext): void {
    const testStr = ctx.testCmd.join(' ');
    const hitl    = ctx.skipHitl ? 'disabled (--skip-hitl)' : 'enabled';

    const title = `agentic-tdd  \u2022  v${PIPELINE_VERSION} Pipeline  \u2022  8-Pass State Machine`;
    this.#w.log(
      boxen(title, {
        width:       this.#boxWidth,
        borderStyle: 'single',
        padding:     { left: 1, right: 1, top: 0, bottom: 0 },
      }),
    );

    this.#w.log(`  Input source : ${ctx.specFileAbsPath}`);
    this.#w.log(`  Source type  : ${ctx.sourceType}`);
    this.#w.log(`  Test cmd     : ${testStr}`);
    this.#w.log(`  HITL gate    : ${hitl}`);
    this.#w.log(`  Max retries  : ${ctx.maxCorrectionRetries} (per guarded pass)`);
    this.#w.log(`  CWD          : ${cwd()}`);
    this.#w.log('');
    this.#w.log('  Artefacts    : specs/<feature>.mmd, specs/<feature>.gherkin (dynamic)');
    this.#w.log('');
    this.#w.log('  Cache strategy: Static Prefix  +  Context Compaction');
    this.#w.log('');
    this.#w.log('  Pass schedule:');
    const passes = [0, 1, 2, 3, 4, 5, 6, 7] as PipelinePass[];
    for (const pass of passes) {
      const label = PASS_LABELS[pass] ?? '';
      let gate = '  <- HITL gate';
      if (SELF_CORRECTION_PASSES.has(pass))      gate = '  <- self-correction + git commit';
      else if (GIT_COMMIT_PASSES.has(pass))      gate = '  <- git commit';
      this.#w.log(`    ${pass}  ${label.padEnd(36)}${gate}`);
    }
    this.#w.log('');
  }

  passHeader(label: string): void {
    this.#w.log('');
    this.#w.log('\u2501'.repeat(this.#boxWidth));
    this.#w.log(`  ${label}`);
    this.#w.log('\u2501'.repeat(this.#boxWidth));
    this.#w.log('');
  }

  passOk(label: string): void {
    this.#w.log(`\n  \u2713  ${label} \u2014 complete.\n`);
  }

  warnBox(lines: string[]): void {
    const body = ['\u26A0  WARNING', '', ...lines].join('\n');
    this.#w.warn(
      boxen(body, {
        width:       this.#boxWidth,
        borderStyle: 'single',
        padding:     { left: 1, right: 1, top: 0, bottom: 0 },
      }),
    );
  }

  fatal(msg: string): never {
    this.#w.error(`\n[FATAL]  ${msg}\n`);
    process.exit(1);
  }

  gitInfo(msg: string): void {
    this.#w.log(`  [git]  ${msg}`);
  }

  logAttemptCount(count: number): void {
    this.#w.log(`  Completed in ${count} attempt(s).\n`);
  }

  logChangedFiles(files: ReadonlyArray<{ status: string; file: string }>): void {
    if (files.length === 0) return;
    this.#w.log(`  Files modified:`);
    for (const f of files) {
      this.#w.log(`    [${f.status}] ${f.file}`);
    }
    this.#w.log('');
  }

  logNoChanges(): void {
    this.#w.log(`  No files were changed.\n`);
  }

  logTestStatus(msg: string): void {
    this.#w.log(`  ${msg}`);
  }

  logCompaction(msg: string): void {
    this.#w.log(`  [compaction]  ${msg}`);
  }

  logWarnMessage(msg: string): void {
    this.#w.log(`  [WARN]  ${msg}`);
  }

  logErrorMessage(msg: string): void {
    this.#w.error(`  [FATAL]  ${msg}`);
  }

  logPipelineComplete(version: string): void {
    const body = [
      `v${version} Pipeline complete — all 8 passes ran successfully.`,
      '',
      'Git:  7 atomic commits created (Passes 1–7).',
      'Next: git log --oneline  to review the commit trail.',
      '      Open a PR when satisfied.',
    ].join('\n');
    this.#w.log(
      boxen(body, {
        width:       this.#boxWidth,
        borderStyle: 'single',
        padding:     { left: 1, right: 1, top: 0, bottom: 0 },
      }),
    );
  }
}
