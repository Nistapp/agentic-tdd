import { vi, describe, it, expect, beforeEach } from 'vitest';

import type { IFileSystem, ILogger } from '../../src/core/interfaces.js';
import {
  CBM_IGNORE_ENTRIES,
  CBM_IGNORE_FILENAME,
  ensureCbmIgnore,
  mergeCbmIgnore,
} from '../../src/infrastructure/indexer-ignore.js';

class StubLogger implements ILogger {
  debug = vi.fn();
  info = vi.fn();
  warn = vi.fn();
  error = vi.fn();
  child(): ILogger {
    return this;
  }
  get level(): string {
    return 'info';
  }
}

function makeFs(overrides: Partial<IFileSystem> = {}): IFileSystem {
  return {
    exists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    readdir: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mergeCbmIgnore', () => {
  it('creates a header + all entries when the file is absent/empty', () => {
    const { content, changed } = mergeCbmIgnore('');
    expect(changed).toBe(true);
    for (const entry of CBM_IGNORE_ENTRIES) {
      expect(content.split('\n')).toContain(entry);
    }
  });

  it('preserves existing rules and appends only the missing entries', () => {
    const { content, changed } = mergeCbmIgnore('node_modules/\n');

    expect(changed).toBe(true);
    expect(content).toContain('node_modules/');
    expect(content.split('\n')).toContain('artefacts/');
    expect(content.split('\n')).toContain('.agentic-tdd/');
  });

  it('is a no-op when every entry is already present (comments and blanks ignored)', () => {
    const existing = `# managed\n${[...CBM_IGNORE_ENTRIES, ''].join('\n')}`;
    const { content, changed } = mergeCbmIgnore(existing);
    expect(changed).toBe(false);
    expect(content).toBe(existing);
  });

  it('does not duplicate an entry already present mid-file', () => {
    const { content, changed } = mergeCbmIgnore('artefacts/\n');
    expect(changed).toBe(true);
    expect(content.split('\n').filter((l) => l === 'artefacts/')).toHaveLength(1);
  });
});

describe('ensureCbmIgnore', () => {
  it('creates the ignore file when absent and reports changed', async () => {
    const fs = makeFs({ exists: vi.fn().mockResolvedValue(false) });
    const result = await ensureCbmIgnore({ fs, workDir: '/proj' });

    expect(result).toEqual({ changed: true, path: `/proj/${CBM_IGNORE_FILENAME}` });
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const written = vi.mocked(fs.writeFile).mock.calls[0]?.[1] ?? '';
    expect(written).toContain('artefacts/');
    expect(written).toContain('artifacts/');
  });

  it('merges missing entries into an existing file', async () => {
    const fs = makeFs({
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue('node_modules/\n'),
    });
    const result = await ensureCbmIgnore({ fs, workDir: '/proj' });

    expect(result.changed).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const written = vi.mocked(fs.writeFile).mock.calls[0]?.[1] ?? '';
    expect(written).toContain('node_modules/');
    expect(written).toContain('artefacts/');
  });

  it('does not rewrite when every entry is already present', async () => {
    const fs = makeFs({
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue([...CBM_IGNORE_ENTRIES, ''].join('\n')),
    });
    const result = await ensureCbmIgnore({ fs, workDir: '/proj' });

    expect(result.changed).toBe(false);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('is best-effort: a write failure is logged and does not throw', async () => {
    const logger = new StubLogger();
    const fs = makeFs({
      exists: vi.fn().mockResolvedValue(false),
      writeFile: vi.fn().mockRejectedValue(new Error('EACCES')),
    });
    const result = await ensureCbmIgnore({ fs, workDir: '/proj', logger });

    expect(result.changed).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
