import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { NodeFileSystem } from '../../src/infrastructure/file-system.js';
import { JsonStateStore } from '../../src/infrastructure/state-store.js';
import type { PipelineContext, StateFileEnvelope, FileChanges } from '../../src/core/types.js';

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    featureName: 'my-feature',
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
    ...overrides,
  };
}

describe('JsonStateStore', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'agentic-tdd-state-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('constructs a feature-scoped path', () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'payment-retry', workDir);
    expect(store.path).toContain('.agentic-tdd');
    expect(store.path).toContain('state-payment-retry.json');
    expect(store.path).toContain(workDir);
  });

  it('sanitises feature name in file path', () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'My Feature!!', workDir);
    expect(store.path).toContain('state-my-feature.json');
  });

  it('exists returns false when no state file', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'nonexistent', workDir);
    expect(await store.exists()).toBe(false);
  });

  it('exists returns true after save', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'my-feature', workDir);
    const ctx = makeContext();

    await store.save(ctx);
    expect(await store.exists()).toBe(true);
  });

  it('round-trips PipelineContext through save/load', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'roundtrip', workDir);
    const ctx = makeContext({
      featureName: 'roundtrip',
      history: {
        1: {
          status: 'completed',
          filesTouched: ['src/models/user.ts'],
          attempts: 1,
          commitHash: 'abc123',
        },
      },
    });

    await store.save(ctx);
    const loaded = await store.load();

    expect(loaded.featureName).toBe('roundtrip');
    expect(loaded.history[1]?.status).toBe('completed');
    expect(loaded.history[1]?.filesTouched).toEqual(['src/models/user.ts']);
    expect(loaded.history[1]?.commitHash).toBe('abc123');
    expect(loaded.history[1]?.attempts).toBe(1);
  });

  it('round-trips xstateSnapshot through save/load', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'snapshot-roundtrip', workDir);

    const snapshot: Record<string, unknown> = {
      status: 'done',
      value: 'pipeline_complete',
      context: {
        featureName: 'snapshot-roundtrip',
        history: { 0: { status: 'completed', filesTouched: ['a.txt'], attempts: 1 } },
      },
    };

    const ctx = makeContext({
      featureName: 'snapshot-roundtrip',
      xstateSnapshot: snapshot,
    });

    await store.save(ctx);
    const loaded = await store.load();

    expect(loaded.xstateSnapshot).toBeDefined();
    expect(loaded.xstateSnapshot).toEqual(snapshot);

    const json = JSON.stringify(loaded.xstateSnapshot);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.status).toBe('done');
    expect(parsed.value).toBe('pipeline_complete');
  });

  it('round-trips xstateSnapshot through save/load when context overwritten', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'snapshot-overwrite', workDir);

    const firstSnapshot: Record<string, unknown> = {
      status: 'active',
      value: 'pass_0',
      context: { featureName: 'first' },
    };

    const secondSnapshot: Record<string, unknown> = {
      status: 'done',
      value: 'pipeline_complete',
      context: { featureName: 'second' },
    };

    let ctx = makeContext({ featureName: 'first', xstateSnapshot: firstSnapshot });
    await store.save(ctx);

    ctx = makeContext({ featureName: 'second', xstateSnapshot: secondSnapshot });
    await store.save(ctx);

    const loaded = await store.load();
    expect(loaded.featureName).toBe('second');
    expect(loaded.xstateSnapshot).toEqual(secondSnapshot);
  });

  it('load throws when state file does not exist', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'ghost', workDir);

    await expect(store.load()).rejects.toThrow();
  });

  it('delete removes the state file', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'deletable', workDir);
    const ctx = makeContext();

    await store.save(ctx);
    expect(await store.exists()).toBe(true);

    await store.delete();
    expect(await store.exists()).toBe(false);
  });

  it('delete does not throw when file does not exist', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'ghost-delete', workDir);

    await expect(store.delete()).resolves.toBeUndefined();
  });

  it('atomic write wraps state in schema envelope', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'atomic', workDir);
    const ctx = makeContext();

    await store.save(ctx);

    const tmpFile = store.path + '.tmp';
    expect(await fs.exists(tmpFile)).toBe(false);
    expect(await fs.exists(store.path)).toBe(true);

    const raw = await readFile(store.path, 'utf-8');
    const envelope = JSON.parse(raw) as StateFileEnvelope;
    expect(envelope.schemaVersion).toBe('0.2.0');
    expect(envelope.context.featureName).toBe('my-feature');
  });

  it('save overwrites existing state', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'overwrite', workDir);

    const ctx1 = makeContext({ featureName: 'first', history: { 0: { status: 'completed', filesTouched: ['a.txt'], attempts: 1 } } });
    const ctx2 = makeContext({ featureName: 'second', history: { 1: { status: 'completed', filesTouched: ['b.txt'], attempts: 2 } } });

    await store.save(ctx1);
    await store.save(ctx2);

    const loaded = await store.load();
    expect(loaded.featureName).toBe('second');
    expect(loaded.history[1]?.filesTouched).toEqual(['b.txt']);
    expect(loaded.history[0]).toBeUndefined();
  });

  it('load rejects corrupt JSON with meaningful error', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'corrupt', workDir);

    await fs.mkdir(store.path.replace(/\/[^/]+$/, ''));
    await fs.writeFile(store.path, 'not valid json {{{');

    await expect(store.load()).rejects.toThrow('Corrupt state file');
  });

  it('load rejects unsupported schema version', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'future', workDir);

    const envelope: StateFileEnvelope = {
      schemaVersion: '99.0.0',
      context: makeContext({ featureName: 'future-feature' }),
    };
    await fs.mkdir(store.path.replace(/\/[^/]+$/, ''));
    await fs.writeFile(store.path, JSON.stringify(envelope, null, 2));

    await expect(store.load()).rejects.toThrow('Unsupported schema version');
  });

  it('load accepts raw context without envelope (forward-compat fallback)', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'legacy', workDir);

    const ctx = makeContext({
      featureName: 'legacy-feature',
      history: {
        1: {
          status: 'completed',
          filesTouched: ['src/foo.ts'],
          attempts: 1,
          commitHash: 'def456',
        },
      },
    });
    await fs.mkdir(store.path.replace(/\/[^/]+$/, ''));
    await fs.writeFile(store.path, JSON.stringify(ctx, null, 2));

    const loaded = await store.load();
    expect(loaded.featureName).toBe('legacy-feature');
    expect(loaded.history[1]?.commitHash).toBe('def456');
  });

  it('load accepts a legacy 0.1.0 envelope (optional-field forward-compat)', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'v010', workDir);

    const envelope: StateFileEnvelope = {
      schemaVersion: '0.1.0',
      context: makeContext({ featureName: 'v010-feature' }),
    };
    await fs.mkdir(store.path.replace(/\/[^/]+$/, ''));
    await fs.writeFile(store.path, JSON.stringify(envelope, null, 2));

    const loaded = await store.load();
    expect(loaded.featureName).toBe('v010-feature');
  });

  it('round-trips targetSymbols and fileChanges through save/load', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'changes', workDir);

    const fileChanges: FileChanges = {
      'test/foo.test.ts': {
        commitHash: 'def456',
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
    };
    const ctx = makeContext({
      history: {
        2: {
          status: 'completed',
          filesTouched: ['test/foo.test.ts'],
          attempts: 1,
          targetSymbols: {
            'test/foo.test.ts': ["describe('Foo') › it('edge case')"],
          },
          fileChanges,
        },
      },
    });

    await store.save(ctx);
    const loaded = await store.load();

    expect(loaded.history[2]?.targetSymbols).toEqual({
      'test/foo.test.ts': ["describe('Foo') › it('edge case')"],
    });
    expect(loaded.history[2]?.fileChanges).toEqual(fileChanges);
  });

  it('independent stores do not collide', async () => {
    const fs = new NodeFileSystem();
    const storeA = new JsonStateStore(fs, 'feature-a', workDir);
    const storeB = new JsonStateStore(fs, 'feature-b', workDir);

    await storeA.save(makeContext({ featureName: 'feature-a' }));
    await storeB.save(makeContext({ featureName: 'feature-b' }));

    const loadedA = await storeA.load();
    const loadedB = await storeB.load();

    expect(loadedA.featureName).toBe('feature-a');
    expect(loadedB.featureName).toBe('feature-b');
    expect(storeA.path).not.toBe(storeB.path);
  });

  describe('findActive', () => {
    it('returns undefined when .agentic-tdd/ does not exist', async () => {
      const fs = new NodeFileSystem();
      const found = await JsonStateStore.findActive(fs, workDir);
      expect(found).toBeUndefined();
    });

    it('returns undefined when .agentic-tdd/ has no state files', async () => {
      const fs = new NodeFileSystem();
      await fs.mkdir(join(workDir, '.agentic-tdd'));
      const found = await JsonStateStore.findActive(fs, workDir);
      expect(found).toBeUndefined();
    });

    it('returns the single active store when one state file exists', async () => {
      const fs = new NodeFileSystem();
      const store = new JsonStateStore(fs, 'lone-session', workDir);
      await store.save(makeContext({ featureName: 'lone-session' }));

      const found = await JsonStateStore.findActive(fs, workDir);
      expect(found).toBeDefined();
      expect(found!.path).toBe(store.path);
    });

    it('rejects when multiple state files exist', async () => {
      const fs = new NodeFileSystem();
      const storeA = new JsonStateStore(fs, 'session-a', workDir);
      const storeB = new JsonStateStore(fs, 'session-b', workDir);
      await storeA.save(makeContext({ featureName: 'session-a' }));
      await storeB.save(makeContext({ featureName: 'session-b' }));

      await expect(JsonStateStore.findActive(fs, workDir)).rejects.toThrow('Multiple active sessions');
    });

    it('ignores non-state-*.json files in the directory', async () => {
      const fs = new NodeFileSystem();
      await fs.writeFile(join(workDir, '.agentic-tdd', 'other-file.txt'), 'hello');
      const store = new JsonStateStore(fs, 'my-session', workDir);
      await store.save(makeContext({ featureName: 'my-session' }));

      const found = await JsonStateStore.findActive(fs, workDir);
      expect(found).toBeDefined();
      expect(found!.path).toBe(store.path);
    });
  });
});
