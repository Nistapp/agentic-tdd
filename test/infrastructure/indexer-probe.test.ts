import { vi, describe, it, expect, beforeEach } from 'vitest';

import { runLiveIndexerProbe, runStaticIndexerChecks, resolveIndexerBinary, runOpencodeStaticChecks, runOpencodeMcpRoundTrip } from '../../src/infrastructure/indexer-probe.js';
import { INDEXER_TOOLS } from '../../src/infrastructure/agent-runners/pi-sdk-runner.js';
import type { IFileSystem, ILogger } from '../../src/core/interfaces.js';
import type { McpClientLike, McpSdkLike, PiSdkLike, PiSessionLike } from '../../src/infrastructure/indexer-probe.js';
import type { ProcessRunner } from '../../src/infrastructure/indexer-client.js';

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

class StubLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
  get level(): string {
    return 'info';
  }
}

function makeFs(files: Record<string, string>): IFileSystem {
  const store = new Map(Object.entries(files));
  return {
    exists: vi.fn(async (p: string) => store.has(p)),
    readFile: vi.fn(async (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    }),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    readdir: vi.fn(),
  };
}

const AGENT_MD = `---
model: openrouter/deepseek/deepseek-v4-pro
permission:
  read: allow
  edit: allow
  glob: allow
  grep: allow
---

<body/>
`;

const VALID_MCP = JSON.stringify({
  mcpServers: {
    'codebase-memory': { command: '/bin/codebase-memory-mcp', directTools: true },
  },
});

const MCP_NO_DIRECT = JSON.stringify({
  mcpServers: {
    'codebase-memory': { command: '/bin/codebase-memory-mcp' },
  },
});

const SETTINGS_WITH_ADAPTER = JSON.stringify({ packages: ['npm:pi-mcp-adapter'] });
const SETTINGS_NO_ADAPTER = JSON.stringify({ packages: [] });

// ---------------------------------------------------------------------------
// resolveIndexerBinary
// ---------------------------------------------------------------------------

describe('resolveIndexerBinary', () => {
  it('returns the first line of which/where output', async () => {
    const exec = vi.fn().mockResolvedValue('/home/u/bin/codebase-memory-mcp\n');
    await expect(resolveIndexerBinary(exec)).resolves.toBe('/home/u/bin/codebase-memory-mcp');
  });

  it('returns null when the binary is not on PATH (no hardcoded fallback)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('not found'));
    await expect(resolveIndexerBinary(exec)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runStaticIndexerChecks
// ---------------------------------------------------------------------------

describe('runStaticIndexerChecks', () => {
  const baseDeps = {
    fs: makeFs({}),
    logger: new StubLogger(),
    binary: '/bin/codebase-memory-mcp',
    agentDir: '/home/u/.pi/agent',
    workDir: '/proj',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails fast (typed result) when the binary is missing', async () => {
    const result = await runStaticIndexerChecks({ ...baseDeps, binary: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('binary_missing');
      expect(result.failure.message).toMatch(/install/i);
    }
  });

  it('fails when the resolved binary is not executable', async () => {
    const fs = makeFs({
      '/home/u/.pi/agent/settings.json': SETTINGS_WITH_ADAPTER,
      '/proj/.mcp.json': VALID_MCP,
    });
    const result = await runStaticIndexerChecks({
      ...baseDeps,
      fs,
      isExecutable: async () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('binary_not_executable');
  });

  it('fails when pi-mcp-adapter is missing from agent settings packages', async () => {
    const fs = makeFs({
      '/home/u/.pi/agent/settings.json': SETTINGS_NO_ADAPTER,
      '/proj/.mcp.json': VALID_MCP,
    });
    const result = await runStaticIndexerChecks({ ...baseDeps, fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('adapter_not_found');
  });

  it('fails when no candidate MCP config declares the codebase-memory server', async () => {
    const fs = makeFs({
      '/home/u/.pi/agent/settings.json': SETTINGS_WITH_ADAPTER,
      '/home/u/.pi/agent/mcp.json': JSON.stringify({ mcpServers: {} }),
    });
    const result = await runStaticIndexerChecks({ ...baseDeps, fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('mcp_entry_missing');
  });

  it('fails when the effective server entry lacks directTools:true', async () => {
    const fs = makeFs({
      '/home/u/.pi/agent/settings.json': SETTINGS_WITH_ADAPTER,
      '/proj/.mcp.json': MCP_NO_DIRECT,
    });
    const result = await runStaticIndexerChecks({ ...baseDeps, fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('direct_tools_missing');
  });

  it('passes when the binary is executable, the adapter is declared, and the entry has directTools', async () => {
    const fs = makeFs({
      '/home/u/.pi/agent/settings.json': SETTINGS_WITH_ADAPTER,
      '/proj/.mcp.json': VALID_MCP,
    });
    const result = await runStaticIndexerChecks({
      ...baseDeps,
      fs,
      isExecutable: async () => true,
    });
    expect(result).toEqual({ ok: true, binary: '/bin/codebase-memory-mcp' });
  });

  it('honours an explicit mcpConfigFiles list instead of the defaults', async () => {
    const fs = makeFs({
      '/home/u/.pi/agent/settings.json': SETTINGS_WITH_ADAPTER,
      '/custom/mcp.json': VALID_MCP,
    });
    const result = await runStaticIndexerChecks({
      ...baseDeps,
      fs,
      mcpConfigFiles: ['/custom/mcp.json'],
      isExecutable: async () => true,
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runLiveIndexerProbe
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<PiSessionLike>): PiSessionLike {
  const session: PiSessionLike = {
    getActiveToolNames: vi.fn(() => ['read', 'edit', 'write', 'grep', 'find', 'ls', ...INDEXER_TOOLS]),
    getAllTools: vi.fn(() => INDEXER_TOOLS.map((name) => ({ name }))),
    dispose: vi.fn(),
    ...overrides,
  };
  return session;
}

function makeSdk(session: PiSessionLike): PiSdkLike {
  return {
    getAgentDir: () => '/home/u/.pi/agent',
    parseFrontmatter: () => ({ frontmatter: { model: 'openrouter/deepseek/deepseek-v4-pro' }, body: '<body/>' }),
    ModelRuntime: { create: vi.fn().mockResolvedValue({}) },
    DefaultResourceLoader: class {
      async reload(): Promise<void> {}
    } as unknown as PiSdkLike['DefaultResourceLoader'],
    SessionManager: { inMemory: vi.fn(() => ({})) },
    resolveCliModel: vi.fn(() => ({ model: { provider: 'openrouter', id: 'x' }, thinkingLevel: 'high' })),
    createAgentSession: vi.fn(async () => ({ session })),
  };
}

function okCliRunner(): ProcessRunner {
  return vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ structuredContent: { projects: [], total: 0 }, isError: false }),
    stderr: '',
  }));
}

describe('runLiveIndexerProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when a session exposes the indexer bridge tools and the binary responds to list_projects', async () => {
    const session = makeSession();
    const fs = makeFs({ '/agents/pass-0-design-agent.md': AGENT_MD });
    const runCli = okCliRunner();
    const loadPiSdk = vi.fn().mockResolvedValue(makeSdk(session));

    const result = await runLiveIndexerProbe({
      fs,
      logger: new StubLogger(),
      binary: '/bin/codebase-memory-mcp',
      agentFile: '/agents/pass-0-design-agent.md',
      agentDir: '/home/u/.pi/agent',
      workDir: '/proj',
      loadPiSdk,
      runCli,
    });

    expect(result.ok).toBe(true);
    expect(session.dispose).toHaveBeenCalled();
    expect(runCli).toHaveBeenCalledWith(
      '/bin/codebase-memory-mcp',
      expect.arrayContaining(['cli', '--json', 'list_projects']),
      expect.anything(),
    );
  });

  it('fails naming missing CORE tools when the session drops the indexer tools (allowlist bug)', async () => {
    const session = makeSession();
    vi.mocked(session.getActiveToolNames).mockReturnValue(['read', 'edit', 'write', 'grep', 'find', 'ls']);
    vi.mocked(session.getAllTools).mockReturnValue([]);
    const fs = makeFs({ '/agents/pass-0-design-agent.md': AGENT_MD });

    const result = await runLiveIndexerProbe({
      fs,
      logger: new StubLogger(),
      binary: '/bin/codebase-memory-mcp',
      agentFile: '/agents/pass-0-design-agent.md',
      agentDir: '/home/u/.pi/agent',
      workDir: '/proj',
      loadPiSdk: vi.fn().mockResolvedValue(makeSdk(session)),
      runCli: okCliRunner(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('tools_missing');
      expect(result.failure.message).toContain('mcp__codebase-memory__search_graph');
      expect(result.failure.message).toContain('missing:');
    }
    expect(session.dispose).toHaveBeenCalled();
  });

  it('tolerates additional/newer indexer tools (dynamic discovery, no exact-set match)', async () => {
    const session = makeSession();
    const extra = 'mcp__codebase-memory__brand_new_tool';
    vi.mocked(session.getAllTools).mockReturnValue([...INDEXER_TOOLS.map((name) => ({ name })), { name: extra }]);
    const fs = makeFs({ '/agents/pass-0-design-agent.md': AGENT_MD });

    const result = await runLiveIndexerProbe({
      fs,
      logger: new StubLogger(),
      binary: '/bin/codebase-memory-mcp',
      agentFile: '/agents/pass-0-design-agent.md',
      agentDir: '/home/u/.pi/agent',
      workDir: '/proj',
      loadPiSdk: vi.fn().mockResolvedValue(makeSdk(session)),
      runCli: okCliRunner(),
    });

    expect(result.ok).toBe(true);
  });

  it('fails with binary_unresponsive when list_projects exits non-zero', async () => {
    const session = makeSession();
    const runCli: ProcessRunner = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'crash' });
    const fs = makeFs({ '/agents/pass-0-design-agent.md': AGENT_MD });

    const result = await runLiveIndexerProbe({
      fs,
      logger: new StubLogger(),
      binary: '/bin/codebase-memory-mcp',
      agentFile: '/agents/pass-0-design-agent.md',
      agentDir: '/home/u/.pi/agent',
      workDir: '/proj',
      loadPiSdk: vi.fn().mockResolvedValue(makeSdk(session)),
      runCli,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('binary_unresponsive');
  });

  it('fails with no_model when no model can be resolved for the probe session', async () => {
    const session = makeSession();
    const fs = makeFs({ '/agents/pass-0-design-agent.md': AGENT_MD });
    const sdk = makeSdk(session);
    vi.mocked(sdk.resolveCliModel).mockReturnValue({ model: undefined, error: 'no model' });

    const result = await runLiveIndexerProbe({
      fs,
      logger: new StubLogger(),
      binary: '/bin/codebase-memory-mcp',
      agentFile: '/agents/pass-0-design-agent.md',
      agentDir: '/home/u/.pi/agent',
      workDir: '/proj',
      loadPiSdk: vi.fn().mockResolvedValue(sdk),
      runCli: okCliRunner(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('no_model');
  });

  it('fails with probe_timeout when the probe exceeds the timeout budget', async () => {
    const session = makeSession();
    const fs = makeFs({ '/agents/pass-0-design-agent.md': AGENT_MD });
    const sdk = makeSdk(session);
    vi.mocked(sdk.createAgentSession).mockImplementation(
      () => new Promise((resolve) => {
        setTimeout(() => resolve({ session }), 5000);
      }),
    );

    const result = await runLiveIndexerProbe({
      fs,
      logger: new StubLogger(),
      binary: '/bin/codebase-memory-mcp',
      agentFile: '/agents/pass-0-design-agent.md',
      agentDir: '/home/u/.pi/agent',
      workDir: '/proj',
      loadPiSdk: vi.fn().mockResolvedValue(sdk),
      runCli: okCliRunner(),
      timeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('probe_timeout');
  });
});

// ---------------------------------------------------------------------------
// opencode-path probes (G2 static + G5 LLM-free MCP round-trip)
// ---------------------------------------------------------------------------

describe('runOpencodeStaticChecks', () => {
  const base = {
    logger: new StubLogger(),
    binary: '/bin/codebase-memory-mcp',
    isExecutable: async () => true,
    resolveOpencodeBinary: async () => '/usr/bin/opencode',
    getOpencodeVersion: async () => '1.18.29',
  };

  it('fails when the indexer binary is missing', async () => {
    const result = await runOpencodeStaticChecks({ ...base, binary: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('binary_missing');
  });

  it('fails when the indexer binary is not executable', async () => {
    const result = await runOpencodeStaticChecks({ ...base, isExecutable: async () => false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('binary_not_executable');
  });

  it('fails with opencode_missing when the opencode binary is absent', async () => {
    const result = await runOpencodeStaticChecks({ ...base, resolveOpencodeBinary: async () => null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('opencode_missing');
      expect(result.failure.message).toMatch(/opencode/);
    }
  });

  it('passes and records the opencode version', async () => {
    const result = await runOpencodeStaticChecks(base);
    expect(result).toEqual({
      ok: true,
      binary: '/bin/codebase-memory-mcp',
      opencodeVersion: '1.18.29',
    });
  });
});

function makeMcpSdk(overrides: {
  tools?: Array<{ name: string }>;
  callIsError?: boolean;
  connectError?: unknown;
  hangConnect?: boolean;
} = {}): { sdk: McpSdkLike; client: McpClientLike } {
  const client: McpClientLike = {
    connect: vi.fn(async () => {
      if (overrides.hangConnect) await new Promise((resolve) => setTimeout(resolve, 5000));
      if (overrides.connectError !== undefined) throw overrides.connectError;
    }),
    listTools: vi.fn(async () => ({
      tools:
        overrides.tools ?? [
          { name: 'search_graph' },
          { name: 'get_code_snippet' },
          { name: 'index_repository' },
        ],
    })),
    callTool: vi.fn(async () => ({ isError: overrides.callIsError ?? false })),
    close: vi.fn(async () => undefined),
  };
  return {
    sdk: { createClient: () => client, createTransport: () => ({}) },
    client,
  };
}

describe('runOpencodeMcpRoundTrip', () => {
  it('passes when core tools are listed and list_projects succeeds', async () => {
    const { sdk, client } = makeMcpSdk();
    const result = await runOpencodeMcpRoundTrip({ binary: '/bin/cbm', loadMcpSdk: async () => sdk });
    expect(result.ok).toBe(true);
    expect(client.callTool).toHaveBeenCalledWith({ name: 'list_projects', arguments: {} });
    expect(client.close).toHaveBeenCalled();
  });

  it('fails when a core tool is missing', async () => {
    const { sdk } = makeMcpSdk({ tools: [{ name: 'search_graph' }] });
    const result = await runOpencodeMcpRoundTrip({ binary: '/bin/cbm', loadMcpSdk: async () => sdk });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('mcp_roundtrip_failed');
  });

  it('fails when list_projects reports isError', async () => {
    const { sdk } = makeMcpSdk({ callIsError: true });
    const result = await runOpencodeMcpRoundTrip({ binary: '/bin/cbm', loadMcpSdk: async () => sdk });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('mcp_roundtrip_failed');
  });

  it('fails when the transport cannot connect', async () => {
    const { sdk } = makeMcpSdk({ connectError: new Error('spawn failed') });
    const result = await runOpencodeMcpRoundTrip({ binary: '/bin/cbm', loadMcpSdk: async () => sdk });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('mcp_roundtrip_failed');
  });

  it('times out when the round-trip exceeds the budget', async () => {
    const { sdk } = makeMcpSdk({ hangConnect: true });
    const result = await runOpencodeMcpRoundTrip({
      binary: '/bin/cbm',
      loadMcpSdk: async () => sdk,
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('probe_timeout');
  });
});
