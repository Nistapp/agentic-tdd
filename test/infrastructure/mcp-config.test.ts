import { vi, describe, it, expect, beforeEach } from 'vitest';

import { writeMcpConfig, teardownMcpConfig, resolveMcpBinary, getMcpTemplateDir } from '../../src/infrastructure/mcp-config.js';
import type { McpConfigResult } from '../../src/infrastructure/mcp-config.js';
import type { IFileSystem, ILogger } from '../../src/core/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPLATE_BODY = JSON.stringify({
  mcpServers: {
    'codebase-memory': { command: '__CODEBASE_MEMORY_MCP_BIN__', args: [], lifecycle: 'lazy' },
  },
});

const RESOLVED_BIN = '/usr/bin/codebase-memory-mcp';

const EXPECTED_COPY = JSON.stringify({
  mcpServers: {
    'codebase-memory': { command: RESOLVED_BIN, args: [], lifecycle: 'lazy' },
  },
}, null, 2) + '\n';

function makeLogger(): ILogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    debug: vi.fn(),
    info(_: string | object, msg?: string) {
      if (msg) messages.push(`info:${msg}`);
      else if (typeof _ === 'string') messages.push(`info:${_}`);
    },
    warn(_: string | object, msg?: string) {
      if (msg) messages.push(`warn:${msg}`);
      else if (typeof _ === 'string') messages.push(`warn:${_}`);
    },
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(), level: 'info',
    } as unknown as ILogger)),
    level: 'info',
  };
}

function makeFs(overrides?: Partial<IFileSystem>): IFileSystem {
  const store = new Map<string, string>();
  return {
    exists: vi.fn(async (path: string) => store.has(path)),
    readFile: vi.fn(async (path: string) => {
      const v = store.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      store.set(path, content);
    }),
    mkdir: vi.fn(async () => undefined),
    deleteFile: vi.fn(async (path: string) => {
      store.delete(path);
    }),
    renameFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// resolveMcpBinary
// ---------------------------------------------------------------------------

describe('resolveMcpBinary', () => {
  it('returns the first line from the which/where output', async () => {
    const fakeExec = vi.fn().mockResolvedValue('/opt/bin/codebase-memory-mcp\n/snap/bin/codebase-memory-mcp\n');
    const bin = await resolveMcpBinary(fakeExec);
    expect(bin).toBe('/opt/bin/codebase-memory-mcp');
  });

  it('throws a descriptive error on non-Windows when lookup fails (no hardcoded fallback)', async () => {
    const fakeExec = vi.fn().mockRejectedValue(new Error('not found'));
    await expect(resolveMcpBinary(fakeExec)).rejects.toThrow(/not found on PATH/);
  });

  it('throws a descriptive error on Windows when lookup fails (no bare-name fallback)', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const fakeExec = vi.fn().mockRejectedValue(new Error('not found'));
    try {
      await expect(resolveMcpBinary(fakeExec)).rejects.toThrow(/not found on PATH/);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// getMcpTemplateDir
// ---------------------------------------------------------------------------

describe('getMcpTemplateDir', () => {
  it('returns a path ending with the dist (or src) parent dir', () => {
    const dir = getMcpTemplateDir();
    expect(dir).toBeTruthy();
    expect(typeof dir).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// writeMcpConfig — absent → copy verbatim
// ---------------------------------------------------------------------------

describe('writeMcpConfig', () => {
  it('copies the template verbatim when .mcp.json is absent', async () => {
    const fs = makeFs();
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (String(path).endsWith('mcp.template.json')) return TEMPLATE_BODY;
      throw new Error(`ENOENT: ${path}`);
    });
    const logger = makeLogger();
    const result = await writeMcpConfig(fs, logger, '/proj', '/tpl/mcp.template.json', RESOLVED_BIN);

    expect(result.created).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.kept).toBe(false);
    expect(result.writtenContent).toBe(EXPECTED_COPY);
    expect(logger.messages.some((m) => m.includes('created'))).toBe(true);
  });

  it('replaces the __CODEBASE_MEMORY_MCP_BIN__ placeholder in the server entry', async () => {
    const fs = makeFs();
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (String(path).endsWith('mcp.template.json')) return TEMPLATE_BODY;
      throw new Error(`ENOENT: ${path}`);
    });
    const logger = makeLogger();
    await writeMcpConfig(fs, logger, '/proj', '/tpl/mcp.template.json', RESOLVED_BIN);

    const writeCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const [, content] = writeCalls.find((c) => c[0] === '/proj/.mcp.json')!;
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers['codebase-memory'].command).toBe(RESOLVED_BIN);
    expect(parsed.mcpServers['codebase-memory'].lifecycle).toBe('lazy');
    expect(content).not.toContain('__CODEBASE_MEMORY_MCP_BIN__');
  });

  it('throws when the template is missing mcpServers.codebase-memory', async () => {
    const fs = makeFs();
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ mcpServers: {} }));
    const logger = makeLogger();
    await expect(writeMcpConfig(fs, logger, '/proj', '/tpl/bad.json', RESOLVED_BIN))
      .rejects.toThrow('missing mcpServers.codebase-memory');
  });
});

// ---------------------------------------------------------------------------
// writeMcpConfig — present → merge or keep
// ---------------------------------------------------------------------------

describe('writeMcpConfig — existing .mcp.json', () => {
  const USER_MCP = JSON.stringify({
    mcpServers: {
      'custom-server': { command: 'node', args: ['server.js'] },
    },
  });

  it('deep-merges the codebase-memory entry when mcpServers exist but the key is absent', async () => {
    const fs = makeFs();
    await fs.writeFile('/proj/.mcp.json', USER_MCP);
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (String(path).endsWith('mcp.template.json')) return TEMPLATE_BODY;
      if (String(path).endsWith('.mcp.json')) return USER_MCP;
      throw new Error(`ENOENT: ${path}`);
    });

    const logger = makeLogger();
    const result = await writeMcpConfig(fs, logger, '/proj', '/tpl/mcp.template.json', RESOLVED_BIN);

    expect(result.created).toBe(false);
    expect(result.merged).toBe(true);
    expect(result.kept).toBe(false);
    expect(result.writtenContent).toBeTruthy();

    const parsed = JSON.parse(result.writtenContent);
    expect(parsed.mcpServers['custom-server']).toBeDefined();
    expect(parsed.mcpServers['codebase-memory'].command).toBe(RESOLVED_BIN);
    expect(logger.messages.some((m) => m.includes('Merged'))).toBe(true);
  });

  it('leaves the file untouched when codebase-memory is already defined', async () => {
    const existingWithCbm = JSON.stringify({
      mcpServers: {
        'codebase-memory': { command: '/usr/local/bin/codebase-memory-mcp', args: ['--debug'] },
        'custom-server': { command: 'node', args: ['server.js'] },
      },
    });

    const fs = makeFs();
    await fs.writeFile('/proj/.mcp.json', existingWithCbm);
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (String(path).endsWith('mcp.template.json')) return TEMPLATE_BODY;
      if (String(path).endsWith('.mcp.json')) return existingWithCbm;
      throw new Error(`ENOENT: ${path}`);
    });

    const logger = makeLogger();
    const result = await writeMcpConfig(fs, logger, '/proj', '/tpl/mcp.template.json', RESOLVED_BIN);

    expect(result.created).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.kept).toBe(true);
    expect(result.writtenContent).toBe('');
    expect(logger.messages.some((m) => m.includes('left untouched'))).toBe(true);
  });

  it('treats an existing .mcp.json with invalid JSON as a no-op and logs a warning', async () => {
    const fs = makeFs();
    await fs.writeFile('/proj/.mcp.json', 'not json!!!');
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (String(path).endsWith('mcp.template.json')) return TEMPLATE_BODY;
      if (String(path).endsWith('.mcp.json')) return 'not json!!!';
      throw new Error(`ENOENT: ${path}`);
    });

    const logger = makeLogger();
    const result = await writeMcpConfig(fs, logger, '/proj', '/tpl/mcp.template.json', RESOLVED_BIN);

    expect(result.created).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.kept).toBe(false);
    expect(result.writtenContent).toBe('');
    expect(logger.messages.some((m) => m.includes('valid JSON'))).toBe(true);
  });

  it('adds codebase-memory when existing .mcp.json has no mcpServers key', async () => {
    const fs = makeFs();
    const existingNoServers = JSON.stringify({ settings: { theme: 'dark' } });
    await fs.writeFile('/proj/.mcp.json', existingNoServers);
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (String(path).endsWith('mcp.template.json')) return TEMPLATE_BODY;
      if (String(path).endsWith('.mcp.json')) return existingNoServers;
      throw new Error(`ENOENT: ${path}`);
    });

    const logger = makeLogger();
    const result = await writeMcpConfig(fs, logger, '/proj', '/tpl/mcp.template.json', RESOLVED_BIN);

    expect(result.merged).toBe(true);
    const parsed = JSON.parse(result.writtenContent);
    expect(parsed.settings.theme).toBe('dark');
    expect(parsed.mcpServers['codebase-memory']).toBeDefined();
  });

  it('calls resolveMcpBinary internally when resolvedBin is not provided', async () => {
    const fs = makeFs();
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (String(path).endsWith('mcp.template.json')) return TEMPLATE_BODY;
      throw new Error(`ENOENT: ${path}`);
    });
    const logger = makeLogger();
    const resolveBinary = vi.fn().mockResolvedValue(RESOLVED_BIN);
    const result = await writeMcpConfig(fs, logger, '/proj', '/tpl/mcp.template.json', undefined, resolveBinary);

    expect(resolveBinary).toHaveBeenCalledOnce();
    expect(result.created).toBe(true);
    const content = JSON.parse(result.writtenContent);
    expect(content.mcpServers['codebase-memory'].command).toBe(RESOLVED_BIN);
  }, 10000);
});

// ---------------------------------------------------------------------------
// teardownMcpConfig
// ---------------------------------------------------------------------------

describe('teardownMcpConfig', () => {
  const RESULT_COPY: McpConfigResult = {
    created: true, merged: false, kept: false, writtenContent: EXPECTED_COPY,
  };

  const RESULT_KEPT: McpConfigResult = {
    created: false, merged: false, kept: true, writtenContent: '',
  };

  const RESULT_MERGED: McpConfigResult = {
    created: false, merged: true, kept: false, writtenContent: EXPECTED_COPY,
  };

  it('deletes .mcp.json when harness-created and content unchanged', async () => {
    const fs = makeFs();
    await fs.writeFile('/proj/.mcp.json', EXPECTED_COPY);
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p) => {
      if (String(p) === '/proj/.mcp.json') return EXPECTED_COPY;
      throw new Error();
    });
    const logger = makeLogger();

    await teardownMcpConfig(fs, logger, '/proj', RESULT_COPY);

    const deleteCalls = (fs.deleteFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(deleteCalls.some((c) => c[0] === '/proj/.mcp.json')).toBe(true);
    expect(logger.messages.some((m) => m.includes('removed'))).toBe(true);
  });

  it('keeps .mcp.json when content has been modified since creation', async () => {
    const fs = makeFs();
    const modified = EXPECTED_COPY.replace('/usr/bin', '/opt/bin');
    await fs.writeFile('/proj/.mcp.json', modified);
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p) => {
      if (String(p) === '/proj/.mcp.json') return modified;
      throw new Error();
    });
    const logger = makeLogger();

    await teardownMcpConfig(fs, logger, '/proj', RESULT_COPY);

    expect((fs.deleteFile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(logger.messages.some((m) => m.includes('keeping'))).toBe(true);
  });

  it('does nothing when the file was not created by the harness (kept case)', async () => {
    const fs = makeFs();
    await fs.writeFile('/proj/.mcp.json', EXPECTED_COPY);
    const logger = makeLogger();

    await teardownMcpConfig(fs, logger, '/proj', RESULT_KEPT);

    expect((fs.deleteFile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('does nothing when the file was merged (not created)', async () => {
    const fs = makeFs();
    await fs.writeFile('/proj/.mcp.json', EXPECTED_COPY);
    const logger = makeLogger();

    await teardownMcpConfig(fs, logger, '/proj', RESULT_MERGED);

    expect((fs.deleteFile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('logs a warning and continues when the filesystem fails during teardown', async () => {
    const fs = makeFs();
    (fs.exists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk error'));
    const logger = makeLogger();

    await teardownMcpConfig(fs, logger, '/proj', RESULT_COPY);

    expect(logger.messages.some((m) => m.includes('Teardown: failed'))).toBe(true);
  });

  it('does nothing when the file does not exist', async () => {
    const fs = makeFs();
    const logger = makeLogger();

    await teardownMcpConfig(fs, logger, '/proj', RESULT_COPY);

    expect((fs.deleteFile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});