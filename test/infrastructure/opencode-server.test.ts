import { describe, it, expect, vi } from 'vitest';

import {
  OpencodeServerError,
  readMcpKeys,
  readMcpStatus,
  startOpencodeServer,
  type OpencodeBootResult,
  type OpencodeGateClient,
} from '../../src/infrastructure/opencode-server.js';
import { buildOpencodeConfig } from '../../src/infrastructure/opencode-config.js';
import type { IFileSystem, ILogger } from '../../src/core/interfaces.js';

// ---------------------------------------------------------------------------
// Stubs
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

function makeFs(initial: Record<string, string> = {}) {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const files = new Map(Object.entries(initial).map(([k, v]) => [norm(k), v]));
  const dirs = new Set<string>();
  const fs: IFileSystem = {
    exists: vi.fn(async (p: string) => files.has(norm(p)) || dirs.has(norm(p))),
    readFile: vi.fn(async (p: string) => {
      const content = files.get(norm(p));
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      files.set(norm(p), c);
    }),
    mkdir: vi.fn(async (p: string) => {
      dirs.add(norm(p));
    }),
    deleteFile: vi.fn(async (p: string) => {
      files.delete(norm(p));
    }),
    renameFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => [...files.keys()]),
    deleteDirectory: vi.fn(async (p: string) => {
      const target = norm(p);
      dirs.delete(target);
      for (const key of [...files.keys()]) if (key.startsWith(target)) files.delete(key);
    }),
  };
  return { fs, files, dirs };
}

function makeClient(opts: { mcpKeys?: string[]; status?: Record<string, string> } = {}) {
  const mcpKeys = opts.mcpKeys ?? ['codebase-memory'];
  const status = opts.status ?? { 'codebase-memory': 'connected' };
  const disconnect = vi.fn(async () => ({}));
  const client: OpencodeGateClient = {
    config: {
      get: vi.fn(async () => ({ data: { mcp: Object.fromEntries(mcpKeys.map((k) => [k, {}])) } })),
    },
    mcp: {
      status: vi.fn(async () => ({
        data: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, { status: v }])),
      })),
      disconnect,
    },
  };
  return { client, disconnect };
}

function makeBoot(result: OpencodeBootResult, close = vi.fn()) {
  const server = { url: 'http://127.0.0.1:4321', close };
  return { boot: vi.fn(async () => ({ ...result, server })), close };
}

const CONFIG = buildOpencodeConfig({ binary: '/bin/cbm', agents: [] });

const BASE_OPTS = {
  logger: new StubLogger(),
  config: CONFIG,
  workDir: '/proj',
  runDir: '/proj/.agentic-tdd/opencode-run-1',
  findFreePort: async () => 4321,
  envScope: async <T>(_env: Record<string, string | undefined>, fn: () => Promise<T>) => fn(),
} as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('readMcpKeys / readMcpStatus', () => {
  it('unwraps { data } envelopes', () => {
    expect(readMcpKeys({ data: { mcp: { a: {}, b: {} } } })).toEqual(['a', 'b']);
    expect(readMcpStatus({ data: { a: { status: 'connected' }, b: { status: 'disabled' } } })).toEqual({
      a: 'connected',
      b: 'disabled',
    });
  });

  it('tolerates malformed payloads', () => {
    expect(readMcpKeys(undefined)).toEqual([]);
    expect(readMcpKeys({ data: { mcp: 'nope' } })).toEqual([]);
    expect(readMcpStatus(null)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// startOpencodeServer
// ---------------------------------------------------------------------------

describe('startOpencodeServer', () => {
  it('starts the server, returns the base URL, and closes idempotently', async () => {
    const { fs, dirs } = makeFs();
    const { client } = makeClient();
    const { boot, close } = makeBoot({ client, server: { url: '', close: vi.fn() } });
    const deleteDirectory = fs.deleteDirectory;

    const handle = await startOpencodeServer({ ...BASE_OPTS, fs, boot });
    expect(handle.baseUrl).toBe('http://127.0.0.1:4321');

    await handle.close();
    await handle.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(deleteDirectory).toHaveBeenCalledWith(BASE_OPTS.runDir);
    expect(dirs.has(BASE_OPTS.runDir)).toBe(false);
  });

  it('reports liveness through the injected raw health probe', async () => {
    const { fs } = makeFs();
    const { client } = makeClient();
    const { boot } = makeBoot({ client, server: { url: '', close: vi.fn() } });
    const isAlive = vi.fn(async () => true);

    const handle = await startOpencodeServer({ ...BASE_OPTS, fs, boot, isAlive });
    await expect(handle.isAlive()).resolves.toBe(true);
    expect(isAlive).toHaveBeenCalledWith('http://127.0.0.1:4321');
  });

  it('wraps boot failure in a typed opencode_boot_failed error with remedy text', async () => {
    const { fs, dirs } = makeFs();
    const boot = vi.fn(async () => {
      throw new Error('spawn opencode ENOENT');
    });

    await expect(startOpencodeServer({ ...BASE_OPTS, fs, boot })).rejects.toMatchObject({
      name: 'OpencodeServerError',
      kind: 'opencode_boot_failed',
    });

    try {
      await startOpencodeServer({ ...BASE_OPTS, fs, boot });
    } catch (err) {
      expect((err as OpencodeServerError).message).toMatch(/opencode/);
      expect((err as OpencodeServerError).message).toMatch(/4321/);
    }
    expect(dirs.has(BASE_OPTS.runDir)).toBe(false);
  });

  it('disconnects non-allowlisted MCP servers and fails on a leak', async () => {
    const { fs } = makeFs();
    const { client, disconnect } = makeClient({
      mcpKeys: ['codebase-memory', 'leaked-server'],
      status: { 'codebase-memory': 'connected', 'leaked-server': 'connected' },
    });
    const { boot, close } = makeBoot({ client, server: { url: '', close: vi.fn() } });

    await expect(startOpencodeServer({ ...BASE_OPTS, fs, boot })).rejects.toMatchObject({
      kind: 'mcp_leak',
    });
    expect(disconnect).toHaveBeenCalledWith({ name: 'leaked-server' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails when the allowlist indexer server is not connected', async () => {
    const { fs } = makeFs();
    const { client } = makeClient({ status: { 'codebase-memory': 'disabled' } });
    const { boot, close } = makeBoot({ client, server: { url: '', close: vi.fn() } });

    await expect(startOpencodeServer({ ...BASE_OPTS, fs, boot })).rejects.toMatchObject({
      kind: 'mcp_not_connected',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the run-scoped config directory when its contents were modified', async () => {
    const { fs, files } = makeFs();
    const { client } = makeClient();
    const { boot } = makeBoot({ client, server: { url: '', close: vi.fn() } });
    const deleteDirectory = fs.deleteDirectory;

    const handle = await startOpencodeServer({ ...BASE_OPTS, fs, boot });
    files.set('/proj/.agentic-tdd/opencode-run-1/opencode/opencode.json', '{"user":"edited"}');

    await handle.close();
    expect(deleteDirectory).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing config file in the run directory', async () => {
    const configPath = '/proj/.agentic-tdd/opencode-run-1/opencode/opencode.json';
    const { fs, files } = makeFs({ [configPath]: '{"existing":true}' });
    const { client } = makeClient();
    const { boot } = makeBoot({ client, server: { url: '', close: vi.fn() } });

    await startOpencodeServer({ ...BASE_OPTS, fs, boot });
    expect(files.get(configPath)).toBe('{"existing":true}');
  });
});
