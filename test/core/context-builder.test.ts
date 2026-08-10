import { describe, it, expect } from 'vitest';

import { buildContextFiles, buildTargetPasses, CONTEXT_RULES } from '../../src/core/context-builder.js';
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

  it('returns only implementation from Refactor for Pass 5 (Observability) — AD-5', () => {
    const ctx = makeContext({
      [PipelinePass.TestGeneration]: makePassHistory(['test/user.test.ts']),
      [PipelinePass.CoreImplementation]: makePassHistory(['src/models/user.ts']),
      [PipelinePass.Refactor]: makePassHistory(['src/models/user.ts', 'src/utils/helper.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.Observability);
    expect(result.tests).toEqual([]);
    expect(result.contracts).toEqual([]);
    expect(result.implementation).toEqual(['src/models/user.ts', 'src/utils/helper.ts']);
  });

  it('returns only implementation from Refactor for Pass 6 (Security) — AD-5', () => {
    const ctx = makeContext({
      [PipelinePass.TestGeneration]: makePassHistory(['test/user.test.ts']),
      [PipelinePass.CoreImplementation]: makePassHistory(['src/models/user.ts']),
      [PipelinePass.Refactor]: makePassHistory(['src/utils/helper.ts']),
    });
    const result = buildContextFiles(ctx, PipelinePass.Security);
    expect(result.tests).toEqual([]);
    expect(result.contracts).toEqual([]);
    expect(result.implementation).toEqual(['src/utils/helper.ts']);
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

describe('buildTargetPasses', () => {
  it('returns empty for Pass 0 (Design)', () => {
    expect(buildTargetPasses(PipelinePass.Design)).toEqual([]);
  });

  it('returns empty for Pass 1 (Contracts)', () => {
    expect(buildTargetPasses(PipelinePass.Contracts)).toEqual([]);
  });

  it('returns empty for Pass 2 (TestGeneration)', () => {
    expect(buildTargetPasses(PipelinePass.TestGeneration)).toEqual([]);
  });

  it('returns empty for Pass 3 (CoreImplementation)', () => {
    expect(buildTargetPasses(PipelinePass.CoreImplementation)).toEqual([]);
  });

  it('returns CoreImplementation for Pass 4 (Refactor)', () => {
    expect(buildTargetPasses(PipelinePass.Refactor)).toEqual([
      PipelinePass.CoreImplementation,
    ]);
  });

  it('returns Refactor for Pass 5 (Observability)', () => {
    expect(buildTargetPasses(PipelinePass.Observability)).toEqual([
      PipelinePass.Refactor,
    ]);
  });

  it('returns Refactor for Pass 6 (Security)', () => {
    expect(buildTargetPasses(PipelinePass.Security)).toEqual([
      PipelinePass.Refactor,
    ]);
  });

  it('returns empty for Pass 7 (Documentation)', () => {
    expect(buildTargetPasses(PipelinePass.Documentation)).toEqual([]);
  });
});

describe('CONTEXT_RULES structural integrity', () => {
  const ALL_PASSES = Object.values(PipelinePass).filter(
    (v): v is PipelinePass => typeof v === 'number',
  );

  it('covers every PipelinePass enum member', () => {
    for (const pass of ALL_PASSES) {
      expect(CONTEXT_RULES[pass], `Missing rule for pass ${pass}`).toBeDefined();
    }
  });

  it('all referenced source passes are valid enum values (files)', () => {
    for (const pass of ALL_PASSES) {
      const rule = CONTEXT_RULES[pass]!;
      for (const p of [
        ...rule.files.contracts,
        ...rule.files.tests,
        ...rule.files.implementation,
      ]) {
        expect(ALL_PASSES, `Pass ${pass} references invalid source pass ${p}`).toContain(p);
      }
    }
  });

  it('all referenced target passes are valid enum values (target)', () => {
    for (const pass of ALL_PASSES) {
      const rule = CONTEXT_RULES[pass]!;
      for (const p of [
        ...rule.target.contracts,
        ...rule.target.tests,
        ...rule.target.implementation,
      ]) {
        expect(
          ALL_PASSES,
          `Pass ${pass} references invalid target pass ${p}`,
        ).toContain(p);
      }
    }
  });

  it('has no circular dependencies in files rules', () => {
    for (const pass of ALL_PASSES) {
      const rule = CONTEXT_RULES[pass]!;
      const allSources = [
        ...rule.files.contracts,
        ...rule.files.tests,
        ...rule.files.implementation,
      ];
      for (const source of allSources) {
        expect(
          source,
          `Circular: Pass ${pass} references itself as source`,
        ).not.toBe(pass);
      }
    }
  });

  it('Documentation returns full implementation files but empty target passes', () => {
    const docRule = CONTEXT_RULES[PipelinePass.Documentation]!;
    expect(docRule.files.implementation).toContain(PipelinePass.CoreImplementation);
    expect(docRule.files.implementation).toContain(PipelinePass.Refactor);
    expect(docRule.files.implementation).toContain(PipelinePass.Observability);
    expect(docRule.files.implementation).toContain(PipelinePass.Security);
    expect(docRule.files.tests).toEqual([]);
    expect(docRule.files.contracts).toEqual([]);

    const targetPasses = [
      ...docRule.target.contracts,
      ...docRule.target.tests,
      ...docRule.target.implementation,
    ];
    expect(targetPasses).toEqual([]);
  });
});
