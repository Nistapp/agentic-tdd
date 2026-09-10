import { describe, it, expect } from 'vitest';

import {
  OPENCODE_INDEXER_SERVER_NAME,
  OPENCODE_INDEXER_TOOLS,
  OPENCODE_INDEXER_TOOL_SUFFIXES,
  buildOpencodeConfig,
  isOpencodeIndexerToolName,
  mapPermission,
  opencodeToolName,
  type OpencodeAgentSource,
} from '../../src/infrastructure/opencode-config.js';

describe('canonical indexer tool names', () => {
  it('derives every opencode tool name from the canonical server name', () => {
    expect(OPENCODE_INDEXER_SERVER_NAME).toBe('codebase-memory');
    expect(OPENCODE_INDEXER_TOOLS).toHaveLength(OPENCODE_INDEXER_TOOL_SUFFIXES.length);
    for (const suffix of OPENCODE_INDEXER_TOOL_SUFFIXES) {
      expect(OPENCODE_INDEXER_TOOLS).toContain(`${OPENCODE_INDEXER_SERVER_NAME}_${suffix}`);
    }
  });

  it('uses the single-underscore join scheme (no legacy double underscore)', () => {
    expect(opencodeToolName('search_graph')).toBe('codebase-memory_search_graph');
    expect(OPENCODE_INDEXER_TOOLS.every((name) => !name.includes('__'))).toBe(true);
  });

  it('recognises opencode indexer tool names', () => {
    expect(isOpencodeIndexerToolName('codebase-memory_list_projects')).toBe(true);
    expect(isOpencodeIndexerToolName('mcp__codebase-memory__list_projects')).toBe(false);
    expect(isOpencodeIndexerToolName('bash')).toBe(false);
  });
});

describe('mapPermission', () => {
  it('maps the four core allow keys, expanding glob to list', () => {
    expect(
      mapPermission({ read: 'allow', edit: 'allow', glob: 'allow', grep: 'allow' }),
    ).toEqual({ read: 'allow', edit: 'allow', glob: 'allow', list: 'allow', grep: 'allow' });
  });

  it('preserves explicit deny entries', () => {
    expect(mapPermission({ read: 'allow', bash: 'deny', webfetch: 'deny', task: 'deny' })).toEqual({
      read: 'allow',
      bash: 'deny',
      webfetch: 'deny',
      task: 'deny',
    });
  });

  it('never emits "ask"', () => {
    const mapped = mapPermission({ read: 'ask', edit: 'ask', bash: 'ask' });
    expect(mapped).toEqual({});
    expect(Object.values(mapped)).not.toContain('ask');
  });

  it('returns an empty map for absent / malformed permission blocks', () => {
    expect(mapPermission(undefined)).toEqual({});
    expect(mapPermission(null)).toEqual({});
    expect(mapPermission('allow')).toEqual({});
    expect(mapPermission(['read'])).toEqual({});
  });
});

describe('buildOpencodeConfig', () => {
  const agents: OpencodeAgentSource[] = [
    {
      name: 'pass-0-design-agent',
      description: 'Design',
      model: 'openrouter/deepseek/deepseek-v4-pro',
      prompt: '<body/>',
      permission: { read: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', bash: 'deny' },
    },
    {
      name: 'pass-3-core-implementation-agent',
      description: 'Impl',
      model: 'openrouter/deepseek/deepseek-v4-flash',
      prompt: '<body/>',
      permission: { read: 'allow', edit: 'allow' },
    },
  ];

  it('registers exactly one MCP server under the canonical name', () => {
    const config = buildOpencodeConfig({ binary: '/bin/codebase-memory-mcp', agents });
    expect(Object.keys(config.mcp)).toEqual(['codebase-memory']);
    expect(config.mcp['codebase-memory']).toEqual({
      type: 'local',
      command: ['/bin/codebase-memory-mcp'],
      enabled: true,
    });
  });

  it('builds primary agents with mapped permissions and prompts', () => {
    const config = buildOpencodeConfig({ binary: '/bin/cbm', agents });
    const design = config.agent['pass-0-design-agent'];
    expect(design?.mode).toBe('primary');
    expect(design?.model).toBe('openrouter/deepseek/deepseek-v4-pro');
    expect(design?.prompt).toBe('<body/>');
    expect(design?.permission).toEqual({
      read: 'allow',
      edit: 'allow',
      glob: 'allow',
      list: 'allow',
      grep: 'allow',
      bash: 'deny',
    });
  });

  it('applies per-agent model overrides over the frontmatter model', () => {
    const config = buildOpencodeConfig({
      binary: '/bin/cbm',
      agents,
      models: { 'pass-3-core-implementation-agent': 'deepseek/deepseek-chat' },
    });
    expect(config.agent['pass-3-core-implementation-agent']?.model).toBe('deepseek/deepseek-chat');
  });

  it('uses {env:...} provider api keys', () => {
    const config = buildOpencodeConfig({ binary: '/bin/cbm', agents });
    expect(config.provider['openrouter']?.options.apiKey).toBe('{env:OPENROUTER_API_KEY}');
    expect(config.provider['deepseek']?.options.apiKey).toBe('{env:DEEPSEEK_API_KEY}');
  });

  it('never contains an "ask" permission anywhere', () => {
    const config = buildOpencodeConfig({ binary: '/bin/cbm', agents });
    expect(JSON.stringify(config)).not.toContain('"ask"');
  });

  it('is deterministic', () => {
    const a = buildOpencodeConfig({ binary: '/bin/cbm', agents });
    const b = buildOpencodeConfig({ binary: '/bin/cbm', agents });
    expect(a).toEqual(b);
  });
});
