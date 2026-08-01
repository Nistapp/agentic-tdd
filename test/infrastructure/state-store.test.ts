import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { NodeFileSystem } from '../../src/infrastructure/file-system.js';
import { JsonStateStore } from '../../src/infrastructure/state-store.js';
import type { PipelineContext } from '../../src/core/types.js';

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
    expect(store.path).toContain('.opencode');
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

  it('atomic write uses temp file and rename', async () => {
    const fs = new NodeFileSystem();
    const store = new JsonStateStore(fs, 'atomic', workDir);
    const ctx = makeContext();

    await store.save(ctx);

    const tmpFile = store.path + '.tmp';
    expect(await fs.exists(tmpFile)).toBe(false);
    expect(await fs.exists(store.path)).toBe(true);

    const raw = await readFile(store.path, 'utf-8');
    const parsed = JSON.parse(raw) as PipelineContext;
    expect(parsed.featureName).toBe('my-feature');
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
});
