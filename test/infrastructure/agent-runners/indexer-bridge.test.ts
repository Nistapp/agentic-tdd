import { vi, describe, it, expect } from 'vitest';

import { buildIndexerBridgeTools } from '../../../src/infrastructure/agent-runners/indexer-bridge.js';
import { MCP_INDEXER_SERVER_PREFIX } from '../../../src/infrastructure/agent-runners/pi-sdk-runner.js';
import type { ProcessRunner } from '../../../src/infrastructure/indexer-client.js';

const NAMES = ['search_graph', 'index_repository'].map((n) => `${MCP_INDEXER_SERVER_PREFIX}${n}`);

describe('buildIndexerBridgeTools', () => {
  it('registers one tool per name, each carrying the mcp__codebase-memory__ prefix', () => {
    const tools = buildIndexerBridgeTools(NAMES, { binary: '/bin/codebase-memory-mcp' });
    expect(tools.map((t) => t.name)).toEqual(NAMES);
    for (const tool of tools) {
      expect(tool).toMatchObject({
        label: tool.name,
        description: expect.any(String),
      });
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('executes the indexer one-shot CLI and returns the text payload', async () => {
    const runner: ProcessRunner = vi.fn(async (_file, args, _opts) => {
      const tool = args[1] as string;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          content: [{ type: 'text', text: `{"ok":true,"tool":"${tool}"}` }],
          isError: false,
        }),
        stderr: '',
      };
    });

    const [tool] = buildIndexerBridgeTools(NAMES, { binary: '/bin/codebase-memory-mcp', runner });
    const result = await tool!.execute('t1', { query: 'x' }, undefined, undefined, {} as never);

    expect(runner).toHaveBeenCalledWith(
      '/bin/codebase-memory-mcp',
      ['cli', 'search_graph', JSON.stringify({ query: 'x' })],
      expect.anything(),
    );
    expect(result.content[0]!.text).toBe('{"ok":true,"tool":"search_graph"}');
  });

  it('throws when the binary exits non-zero', async () => {
    const runner: ProcessRunner = vi.fn().mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'boom' });
    const [tool] = buildIndexerBridgeTools(NAMES, { binary: '/bin/codebase-memory-mcp', runner });
    await expect(tool!.execute('t1', {}, undefined, undefined, {} as never)).rejects.toThrow(/exit/);
  });

  it('throws a descriptive error when no binary is resolvable', async () => {
    const [tool] = buildIndexerBridgeTools(NAMES, { binary: null });
    await expect(tool!.execute('t1', {}, undefined, undefined, {} as never)).rejects.toThrow(
      /codebase-memory-mcp binary not found/,
    );
  });
});
