import { describe, it, expect, vi } from 'vitest';
import type { IFileSystem } from '../../src/core/interfaces.js';
import { AGENT_NAMES } from '../../src/core/types.js';
import {
  stripJsonComments,
  resolveModelConfig,
  KNOWN_AGENTS,
} from '../../src/cli/model-config.js';

const USER_PATH = '/proj/.agentic-tdd/config.json';

const DEFAULT_JSON = JSON.stringify({
  agents: {
    models: {
      'pass-0-design-agent': 'deepseek/deepseek-v4-pro',
      'pass-1-contracts-agent': 'deepseek/deepseek-v4-pro',
      'pass-2-test-generation-agent': 'deepseek/deepseek-v4-pro',
      'pass-3-core-implementation-agent': 'deepseek/deepseek-v4-flash',
      'pass-4-refactor-agent': 'deepseek/deepseek-v4-flash',
      'pass-5-observability-agent': 'deepseek/deepseek-v4-flash',
      'pass-6-security-agent': 'deepseek/deepseek-v4-flash',
      'pass-7-documentation-agent': 'deepseek/deepseek-v4-flash',
    },
  },
});

const isDefaultPath = (p: string): boolean => p.endsWith('config.default.json') && !p.includes('.agentic-tdd');
const isUserPath = (p: string): boolean => p.includes('.agentic-tdd') && p.endsWith('config.json');

function makeFs(options: {
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
} = {}): IFileSystem {
  const exists = options.exists ?? (() => false);
  const readFile = options.readFile ?? (() => { throw new Error(`no file configured: readFile`); });
  return {
    exists: vi.fn(async (p: string) => exists(p)),
    readFile: vi.fn(async (p: string) => readFile(p)),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  };
}

describe('KNOWN_AGENTS', () => {
  it('mirrors the AGENT_NAMES values from src/core/types.ts (all 8 passes)', () => {
    expect(KNOWN_AGENTS).toHaveLength(8);
    expect(KNOWN_AGENTS).toEqual(Object.values(AGENT_NAMES));
  });
});

describe('stripJsonComments', () => {
  it('strips line and block comments', () => {
    const input = '// header\n{ "a": 1 // trailing\n /* mid */ }';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
  });

  it('preserves // and /* inside string literals', () => {
    const input = '{\n  "url": "http://example.com/x",\n  "note": "a /* b */ c"\n}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({
      url: 'http://example.com/x',
      note: 'a /* b */ c',
    });
  });

  it('parses the committed JSONC-style template', () => {
    const input = [
      '// agentic-tdd config template',
      '// references src/core/types.ts',
      '{',
      '  "agents": {',
      '    "models": {',
      '      "pass-0-design-agent": "deepseek/deepseek-v4-pro"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(JSON.parse(stripJsonComments(input))).toEqual({
      agents: { models: { 'pass-0-design-agent': 'deepseek/deepseek-v4-pro' } },
    });
  });
});

describe('resolveModelConfig', () => {
  it('M1: returns empty config when neither default nor user file exists (frontmatter fallback)', async () => {
    const result = await resolveModelConfig({}, { userPath: USER_PATH, fs: makeFs() });
    expect(result).toEqual({});
  });

  it('M2: loads the bundled default with all 8 agents', async () => {
    const fs = makeFs({
      exists: (p) => isDefaultPath(p),
      readFile: (p) => (isDefaultPath(p) ? DEFAULT_JSON : (() => { throw new Error('unexpected read'); })()),
    });
    const result = await resolveModelConfig({}, { userPath: USER_PATH, fs });
    expect(Object.keys(result.models ?? {})).toHaveLength(8);
    expect(result.models?.['pass-0-design-agent']).toBe('deepseek/deepseek-v4-pro');
    expect(result.models?.['pass-7-documentation-agent']).toBe('deepseek/deepseek-v4-flash');
  });

  it('M3: user file merges per-agent-key over the default', async () => {
    const userJson = JSON.stringify({
      agents: { models: { 'pass-7-documentation-agent': 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free' } },
    });
    const fs = makeFs({
      exists: (p) => isDefaultPath(p) || isUserPath(p),
      readFile: (p) => {
        if (isDefaultPath(p)) return DEFAULT_JSON;
        if (isUserPath(p)) return userJson;
        throw new Error('unexpected read');
      },
    });
    const result = await resolveModelConfig({}, { userPath: USER_PATH, fs });
    expect(result.models?.['pass-7-documentation-agent']).toBe('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(result.models?.['pass-0-design-agent']).toBe('deepseek/deepseek-v4-pro');
  });

  it('M4: unknown agent key in a file throws (fail fast)', async () => {
    const badJson = JSON.stringify({ agents: { models: { 'pass-9-wat': 'x/y' } } });
    const fs = makeFs({ exists: (p) => isUserPath(p), readFile: () => badJson });
    await expect(resolveModelConfig({}, { userPath: USER_PATH, fs })).rejects.toThrow(/Unknown agent/);
  });

  it('M5: malformed model string (no slash) throws', async () => {
    const badJson = JSON.stringify({ agents: { models: { 'pass-0-design-agent': 'no-slash' } } });
    const fs = makeFs({ exists: (p) => isUserPath(p), readFile: () => badJson });
    await expect(resolveModelConfig({}, { userPath: USER_PATH, fs })).rejects.toThrow(/provider\/model/);
  });

  it('M6: --config path wins over the default user path', async () => {
    const altJson = JSON.stringify({ agents: { models: { 'pass-0-design-agent': 'google/gemini-2.0-flash' } } });
    const userJson = JSON.stringify({ agents: { models: { 'pass-0-design-agent': 'user/ignored-model' } } });
    const fs = makeFs({
      exists: (p) => isUserPath(p) || p.endsWith('alt-config.json'),
      readFile: (p) => (p.endsWith('alt-config.json') ? altJson : userJson),
    });
    const result = await resolveModelConfig(
      { configPath: '/tmp/alt-config.json' },
      { userPath: USER_PATH, fs },
    );
    expect(result.models?.['pass-0-design-agent']).toBe('google/gemini-2.0-flash');
  });

  it('M7: --model overrides the model for every agent', async () => {
    const result = await resolveModelConfig(
      { model: 'anthropic/claude-sonnet-4' },
      { userPath: USER_PATH, fs: makeFs() },
    );
    for (const name of KNOWN_AGENTS) {
      expect(result.models?.[name]).toBe('anthropic/claude-sonnet-4');
    }
  });

  it('M8: invalid --model shape throws', async () => {
    await expect(
      resolveModelConfig({ model: 'no-slash' }, { userPath: USER_PATH, fs: makeFs() }),
    ).rejects.toThrow(/provider\/model/);
  });

  it('M10: unknown top-level sections are ignored (forward-compat)', async () => {
    const extraJson = JSON.stringify({
      futureSection: { anything: 1 },
      agents: { models: { 'pass-0-design-agent': 'a/b' } },
    });
    const fs = makeFs({ exists: (p) => isUserPath(p), readFile: () => extraJson });
    const result = await resolveModelConfig({}, { userPath: USER_PATH, fs });
    expect(result.models?.['pass-0-design-agent']).toBe('a/b');
  });
});
