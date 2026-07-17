import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

import type { PipelineContext } from '../core/types.js';
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
  return async () => {
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
  };
}
