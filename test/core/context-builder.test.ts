import { describe, it, expect } from 'vitest';

import { buildContextFiles } from '../../src/core/context-builder.js';
import { PipelinePass } from '../../src/core/types.js';
import type { PipelineContext, PassHistory } from '../../src/core/types.js';

function makeContext(history: Partial<Record<PipelinePass, PassHistory>>): PipelineContext {
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
    history,
  };
}

function makePassHistory(files: string[]): PassHistory {
  return { status: 'completed', filesTouched: files, attempts: 1 };
}

describe('buildContextFiles', () => {
  it('returns empty arrays for Pass 0 (Design)', () => {
    const ctx = makeContext({});
    const result = buildContextFiles(ctx, PipelinePass.Design);
    expect(result.contracts).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.implementation).toEqual([]);
  });

  it('returns empty arrays for Pass 1 (Contracts)', () => {
    const ctx = makeContext({});
    const result = buildContextFiles(ctx, PipelinePass.Contracts);
    expect(result.contracts).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.implementation).toEqual([]);
  });

  it('returns contract files for Pass 2 (Test Generation)', () => {
    const ctx = makeContext({
      [PipelinePass.Contracts]: makePassHistory(['src/models/user.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.TestGeneration);
    expect(result.contracts).toEqual(['src/models/user.ts']);
    expect(result.tests).toEqual([]);
    expect(result.implementation).toEqual([]);
  });

  it('returns contracts and tests for Pass 3 (Core Implementation)', () => {
    const ctx = makeContext({
      [PipelinePass.Contracts]: makePassHistory(['src/models/user.ts']),
      [PipelinePass.TestGeneration]: makePassHistory(['test/user.test.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.CoreImplementation);
    expect(result.contracts).toEqual(['src/models/user.ts']);
    expect(result.tests).toEqual(['test/user.test.ts']);
    expect(result.implementation).toEqual([]);
  });

  it('returns tests and implementation for Pass 4 (Refactor)', () => {
    const ctx = makeContext({
      [PipelinePass.TestGeneration]: makePassHistory(['test/user.test.ts']),
      [PipelinePass.CoreImplementation]: makePassHistory(['src/models/user.ts', 'src/services/auth.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.Refactor);
    expect(result.tests).toEqual(['test/user.test.ts']);
    expect(result.implementation).toEqual(['src/models/user.ts', 'src/services/auth.ts']);
    expect(result.contracts).toEqual([]);
  });

  it('returns tests and implementation for Pass 5 (Observability)', () => {
    const ctx = makeContext({
      [PipelinePass.TestGeneration]: makePassHistory(['test/user.test.ts']),
      [PipelinePass.CoreImplementation]: makePassHistory(['src/models/user.ts']),
      [PipelinePass.Refactor]: makePassHistory(['src/models/user.ts', 'src/utils/helper.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.Observability);
    expect(result.tests).toEqual(['test/user.test.ts']);
    expect(result.implementation).toEqual(['src/models/user.ts', 'src/utils/helper.ts']);
  });

  it('returns tests and implementation for Pass 6 (Security)', () => {
    const ctx = makeContext({
      [PipelinePass.TestGeneration]: makePassHistory(['test/user.test.ts']),
      [PipelinePass.CoreImplementation]: makePassHistory(['src/models/user.ts']),
      [PipelinePass.Refactor]: makePassHistory(['src/utils/helper.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.Security);
    expect(result.tests).toEqual(['test/user.test.ts']);
    expect(result.implementation).toEqual(['src/models/user.ts', 'src/utils/helper.ts']);
  });

  it('returns implementation files from passes 3-6 for Pass 7 (Documentation)', () => {
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(['src/models/user.ts']),
      [PipelinePass.Refactor]: makePassHistory(['src/utils/helper.ts']),
      [PipelinePass.Security]: makePassHistory(['src/middleware/auth.ts']),
      [PipelinePass.Observability]: makePassHistory(['src/logger.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.Documentation);
    expect(result.implementation).toEqual(
      expect.arrayContaining([
        'src/models/user.ts',
        'src/utils/helper.ts',
        'src/middleware/auth.ts',
        'src/logger.ts',
      ]),
    );
    expect(result.tests).toEqual([]);
    expect(result.contracts).toEqual([]);
  });

  it('returns empty arrays when history is empty', () => {
    const ctx = makeContext({});
    const result = buildContextFiles(ctx, PipelinePass.CoreImplementation);
    expect(result.contracts).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.implementation).toEqual([]);
  });

  it('returns empty arrays when history has no matching passes', () => {
    const ctx = makeContext({
      [PipelinePass.Design]: makePassHistory(['specs/design.mmd']),
    });
    const result = buildContextFiles(ctx, PipelinePass.TestGeneration);
    expect(result.contracts).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.implementation).toEqual([]);
  });

  it('deduplicates files across multiple source passes', () => {
    const ctx = makeContext({
      [PipelinePass.Contracts]: makePassHistory(['src/models/common.ts', 'src/shared.ts']),
      [PipelinePass.TestGeneration]: makePassHistory(['test/shared.test.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.CoreImplementation);
    expect(result.contracts).toEqual(['src/models/common.ts', 'src/shared.ts']);
    expect(result.tests).toEqual(['test/shared.test.ts']);
  });
});
