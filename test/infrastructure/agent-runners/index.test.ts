import { describe, it, expect, vi } from 'vitest';

import { createAgentRunner, CreateAgentRunnerDeps } from '../../../src/infrastructure/agent-runners/index.js';
import { PiSdkRunner } from '../../../src/infrastructure/agent-runners/pi-sdk-runner.js';
import { OpenCodeCliRunner } from '../../../src/infrastructure/agent-runners/opencode-cli-runner.js';
import { OpencodeSdkRunner } from '../../../src/infrastructure/agent-runners/opencode-sdk-runner.js';
import type { IAgentServerHandle, IFileSystem, ILogger, IOpencodeSpawner, PipelineConfig } from '../../../src/core/interfaces.js';

// ---------------------------------------------------------------------------
// Mock the Pi SDK module boundary — PiSdkRunner constructor triggers lazy
// dynamic import, but constructor itself is sync. We just need to prevent the
// actual module from loading.
// ---------------------------------------------------------------------------
vi.mock('@earendil-works/pi-coding-agent', () => ({}));

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<CreateAgentRunnerDeps>): CreateAgentRunnerDeps {
  const fs: IFileSystem = {
    exists:     vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
    readFile:   vi.fn<() => Promise<string>>(() => Promise.resolve('')),
    writeFile:  vi.fn<() => Promise<void>>(() => Promise.resolve()),
    mkdir:      vi.fn<() => Promise<void>>(() => Promise.resolve()),
    deleteFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    renameFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    readdir:    vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  };

  const logger: ILogger = {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
    level: 'info',
  };

  const config: PipelineConfig = {
    opencodeLogPath: '/tmp/.agentic-tdd/log',
    apiKeySet: 'present',
  };

  const cmdRunner: IOpencodeSpawner = {
    spawn: vi.fn<() => Promise<string>>(() => Promise.resolve('ok')),
  };

  const agentServer: IAgentServerHandle = {
    baseUrl: 'http://127.0.0.1:4096',
    isAlive: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  };

  return { fs, logger, config, cmdRunner, agentServer, ...overrides };
}

// ---------------------------------------------------------------------------
describe('createAgentRunner', () => {
  it('returns an OpencodeSdkRunner instance for backend "opencode"', () => {
    const deps = makeDeps();
    const runner = createAgentRunner('opencode', deps);
    expect(runner).toBeInstanceOf(OpencodeSdkRunner);
  });

  it('throws when opencode backend is requested without a server handle', () => {
    const deps = makeDeps({ agentServer: undefined });
    expect(() => createAgentRunner('opencode', deps)).toThrow(
      'agentServer is required for opencode backend',
    );
  });

  it('returns a PiSdkRunner instance for backend "pi"', () => {
    const deps = makeDeps();
    const runner = createAgentRunner('pi', deps);
    expect(runner).toBeInstanceOf(PiSdkRunner);
  });

  it('returns an OpenCodeCliRunner instance for backend "opencode-cli"', () => {
    const deps = makeDeps();
    const runner = createAgentRunner('opencode-cli', deps);
    expect(runner).toBeInstanceOf(OpenCodeCliRunner);
  });

  it('throws when opencode-cli backend is requested without cmdRunner', () => {
    const deps = makeDeps({ cmdRunner: undefined });
    expect(() => createAgentRunner('opencode-cli', deps)).toThrow(
      'cmdRunner is required for opencode-cli backend',
    );
  });

  it('throws for an unknown backend', () => {
    const deps = makeDeps();
    expect(() => createAgentRunner('unknown' as never, deps)).toThrow(
      'Unknown agent backend: unknown',
    );
  });
});