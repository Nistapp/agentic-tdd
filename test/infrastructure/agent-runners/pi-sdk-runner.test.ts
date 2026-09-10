import { vi, describe, it, expect, beforeEach } from 'vitest';

import { PiSdkRunner, captureEvent, buildToolsAllowlist, INDEXER_TOOLS } from '../../../src/infrastructure/agent-runners/pi-sdk-runner.js';
import { AgentRunError, AGENT_NAMES, PipelinePass } from '../../../src/core/types.js';
import type { AgentRunRequest, AgentArtefacts } from '../../../src/core/types.js';
import type { IFileSystem, ILogger, PipelineConfig } from '../../../src/core/interfaces.js';

// ---------------------------------------------------------------------------
// Mock the Pi SDK module boundary — the runner's only external seam.
// ---------------------------------------------------------------------------

interface FakeResourceLoader {
  opts: Record<string, unknown>;
  reload: ReturnType<typeof vi.fn>;
}

interface FakeSession {
  sessionId: string;
  subscribe: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const sdk = vi.hoisted(() => {
  const createSession = vi.fn();
  const resolveModel = vi.fn();
  const modelRuntimeCreate = vi.fn();
  const inMemory = vi.fn();
  const reload = vi.fn();
  const loaderInstances: FakeResourceLoader[] = [];

  const loaderCtor = vi.fn(function (this: FakeResourceLoader, opts: Record<string, unknown>) {
    this.opts = opts;
    this.reload = reload;
    loaderInstances.push(this);
  });

  return {
    createSession,
    resolveModel,
    modelRuntimeCreate,
    inMemory,
    reload,
    loaderInstances,
    loaderCtor,
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: sdk.modelRuntimeCreate },
  SessionManager: { inMemory: sdk.inMemory },
  DefaultResourceLoader: sdk.loaderCtor,
  createAgentSession: sdk.createSession,
  resolveCliModel: sdk.resolveModel,
  parseFrontmatter: (content: string) => {
    const bodyMatch = content.split(/^---\r?\n/m).slice(1)[1] ?? '';
    const modelMatch = content.match(/^model:\s*(.+)$/m);
    const permission: Record<string, unknown> = {};
    const permMatch = content.match(/^permission:\s*\n([\s\S]*?)(?=^[a-z_]+:|\n---)/m);
    if (permMatch?.[1]) {
      for (const line of permMatch[1].split('\n')) {
        const m = line.match(/^\s{2}([a-z]+):\s*(allow|deny)/);
        if (m?.[1]) permission[m[1]] = m[2];
      }
    }
    return {
      frontmatter: {
        ...(modelMatch?.[1] ? { model: modelMatch[1].trim() } : {}),
        ...(Object.keys(permission).length > 0 ? { permission } : {}),
      },
      body: bodyMatch.trim(),
    };
  },
  getAgentDir: () => '/fake/.pi/agent',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const AGENT_MD = `---
description: Test agent
mode: all
model: openrouter/deepseek/deepseek-v4-pro
permission:
  read: allow
  edit: allow
  glob: allow
  grep: allow
  bash: deny
  webfetch: deny
  task: deny
---

<agent_persona>Test persona</agent_persona>
<directives>Emit SKIP when safe.</directives>
`;

function makeRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  const artefacts: AgentArtefacts = { specFile: '/proj/specs/feature.md' };
  return {
    pass: PipelinePass.Design,
    prompt: JSON.stringify({ featureName: 'test_feature' }),
    artefacts,
    runId: 'fake-run-id',
    ...overrides,
    artefacts: { ...artefacts, ...overrides.artefacts },
  };
}

interface Mocks {
  fs: IFileSystem;
  logger: StubLogger;
  config: PipelineConfig;
}

function makeMocks(configOverrides: Partial<PipelineConfig> = {}): Mocks {
  const fs: IFileSystem = {
    exists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue(AGENT_MD),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  };

  const models = Object.fromEntries(Object.entries(AGENT_NAMES).map(([, name]) => [name, 'openrouter/deepseek/deepseek-v4-pro']));

  const config: PipelineConfig = {
    opencodeLogPath: '/home/fake/.local/share/opencode/log/opencode.log',
    apiKeySet: 'present',
    models,
    ...configOverrides,
  };

  return { fs, logger: new StubLogger(), config };
}

function makeFakeSession(): FakeSession {
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const session: FakeSession = {
    sessionId: 'fake-session-1',
    subscribe: vi.fn((l: (event: Record<string, unknown>) => void) => {
      listener = l;
      return () => { listener = undefined; };
    }),
    prompt: vi.fn(async () => {
      // Emit a scripted event stream before resolving.
      listener?.({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello', partial: { content: [{ type: 'text', text: 'Hello' }] } },
      });
      listener?.({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: { filePath: '/proj/src/foo.ts' },
      });
      listener?.({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' SKIP:0:no-work', partial: { content: [{ type: 'text', text: 'Hello SKIP:0:no-work' }] } },
      });
      listener?.({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read',
        result: { content: '// source' },
        isError: false,
      });
    }),
    dispose: vi.fn(),
  };
  return session;
}

function configureSessionMock(): void {
  const session = makeFakeSession();
  sdk.createSession.mockResolvedValue({ session, extensionsResult: { extensions: [], errors: [] } });
  sdk.resolveModel.mockReturnValue({ model: { provider: 'openrouter', id: 'deepseek-v4-pro' }, thinkingLevel: 'high', warning: undefined, error: undefined });
  sdk.modelRuntimeCreate.mockResolvedValue({});
  sdk.inMemory.mockReturnValue({});
  sdk.reload.mockResolvedValue(undefined);
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createSession.mockReset();
  sdk.resolveModel.mockReset();
  sdk.modelRuntimeCreate.mockReset();
  sdk.inMemory.mockReset();
  sdk.reload.mockReset();
  sdk.loaderInstances.length = 0;
});

describe('PiSdkRunner', () => {
  describe('execute() — happy path', () => {
    it('returns an enriched AgentRunResult with output, structured, sessionId and durationMs', async () => {
      const session = configureSessionMock();
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const result = await runner.execute(makeRequest());

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(result.output).toBe('Hello SKIP:0:no-work');
      expect(result.structured).toBeDefined();
      expect(result.structured!.messages).toHaveLength(2);
      expect(result.structured!.toolCalls).toHaveLength(1);
      expect(result.structured!.toolCalls[0]).toMatchObject({ toolCallId: 't1', toolName: 'read', isError: false });
      expect(result.structured!.toolCalls[0]!.result).toEqual({ content: '// source' });
      expect(result.sessionId).toBe('fake-session-1');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('preserves the skip-signal string in output for parseSkipSignal() compatibility', async () => {
      configureSessionMock();
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const result = await runner.execute(makeRequest());

      expect(result.output).toMatch(/SKIP:0:no-work/);
    });

    it('creates a DefaultResourceLoader whose systemPromptOverride returns the stripped agent body', async () => {
      configureSessionMock();
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      await runner.execute(makeRequest());

      expect(sdk.loaderCtor).toHaveBeenCalledTimes(1);
      const loader = sdk.loaderInstances[0]!;
      const override = loader.opts.systemPromptOverride as () => string;
      expect(override()).toBe('<agent_persona>Test persona</agent_persona>\n<directives>Emit SKIP when safe.</directives>');
      expect(sdk.reload).toHaveBeenCalledTimes(1);
    });

    it('passes a tool allowlist that includes built-ins and the mandatory INDEXER_TOOLS', async () => {
      configureSessionMock();
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      await runner.execute(makeRequest());

      const createArgs = sdk.createSession.mock.calls[0]![0] as { tools: string[] };
      expect(createArgs.tools).toEqual(['read', 'edit', 'write', 'find', 'ls', 'grep', ...INDEXER_TOOLS]);
      expect(createArgs.tools).not.toContain('bash');
      expect(createArgs.tools).not.toContain('powershell');
    });

    it('registers the indexer bridge customTools on the session (in-session MCP bridge)', async () => {
      configureSessionMock();
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      await runner.execute(makeRequest());

      const createArgs = sdk.createSession.mock.calls[0]![0] as { customTools: Array<{ name: string; execute: unknown }> };
      expect(createArgs.customTools).toHaveLength(INDEXER_TOOLS.length);
      const names = createArgs.customTools.map((t) => t.name);
      expect(names).toEqual(INDEXER_TOOLS);
      for (const tool of createArgs.customTools) {
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('uses SessionManager.inMemory() so no session is persisted to disk', async () => {
      configureSessionMock();
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      await runner.execute(makeRequest());

      expect(sdk.inMemory).toHaveBeenCalledTimes(1);
    });

    it('disposes the session after the run', async () => {
      const session = configureSessionMock();
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      await runner.execute(makeRequest());

      expect(session.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('execute() — per-pass thinking levels', () => {
    it('appends :high for passes 0 (Design) and 2 (TestGeneration)', async () => {
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      for (const pass of [PipelinePass.Design, PipelinePass.TestGeneration]) {
        configureSessionMock();
        await runner.execute(makeRequest({ pass }));
        const cliModel = (sdk.resolveModel.mock.calls.at(-1)![0] as { cliModel: string }).cliModel;
        expect(cliModel).toBe(`openrouter/deepseek/deepseek-v4-pro:high`);
      }
    });

    it('appends :off for passes 1 and 3–7', async () => {
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      for (const pass of [
        PipelinePass.Contracts,
        PipelinePass.CoreImplementation,
        PipelinePass.Refactor,
        PipelinePass.Observability,
        PipelinePass.Security,
        PipelinePass.Documentation,
      ]) {
        configureSessionMock();
        await runner.execute(makeRequest({ pass }));
        const cliModel = (sdk.resolveModel.mock.calls.at(-1)![0] as { cliModel: string }).cliModel;
        expect(cliModel).toBe(`openrouter/deepseek/deepseek-v4-pro:off`);
      }
    });
  });

  describe('execute() — model resolution', () => {
    it('throws AgentRunError(no_model) when resolveCliModel cannot resolve a model', async () => {
      configureSessionMock();
      sdk.resolveModel.mockReturnValue({ model: undefined, thinkingLevel: undefined, warning: 'w', error: 'Model "x" not found' });
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const err = await runner.execute(makeRequest()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as AgentRunError).kind).toBe('no_model');
      expect((err as AgentRunError).pass).toBe(PipelinePass.Design);
    });

    it('falls back to the frontmatter model when config has no entry for the agent', async () => {
      const m = makeMocks({ models: {} });
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);
      configureSessionMock();

      await runner.execute(makeRequest());

      const cliModel = (sdk.resolveModel.mock.calls[0]![0] as { cliModel: string }).cliModel;
      expect(cliModel).toBe(`openrouter/deepseek/deepseek-v4-pro:high`);
    });
  });

  describe('execute() — pass log persistence', () => {
    it('writes a sanitized structured log to the per-pass log dir', async () => {
      configureSessionMock();
      const m = makeMocks();
      (m.fs.exists as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => !String(path).includes('.agentic-tdd/log'));
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      await runner.execute(makeRequest({ runId: 'my-run-123' }));

      const writeFileCalls = (m.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
      const logCall = writeFileCalls.find(c => c[0].includes('pass-0-my-run-123.log'));
      expect(logCall).toBeTruthy();
      const parsed = JSON.parse(logCall![1]) as { output: string; structured: { messages: unknown[]; toolCalls: unknown[] } };
      expect(parsed.output).toContain('SKIP:0:no-work');
      expect(parsed.structured.messages).toHaveLength(2);
      expect(parsed.structured.toolCalls).toHaveLength(1);
    });

    it('does NOT throw when pass-log persistence fails (warn and continue)', async () => {
      configureSessionMock();
      const m = makeMocks();
      (m.fs.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const result = await runner.execute(makeRequest());

      expect(result.output).toBe('Hello SKIP:0:no-work');
      expect(m.logger.calls.some(c => c.method === 'warn')).toBe(true);
    });
  });

  describe('execute() — error propagation', () => {
    it('wraps a failing prompt into AgentRunError(no_api_key) when auth is missing', async () => {
      const session = configureSessionMock();
      session.prompt.mockRejectedValue(new Error('No API key found for provider "openrouter". Run /login openrouter.'));
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const err = await runner.execute(makeRequest()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as AgentRunError).kind).toBe('no_api_key');
      expect((err as AgentRunError).pass).toBe(PipelinePass.Design);
    });

    it('wraps a generic session-creation failure into AgentRunError(agent_failed)', async () => {
      configureSessionMock();
      sdk.createSession.mockRejectedValue(new Error('SDK exploded'));
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const err = await runner.execute(makeRequest()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as AgentRunError).kind).toBe('agent_failed');
    });

    it('classifies a timeout message into AgentRunError(timeout)', async () => {
      const session = configureSessionMock();
      session.prompt.mockRejectedValue(new Error('Request timed out after 120s'));
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const err = await runner.execute(makeRequest()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as AgentRunError).kind).toBe('timeout');
    });

    it('re-throws an AgentRunError raised inside execute unchanged', async () => {
      configureSessionMock();
      sdk.resolveModel.mockImplementation(() => {
        throw new AgentRunError('no_model', PipelinePass.Design, 'already typed');
      });
      const m = makeMocks();
      const runner = new PiSdkRunner(m.fs, m.logger, m.config);

      const err = await runner.execute(makeRequest()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as AgentRunError).kind).toBe('no_model');
    });
  });
});

describe('captureEvent', () => {
  it('accumulates text deltas and emits message events', () => {
    const deltas: string[] = [];
    const messages: { role: string; delta: string }[] = [];
    const toolCalls: unknown[] = [];
    captureEvent(
      { type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ab', partial: { content: [{ type: 'text', text: 'ab' }] } } } as never,
      deltas,
      messages as never,
      toolCalls as never,
      () => undefined,
    );
    expect(deltas).toEqual(['ab']);
    expect(messages).toEqual([{ role: 'assistant', delta: 'ab', text: 'ab' }]);
  });

  it('captures usage from a done event', () => {
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    captureEvent(
      { type: 'message_update', message: {}, assistantMessageEvent: { type: 'done', message: { usage: { input: 11, output: 7 } } } } as never,
      [],
      [],
      [],
      (u) => { usage = u; },
    );
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it('records tool_execution_start/end pairs into toolCalls', () => {
    const toolCalls: unknown[] = [];
    const noop = () => undefined;
    captureEvent({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { filePath: 'x' } } as never, [], [], toolCalls as never, noop);
    captureEvent({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit', result: 'ok', isError: false } as never, [], [], toolCalls as never, noop);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallId: 't1', toolName: 'edit', result: 'ok', isError: false });
  });
});

describe('buildToolsAllowlist', () => {
  it('maps permission: allow intents onto Pi built-in tool names and appends INDEXER_TOOLS', () => {
    const tools = buildToolsAllowlist({
      permission: { read: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', bash: 'deny', webfetch: 'deny', task: 'deny' },
    });
    expect(tools).toEqual(['read', 'edit', 'write', 'find', 'ls', 'grep', ...INDEXER_TOOLS]);
  });

  it('falls back to the default allowlist (plus INDEXER_TOOLS) when no permission block exists', () => {
    expect(buildToolsAllowlist({})).toEqual(['read', 'edit', 'write', 'grep', 'find', 'ls', ...INDEXER_TOOLS]);
  });

  it('omits a built-in tool when its intent is denied but still appends INDEXER_TOOLS', () => {
    const tools = buildToolsAllowlist({ permission: { read: 'deny', edit: 'allow', glob: 'deny', grep: 'allow' } });
    expect(tools).toEqual(['edit', 'write', 'grep', ...INDEXER_TOOLS]);
  });

  it('never allows an indexer MCP tool to be stripped by the permission block', () => {
    const tools = buildToolsAllowlist({ permission: { read: 'deny', edit: 'deny', glob: 'deny', grep: 'deny' } });
    for (const tool of INDEXER_TOOLS) {
      expect(tools).toContain(tool);
    }
  });
});
