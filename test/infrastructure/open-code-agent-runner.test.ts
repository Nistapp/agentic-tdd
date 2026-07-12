import { OpenCodeAgentRunner } from '../../src/infrastructure/open-code-agent-runner.js';
import { PipelinePass, AGENT_NAMES } from '../../src/core/types.js';
import type {
  AgentRunRequest,
  AgentArtefacts,
} from '../../src/core/types.js';
import type {
  IFileSystem,
  ILogger,
  PipelineConfig,
  IOpencodeSpawner,
} from '../../src/core/interfaces.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';

class StubLogger implements ILogger {
  readonly calls: { method: string; args: unknown[] }[] = [];

  debug(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'debug', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  info(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'info', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  warn(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'warn', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  error(msgOrObj: string | object, msg?: string): void {
    this.calls.push({ method: 'error', args: [msgOrObj, msg].filter(a => a !== undefined) });
  }

  child(_bindings: Record<string, unknown>): ILogger {
    return this;
  }

  get level(): string {
    return 'info';
  }
}

function makeRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  const artefacts: AgentArtefacts = {
    designMmd: overrides.artefacts?.designMmd ?? '/proj/specs/feature.mmd',
    specGherkin: overrides.artefacts?.specGherkin ?? '/proj/specs/feature.gherkin',
    specFile: overrides.artefacts?.specFile ?? '/proj/specs/feature.md',
    errorLog: overrides.artefacts?.errorLog,
  };
  return {
    pass: PipelinePass.Design,
    prompt: JSON.stringify({ featureName: 'test_feature' }),
    artefacts,
    runId: 'fake-run-id',
    ...overrides,
    artefacts: {
      ...artefacts,
      ...overrides.artefacts,
    },
  };
}

interface Mocks {
  fs: IFileSystem;
  logger: StubLogger;
  config: PipelineConfig;
  spawner: IOpencodeSpawner;
}

function makeMocks(): Mocks {
  const fs: IFileSystem = {
    exists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue('model: test-model-v1\n---\n'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  };

  const config: PipelineConfig = {
    opencodeLogPath: '/home/fake/.local/share/opencode/log/opencode.log',
    apiKeySet: 'present',
  };

  const spawner: IOpencodeSpawner = {
    spawn: vi.fn().mockResolvedValue('agent output'),
  };

  return { fs, logger: new StubLogger(), config, spawner };
}

describe('OpenCodeAgentRunner', () => {
  describe('execute() — argv assembly', () => {
    it('calls spawner.spawn with --agent and --dangerously-skip-permissions', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest();

      await runner.execute(request);

      const args = (m.spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(args).toContain('run');
      expect(args).toContain('--agent');
      expect(args).toContain(AGENT_NAMES[PipelinePass.Design]);
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('attaches --file for each artefact that is present', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest({
        artefacts: {
          designMmd: '/proj/specs/design.mmd',
          specGherkin: '/proj/specs/spec.gherkin',
          specFile: '/proj/specs/issue.md',
        },
      });

      await runner.execute(request);

      const args = (m.spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(args).toContain('/proj/specs/design.mmd');
      expect(args).toContain('/proj/specs/spec.gherkin');
      expect(args).toContain('/proj/specs/issue.md');
    });

    it('attaches --file for errorLog when set', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest({
        artefacts: { errorLog: '/proj/specs/.error.log' },
      });

      await runner.execute(request);

      const args = (m.spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(args).toContain('/proj/specs/.error.log');
    });

    it('skips --file for absent artefacts', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest({
        artefacts: {
          designMmd: undefined,
          specGherkin: undefined,
          specFile: undefined,
        },
      });

      await runner.execute(request);

      const args = (m.spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      const fileIndices = args
        .map((a, i) => (a === '--file' ? i : -1))
        .filter(i => i !== -1);
      expect(fileIndices).toHaveLength(0);
    });

    it('injects --print-logs and --log-level DEBUG when logger level is debug', async () => {
      const m = makeMocks();
      const debugLogger = new StubLogger();
      Object.defineProperty(debugLogger, 'level', { value: 'debug' });

      const runner = new OpenCodeAgentRunner(m.fs, debugLogger, m.config, m.spawner);
      const request = makeRequest();

      await runner.execute(request);

      const args = (m.spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(args).toContain('--print-logs');
      expect(args).toContain('--log-level');
      expect(args).toContain('DEBUG');
    });

    it('does NOT inject debug flags when logger level is info', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest();

      await runner.execute(request);

      const args = (m.spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(args).not.toContain('--print-logs');
      expect(args).not.toContain('DEBUG');
    });

    it('places prompt as the last argument after --dangerously-skip-permissions', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest({ prompt: 'MY_TEST_PROMPT' });

      await runner.execute(request);

      const args = (m.spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      const skipPermIdx = args.indexOf('--dangerously-skip-permissions');
      expect(skipPermIdx).toBeGreaterThan(-1);
      expect(args[skipPermIdx + 1]).toBe('MY_TEST_PROMPT');
    });
  });

  describe('execute() — pre-flight logging', () => {
    it('logs pass, agent name, model, and apiKey status', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest({ pass: PipelinePass.CoreImplementation });

      await runner.execute(request);

      const infoCalls = m.logger.calls.filter(c => c.method === 'info');
      const preFlightCall = infoCalls.find(c =>
        c.args.length > 1 && typeof c.args[1] === 'string' && (c.args[1] as string).includes('Pre-flight'),
      );
      expect(preFlightCall).toBeTruthy();
      const payload = preFlightCall!.args[0] as Record<string, unknown>;
      expect(payload.pass).toBe(PipelinePass.CoreImplementation);
      expect(payload.agent).toBe(AGENT_NAMES[PipelinePass.CoreImplementation]);
      expect(payload.apiKey).toBe('present');
    });

    it('reads agent .md file to extract model', async () => {
      const m = makeMocks();
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);

      await runner.execute(makeRequest());

      expect(m.fs.readFile).toHaveBeenCalled();
      const readFileCalls = (m.fs.readFile as ReturnType<typeof vi.fn>).mock.calls as string[][];
      const agentMdCall = readFileCalls.find(c => c[0].endsWith('.md'));
      expect(agentMdCall).toBeTruthy();
    });
  });

  describe('execute() — pass log persistence', () => {
    it('writes output to .opencode/log/pass-N-runId.log', async () => {
      const m = makeMocks();
      (m.fs.exists as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
        return path.includes('.opencode/log') ? false : true;
      });

      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);
      const request = makeRequest({ pass: PipelinePass.Design, runId: 'my-run-123' });

      await runner.execute(request);

      const writeFileCalls = (m.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
      const logCall = writeFileCalls.find(c => c[0].includes('pass-0-my-run-123.log'));
      expect(logCall).toBeTruthy();
      expect(logCall![1]).toBe('agent output');
    });
  });

  describe('execute() — return value and error propagation', () => {
    it('returns AgentRunResult with spawner output', async () => {
      const m = makeMocks();
      (m.spawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue('custom output');
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);

      const result = await runner.execute(makeRequest());

      expect(result.output).toBe('custom output');
    });

    it('throws when spawner rejects', async () => {
      const m = makeMocks();
      (m.spawner.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('opencode crashed'));
      const runner = new OpenCodeAgentRunner(m.fs, m.logger, m.config, m.spawner);

      await expect(runner.execute(makeRequest())).rejects.toThrow('opencode crashed');
    });
  });
});
