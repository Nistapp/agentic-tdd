import { describe, it, expect, vi } from 'vitest';
import {
  createHitlHandler,
  type ReadlineFactory,
} from '../../src/cli/hitl-handler.js';
import type { PipelineContext } from '../../src/core/types.js';

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
    errorLogPath: '/workspace/specs/.opencode_error.log',
    testFilePath: '/workspace/test/auth.test.ts',
    ...overrides,
  } as PipelineContext;
}

function makeRl(onQuestion: (s: string) => void): ReadlineFactory {
  return vi.fn((opts: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) => {
    return {
      question: (query: string, cb: (answer: string) => void) => {
        onQuestion(query);
        cb('');
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
