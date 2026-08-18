import { describe, it, expect } from 'vitest';

import { getAgentContextPayload } from '../../../src/core/runners/shared.js';
import { PipelinePass } from '../../../src/core/types.js';
import type { PipelineContext, BuiltContext } from '../../../src/core/types.js';

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    featureName: 'test-feature',
    testCmd: ['npm', 'test'],
    skipHitl: true,
    maxCorrectionRetries: 3,
    pipelineVersion: '1.0.0',
    sourceType: 'file',
    logLevel: 'INFO',
    artefactDir: '/tmp/specs',
    designMmdPath: '/tmp/specs/design.mmd',
    specGherkinPath: '/tmp/specs/spec.gherkin',
    errorLogPath: '/tmp/specs/error.log',
    history: {},
    currentPass: PipelinePass.CoreImplementation,
    ...overrides,
  };
}

function makeBuilt(): BuiltContext {
  return {
    files: { contracts: [], tests: ['test/foo.test.ts'], implementation: [] },
    targetSymbols: {
      'test/foo.test.ts': ["describe('Foo') › it('edge case')"],
    },
    fileChanges: {
      'test/foo.test.ts': {
        commitHash: 'abc123',
        kind: 'edited-file',
        hunks: [
          {
            range: { start: 10, end: 20 },
            kind: 'added',
            addedLines: 11,
            removedLines: 0,
            symbols: ["describe('Foo') › it('edge case')"],
            anchor: "it('edge case', () => {",
          },
        ],
      },
    },
  };
}

describe('getAgentContextPayload', () => {
  it('includes fileChanges alongside targetSymbols', () => {
    const ctx = makeContext();
    const built = makeBuilt();
    const parsed = JSON.parse(getAgentContextPayload(ctx, built)) as BuiltContext;

    expect(parsed.targetSymbols).toEqual(built.targetSymbols);
    expect(parsed.fileChanges).toEqual(built.fileChanges);
  });

  it('defaults fileChanges and targetSymbols to empty objects when built is absent', () => {
    const ctx = makeContext();
    const parsed = JSON.parse(getAgentContextPayload(ctx)) as Record<string, unknown>;

    expect(parsed.targetSymbols).toEqual({});
    expect(parsed.fileChanges).toEqual({});
  });
});
