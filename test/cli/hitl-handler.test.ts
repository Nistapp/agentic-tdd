import { describe, it, expect, vi } from 'vitest';
import {
  createHitlHandler,
  type ReadlineFactory,
} from '../../src/cli/hitl-handler.js';
import type { PipelineContext, FileChange } from '../../src/core/types.js';
import { PipelinePass } from '../../src/core/types.js';

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    featureName: 'auth',
    testCmd: ['npm', 'test'],
    skipHitl: false,
    maxCorrectionRetries: 3,
    pipelineVersion: '1.0.0',
    sourceType: 'file',
    logLevel: 'INFO',
    specFileAbsPath: '/workspace/specs/auth.md',
    featureDescription: '',
    baseBranch: undefined,
    originalBaseSha: '',
    artefactDir: '/workspace/specs',
    designMmdPath: '/workspace/specs/auth.mmd',
    specGherkinPath: '/workspace/specs/auth.gherkin',
    errorLogPath: '/workspace/.agentic-tdd/error-test-feature.log',
    ...overrides,
  };
}

function makeRl(onQuestion?: (s: string) => void, answers: string[] = ['']): ReadlineFactory {
  let idx = 0;
  return vi.fn((_opts: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) => {
    return {
      question: (_query: string, cb: (answer: string) => void) => {
        onQuestion?.(_query);
        queueMicrotask(() => {
          cb(answers[idx] ?? '');
          idx++;
        });
      },
      close: vi.fn(),
    } as import('node:readline').Interface;
  });
}

describe('createHitlHandler', () => {
  it('outputs the gate box with Mermaid and Gherkin paths', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    const ctx = makeCtx({
      designMmdPath: '/workspace/specs/auth.mmd',
      specGherkinPath: '/workspace/specs/auth.gherkin',
    });

    const createRl = makeRl(() => {});
    const handler = createHitlHandler(ctx, createRl, write);
    await handler();

    const combined = writes.join('\n');

    expect(combined).toContain('HUMAN-IN-THE-LOOP GATE (After Pass 0)');
    expect(combined).toContain('1. Mermaid diagram  ->');
    expect(combined).toContain('2. Gherkin spec     ->');
    expect(combined).toContain('auth.mmd');
    expect(combined).toContain('auth.gherkin');

    expect(combined).toContain('Design approved');
    expect(combined).toContain('Pass 1 (Contracts & Types)');
  });

  it('truncates long file paths', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    const longPath = '/workspace/specs/very-long-feature-name-that-exceeds-the-maximum-width.mmd';
    const ctx = makeCtx({
      designMmdPath: longPath,
      specGherkinPath: longPath,
    });

    const createRl = makeRl(() => {});
    const handler = createHitlHandler(ctx, createRl, write);
    await handler();

    const combined = writes.join('\n');

    const W = 68;
    const max = W - 10;
    expect(longPath.length).toBeGreaterThan(max);
    expect(combined).toContain('...');
  });

  it('uses the injected readline factory', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const receivedQueries: string[] = [];
    const createRl = makeRl((q) => receivedQueries.push(q));

    const handler = createHitlHandler(makeCtx(), createRl, write);
    await handler();

    expect(createRl).toHaveBeenCalledTimes(1);
    expect(createRl).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
    });
    expect(receivedQueries.length).toBeGreaterThan(0);
    expect(receivedQueries[0]).toContain('Press Enter to approve');
  });

  it('uses injected write instead of console.log when provided', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    const createRl = makeRl(() => {});
    const handler = createHitlHandler(makeCtx(), createRl, write);
    await handler();

    expect(writes.length).toBeGreaterThan(5);
    for (const w of writes) {
      expect(typeof w).toBe('string');
    }
  });

  it('defaults readline and write to node built-ins when not injected', () => {
    const handler = createHitlHandler(makeCtx());
    expect(typeof handler).toBe('function');
  });
});

describe('createHitlHandler — Pass 2 (TestGeneration)', () => {
  it('outputs the gate box with file list for TestGeneration', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {});

    const handler = createHitlHandler(makeCtx(), createRl, write);
    await handler(PipelinePass.TestGeneration, [
      { status: 'A', file: 'test/auth/login.test.ts' },
      { status: 'A', file: 'test/auth/token.test.ts' },
    ]);

    const combined = writes.join('\n');

    expect(combined).toContain('HUMAN-IN-THE-LOOP GATE (After Pass 2: Test Generation)');
    expect(combined).toContain('test/auth/login.test.ts');
    expect(combined).toContain('test/auth/token.test.ts');
    expect(combined).toContain('Pass 3 (Core Implementation)');
    expect(combined).toContain('Test suite approved');
  });

  it('does NOT contain "After Pass 3" (numbered with enum value, not 1-based)', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {});

    const handler = createHitlHandler(makeCtx(), createRl, write);
    await handler(PipelinePass.TestGeneration, []);

    const combined = writes.join('\n');
    expect(combined).not.toContain('After Pass 3');
    expect(combined).toContain('After Pass 2');
  });

  it('shows "(No files detected)" when file list is empty', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {});

    const handler = createHitlHandler(makeCtx(), createRl, write);
    await handler(PipelinePass.TestGeneration, []);

    const combined = writes.join('\n');
    expect(combined).toContain('No files detected');
  });

  it('shows Pass 0 design gate when called with no arguments (back-compat)', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {});

    const handler = createHitlHandler(makeCtx(), createRl, write);
    await handler();

    const combined = writes.join('\n');
    expect(combined).toContain('HUMAN-IN-THE-LOOP GATE (After Pass 0)');
    expect(combined).toContain('Mermaid diagram');
    expect(combined).toContain('Gherkin spec');
  });
});

describe('createHitlHandler — HitlAction return values', () => {
  it("returns 'APPROVE' when user presses Enter (empty input)", async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {}, ['']);

    const handler = createHitlHandler(makeCtx(), createRl, write);
    const result = await handler();

    expect(result).toBe('APPROVE');
    const combined = writes.join('\n');
    expect(combined).toContain('Design approved');
  });

  it("returns 'REWIND' when user types 'r'", async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {}, ['r']);

    const handler = createHitlHandler(makeCtx(), createRl, write);
    const result = await handler();

    expect(result).toBe('REWIND');
    const combined = writes.join('\n');
    expect(combined).toContain('Design rejected');
    expect(combined).toContain('Rewinding');
  });

  it("returns 'REJECT' when user types 'x'", async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {}, ['x']);

    const handler = createHitlHandler(makeCtx(), createRl, write);
    const result = await handler();

    expect(result).toBe('REJECT');
    const combined = writes.join('\n');
    expect(combined).toContain('Design rejected by user');
  });

  it('re-prompts on invalid input then accepts valid input', async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {}, ['bad', '']);

    const handler = createHitlHandler(makeCtx(), createRl, write);
    const result = await handler();

    expect(result).toBe('APPROVE');
    const combined = writes.join('\n');
    expect(combined).toContain('Unrecognised input');
    expect(combined).toContain('Design approved');
  });

  it("returns 'REWIND' for TestGeneration pass when user types 'r'", async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {}, ['r']);

    const handler = createHitlHandler(makeCtx(), createRl, write);
    const result = await handler(PipelinePass.TestGeneration, []);

    expect(result).toBe('REWIND');
    const combined = writes.join('\n');
    expect(combined).toContain('Test suite rejected');
    expect(combined).toContain('Rewinding');
  });

  it("returns 'REJECT' for TestGeneration pass when user types 'x'", async () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);
    const createRl = makeRl(() => {}, ['x']);

    const handler = createHitlHandler(makeCtx(), createRl, write);
    const result = await handler(PipelinePass.TestGeneration, []);

    expect(result).toBe('REJECT');
    const combined = writes.join('\n');
    expect(combined).toContain('Test suite rejected by user');
  });
});
