import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

import type { PipelineContext, FileChange } from '../core/types.js';
import { PipelinePass } from '../core/types.js';
import type { HitlHandler } from '../core/orchestrator.js';

export type ReadlineFactory = (opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}) => Interface;

export function createHitlHandler(
  ctx: PipelineContext,
  createRl: ReadlineFactory = createInterface,
  write: (msg: string) => void = console.log,
): HitlHandler {
  const W = 68;

  return async (pass: PipelinePass = PipelinePass.Design, files: FileChange[] = []) => {
    if (pass === PipelinePass.TestGeneration) {
      await renderTestGenerationHitl(ctx, files, W, createRl, write);
    } else {
      await renderDesignHitl(ctx, W, createRl, write);
    }
  };
}

async function renderDesignHitl(
  ctx: PipelineContext,
  W: number,
  createRl: ReadlineFactory,
  write: (msg: string) => void,
): Promise<void> {
  const mmd = ctx.designMmdPath;
  const gh = ctx.specGherkinPath;
  const max = W - 10;

  const fmt = (p: string) => p.length > max ? '...' + p.slice(-(max - 3)) : p;

  write('');
  write('\u250C' + '\u2500'.repeat(W) + '\u2510');
  write('\u2502  HUMAN-IN-THE-LOOP GATE (After Pass 0)                        \u2502');
  write('\u2502  Review the design artefacts before any code is written.      \u2502');
  write('\u2502' + ' '.repeat(W) + '\u2502');
  write(`\u2502  1. Mermaid diagram  ->  ${fmt(mmd).padEnd(max)}\u2502`);
  write(`\u2502  2. Gherkin spec     ->  ${fmt(gh).padEnd(max)}\u2502`);
  write('\u2502' + ' '.repeat(W) + '\u2502');
  write('\u2502  Tip: VS Code + \'Mermaid Preview\' extension to render .mmd    \u2502');
  write('\u2502  Press Ctrl+C to abort -- no code will be written.             \u2502');
  write('\u2514' + '\u2500'.repeat(W) + '\u2518');
  write('');

  const rl = createRl({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('  Press Enter to approve and advance to Pass 1 (Contracts)...  ', () => {
      rl.close();
      resolve();
    });
  });
  rl.close();
  write('\n  Design approved.  Continuing to Pass 1 (Contracts & Types)...\n');
}

async function renderTestGenerationHitl(
  ctx: PipelineContext,
  files: FileChange[],
  W: number,
  createRl: ReadlineFactory,
  write: (msg: string) => void,
): Promise<void> {
  write('');
  write('\u250C' + '\u2500'.repeat(W) + '\u2510');
  write('\u2502  HUMAN-IN-THE-LOOP GATE (After Pass 2: Test Generation)        \u2502');
  write('\u2502  Review and optionally edit the generated test suite (Red      \u2502');
  write('\u2502  Phase).                                                       \u2502');
  write('\u2502' + ' '.repeat(W) + '\u2502');

  if (files.length > 0) {
    write('\u2502  Generated Test Files:                                         \u2502');
    for (const f of files) {
      const display = f.file.length > (W - 8) ? '...' + f.file.slice(-(W - 11)) : f.file;
      write(`\u2502    - ${display.padEnd(W - 6)}\u2502`);
    }
  } else {
    write('\u2502  (No files detected — check git status after reviewing)        \u2502');
  }

  write('\u2502' + ' '.repeat(W) + '\u2502');
  write('\u2502  Edit tests if desired, then press Enter to approve and        \u2502');
  write('\u2502  advance to Pass 3 (Core Implementation)...                    \u2502');
  write('\u2514' + '\u2500'.repeat(W) + '\u2518');
  write('');

  const rl = createRl({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('  Press Enter to approve and advance to Pass 3 (Core Implementation)...  ', () => {
      rl.close();
      resolve();
    });
  });
  rl.close();
  write('\n  Test suite approved.  Continuing to Pass 3 (Core Implementation)...\n');
}
