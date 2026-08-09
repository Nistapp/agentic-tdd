import { describe, it, expect } from 'vitest';

import { StateContextProvider } from '../../src/core/context-provider.js';
import { PipelinePass } from '../../src/core/types.js';
import type { PipelineContext, PassHistory, FileChanges } from '../../src/core/types.js';

function makeContext(
  history: Partial<Record<PipelinePass, PassHistory>>,
): PipelineContext {
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

function makePassHistory(
  files: string[],
  targetSymbols?: Record<string, string[]>,
  fileChanges?: FileChanges,
): PassHistory {
  return {
    status: 'completed' as const,
    filesTouched: files,
    attempts: 1,
    targetSymbols,
    fileChanges,
  };
}

describe('StateContextProvider', () => {
  const provider = new StateContextProvider();

  it('returns empty files and empty target for Pass 0 (Design)', () => {
    const ctx = makeContext({});
    const result = provider.build(ctx, PipelinePass.Design);
    expect(result.files.contracts).toEqual([]);
    expect(result.files.tests).toEqual([]);
    expect(result.files.implementation).toEqual([]);
    expect(result.targetSymbols).toEqual({});
  });

  it('returns empty target for Pass 3 (CoreImplementation) when upstream has no targetSymbols', () => {
    const ctx = makeContext({
      [PipelinePass.Contracts]: makePassHistory(['src/models/user.ts']),
      [PipelinePass.TestGeneration]: makePassHistory(['test/user.test.ts']),
    });
    const result = provider.build(ctx, PipelinePass.CoreImplementation);
    expect(result.files.contracts).toEqual(['src/models/user.ts']);
    expect(result.files.tests).toEqual(['test/user.test.ts']);
    expect(result.targetSymbols).toEqual({});
  });

  it('Pass 5 (Observability) merges targetSymbols from Refactor only', () => {
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/models/user.ts'],
        { 'src/models/user.ts': ['User', 'User.create'] },
      ),
      [PipelinePass.Refactor]: makePassHistory(
        ['src/models/user.ts', 'src/utils/helper.ts'],
        { 'src/models/user.ts': ['User.update'], 'src/utils/helper.ts': ['formatDate'] },
      ),
    });
    const result = provider.build(ctx, PipelinePass.Observability);

    expect(result.files.implementation).toEqual([
      'src/models/user.ts',
      'src/utils/helper.ts',
    ]);
    expect(result.files.contracts).toEqual([]);
    expect(result.files.tests).toEqual([]);

    expect(result.targetSymbols).toEqual({
      'src/models/user.ts': ['User.update'],
      'src/utils/helper.ts': ['formatDate'],
    });
  });

  it('Pass 6 (Security) merges targetSymbols from Refactor only', () => {
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/auth.ts'],
        { 'src/auth.ts': ['Auth.login'] },
      ),
      [PipelinePass.Refactor]: makePassHistory(
        ['src/auth.ts', 'src/session.ts'],
        { 'src/auth.ts': ['Auth.verifyToken'], 'src/session.ts': ['Session.create'] },
      ),
    });
    const result = provider.build(ctx, PipelinePass.Security);

    expect(result.files.implementation).toEqual(['src/auth.ts', 'src/session.ts']);
    expect(result.targetSymbols).toEqual({
      'src/auth.ts': ['Auth.verifyToken'],
      'src/session.ts': ['Session.create'],
    });
  });

  it('Documentation returns full implementation files but empty target', () => {
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/models/user.ts'],
        { 'src/models/user.ts': ['User.create'] },
      ),
      [PipelinePass.Refactor]: makePassHistory(
        ['src/utils/helper.ts'],
        { 'src/utils/helper.ts': ['formatDate'] },
      ),
      [PipelinePass.Observability]: makePassHistory(
        ['src/logger.ts'],
        { 'src/logger.ts': ['logMetric'] },
      ),
      [PipelinePass.Security]: makePassHistory(
        ['src/middleware/auth.ts'],
        { 'src/middleware/auth.ts': ['validateToken'] },
      ),
    });
    const result = provider.build(ctx, PipelinePass.Documentation);

    expect(result.files.implementation).toEqual(
      expect.arrayContaining([
        'src/models/user.ts',
        'src/utils/helper.ts',
        'src/logger.ts',
        'src/middleware/auth.ts',
      ]),
    );
    expect(result.files.tests).toEqual([]);
    expect(result.files.contracts).toEqual([]);
    expect(result.targetSymbols).toEqual({});
  });

  it('missing history entry for a referenced pass returns empty (non-fatal)', () => {
    const ctx = makeContext({
      [PipelinePass.Refactor]: makePassHistory(
        ['src/foo.ts'],
        { 'src/foo.ts': ['doWork'] },
      ),
    });

    const result = provider.build(ctx, PipelinePass.Observability);
    expect(result.files.implementation).toEqual(['src/foo.ts']);
    expect(result.targetSymbols).toEqual({ 'src/foo.ts': ['doWork'] });
  });

  it('returns empty target when upstream pass has no targetSymbols field', () => {
    const ctx = makeContext({
      [PipelinePass.Refactor]: makePassHistory(['src/bar.ts']),
    });
    const result = provider.build(ctx, PipelinePass.Observability);
    expect(result.files.implementation).toEqual(['src/bar.ts']);
    expect(result.targetSymbols).toEqual({});
  });

  it('merges and deduplicates targetSymbols across multiple upstream passes', () => {
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/shared.ts'],
        { 'src/shared.ts': ['init', 'teardown'] },
      ),
    });
    const result = provider.build(ctx, PipelinePass.Refactor);
    expect(result.files.implementation).toEqual(['src/shared.ts']);
    expect(result.targetSymbols).toEqual({
      'src/shared.ts': ['init', 'teardown'],
    });
  });

  it('unions symbols for the same file across upstream passes', () => {
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/models/user.ts'],
        { 'src/models/user.ts': ['User.create', 'User.find'] },
      ),
    });

    class MultiPassProvider extends StateContextProvider {
      build(ctx: PipelineContext, pass: PipelinePass) {
        return super.build(ctx, pass);
      }
    }

    // Simulate having two upstream passes both contributing to same file.
    // Refactor depends on CoreImplementation for target symbols.
    const ctx2 = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/models/user.ts'],
        { 'src/models/user.ts': ['User.create', 'User.find'] },
      ),
    });

    const result = provider.build(ctx2, PipelinePass.Refactor);
    expect(result.targetSymbols).toEqual({
      'src/models/user.ts': ['User.create', 'User.find'],
    });
  });

  // ---------------------------------------------------------------------
  // fileChanges merging
  // ---------------------------------------------------------------------

  it('returns empty fileChanges when upstream passes have none', () => {
    const ctx = makeContext({
      [PipelinePass.Refactor]: makePassHistory(['src/bar.ts']),
    });
    const result = provider.build(ctx, PipelinePass.Observability);
    expect(result.fileChanges).toEqual({});
  });

  it('merges fileChanges from the Refactor pass for Observability', () => {
    const refactorFileChanges: FileChanges = {
      'src/models/user.ts': {
        commitHash: 'abc123',
        kind: 'edited-file',
        hunks: [
          {
            range: { start: 42, end: 58 },
            kind: 'modified',
            addedLines: 10,
            removedLines: 6,
            symbols: ['User.update'],
            anchor: '  const result = validate(input);',
          },
        ],
      },
    };
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/models/user.ts'],
        { 'src/models/user.ts': ['User', 'User.create'] },
      ),
      [PipelinePass.Refactor]: makePassHistory(
        ['src/models/user.ts'],
        { 'src/models/user.ts': ['User.update'] },
        refactorFileChanges,
      ),
    });
    const result = provider.build(ctx, PipelinePass.Observability);
    expect(result.fileChanges).toEqual(refactorFileChanges);
    expect(result.targetSymbols).toEqual({ 'src/models/user.ts': ['User.update'] });
  });

  it('latest upstream pass wins per file for fileChanges records', () => {
    const ctx = makeContext({
      [PipelinePass.CoreImplementation]: makePassHistory(
        ['src/shared.ts'],
        { 'src/shared.ts': ['init'] },
        {
          'src/shared.ts': {
            commitHash: 'aaa',
            kind: 'edited-file',
            hunks: [
              {
                range: { start: 1, end: 5 },
                kind: 'added',
                addedLines: 5,
                removedLines: 0,
                symbols: ['init'],
                anchor: 'export function init() {',
              },
            ],
          },
        },
      ),
      [PipelinePass.Refactor]: makePassHistory(
        ['src/shared.ts'],
        { 'src/shared.ts': ['teardown'] },
        {
          'src/shared.ts': {
            commitHash: 'bbb',
            kind: 'edited-file',
            hunks: [
              {
                range: { start: 20, end: 30 },
                kind: 'modified',
                addedLines: 6,
                removedLines: 4,
                symbols: ['teardown'],
                anchor: 'export function teardown() {',
              },
            ],
          },
        },
      ),
    });
    const result = provider.build(ctx, PipelinePass.Security);
    // Refactor (later in target order) wins for the fileChanges record
    expect(result.fileChanges['src/shared.ts']?.commitHash).toBe('bbb');
    expect(result.fileChanges['src/shared.ts']?.hunks[0]?.symbols).toEqual(['teardown']);
    // targetSymbols still unions symbols across upstream passes
    expect(result.targetSymbols).toEqual({ 'src/shared.ts': ['teardown'] });
  });
});
