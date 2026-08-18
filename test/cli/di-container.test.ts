import { describe, it, expect, vi } from 'vitest';
import { createPipelineServices, buildPipelineConfig } from '../../src/cli/di-container.js';
import type { IFileSystem, IGitService } from '../../src/core/interfaces.js';
import type { PipelineContext } from '../../src/core/types.js';
import { TerminalRenderer } from '../../src/cli/terminal-renderer.js';
import { PipelineOrchestrator } from '../../src/core/orchestrator.js';

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    featureName: 'test-feature',
    testCmd: ['npm', 'test'],
    skipHitl: false,
    maxCorrectionRetries: 3,
    pipelineVersion: '1.0.0',
    sourceType: 'file',
    logLevel: 'INFO',
    specFileAbsPath: '/tmp/test-spec.md',
    featureDescription: '',
    baseBranch: undefined,
    originalBaseSha: '',
    artefactDir: '/tmp/specs',
    designMmdPath: '/tmp/specs/test-feature.mmd',
    specGherkinPath: '/tmp/specs/test-feature.gherkin',
    errorLogPath: '/tmp/.agentic-tdd/error-test-feature.log',
    ...overrides,
  } as PipelineContext;
}

const mockFs: IFileSystem = {
  exists:     vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
  readFile:   vi.fn<() => Promise<string>>(() => Promise.resolve('')),
  writeFile:  vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mkdir:      vi.fn<() => Promise<void>>(() => Promise.resolve()),
  deleteFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  renameFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  readdir:    vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
};

const mockGit: IGitService = {
  commit:              vi.fn<() => Promise<{ kind: string }>>(() => Promise.resolve({ kind: 'nothing_to_commit' })),
  getPendingChanges:   vi.fn<() => Promise<readonly { status: string; file: string }[]>>(() => Promise.resolve([])),
  getCurrentBranch:    vi.fn<() => Promise<string>>(() => Promise.resolve('main')),
  isDirty:             vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
  getCurrentCommitSha: vi.fn<() => Promise<string>>(() => Promise.resolve('abc123')),
  getLastCompletedPass: vi.fn<() => Promise<number | null>>(() => Promise.resolve(null)),
  resetWorkingTree:    vi.fn<() => Promise<void>>(() => Promise.resolve()),
  abortToSha:          vi.fn<() => Promise<void>>(() => Promise.resolve()),
  tag:                 vi.fn<() => Promise<void>>(() => Promise.resolve()),
};

describe('createPipelineServices', () => {
  it('returns an object with an orchestrator property', () => {
    const renderer = new TerminalRenderer();
    const ctx = makeCtx();
    const services = createPipelineServices({
      ctx,
      fs: mockFs,
      git: mockGit,
      renderer,
      version: '1.0.0',
    });
    expect(services).toHaveProperty('orchestrator');
  });

  it('orchestrator is an instance of PipelineOrchestrator', () => {
    const renderer = new TerminalRenderer();
    const ctx = makeCtx();
    const { orchestrator } = createPipelineServices({
      ctx,
      fs: mockFs,
      git: mockGit,
      renderer,
      version: '1.0.0',
    });
    expect(orchestrator).toBeInstanceOf(PipelineOrchestrator);
  });

  it('orchestrator has a run method', () => {
    const renderer = new TerminalRenderer();
    const ctx = makeCtx();
    const { orchestrator } = createPipelineServices({
      ctx,
      fs: mockFs,
      git: mockGit,
      renderer,
      version: '1.0.0',
    });
    expect(typeof orchestrator.run).toBe('function');
  });
});

describe('buildPipelineConfig', () => {
  it('merges modelConfig.models into PipelineConfig.models', () => {
    const config = buildPipelineConfig({
      modelConfig: { models: { 'pass-0-design-agent': 'openrouter/deepseek/deepseek-v4-pro' } },
    });
    expect(config.models).toEqual({ 'pass-0-design-agent': 'openrouter/deepseek/deepseek-v4-pro' });
  });

  it('leaves models undefined when no modelConfig is provided', () => {
    const config = buildPipelineConfig({});
    expect(config.models).toBeUndefined();
  });

  it('still exposes opencodeLogPath and apiKeySet', () => {
    const config = buildPipelineConfig({});
    expect(config.opencodeLogPath).toBeTruthy();
    expect(['present', 'missing']).toContain(config.apiKeySet);
  });

  it('reports apiKeySet present when only DEEPSEEK_API_KEY is set', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds-test');
    try {
      expect(buildPipelineConfig({}).apiKeySet).toBe('present');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
