import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getStateDir, getStateFilePath, getErrorLogPath, getLogDir, sanitizeFilename } from '../../src/utils/paths.js';

describe('getStateDir', () => {
  it('returns .agentic-tdd under the given workDir', () => {
    const dir = getStateDir('/tmp/myproject');
    expect(dir).toBe(join('/tmp/myproject', '.agentic-tdd'));
  });

  it('defaults to cwd() when no workDir is given', () => {
    const dir = getStateDir();
    expect(dir).toContain('.agentic-tdd');
    expect(dir.endsWith('.agentic-tdd')).toBe(true);
  });
});

describe('getStateFilePath', () => {
  it('returns a state file path under .agentic-tdd/', () => {
    const path = getStateFilePath('my-feature', '/tmp/proj');
    expect(path).toBe(join('/tmp/proj', '.agentic-tdd', 'state-my-feature.json'));
  });

  it('sanitises feature names in the filename', () => {
    const path = getStateFilePath('Payment Retry!!', '/tmp/proj');
    expect(path).toContain('state-payment-retry.json');
    expect(path).not.toContain('!!');
  });

  it('defaults workDir to cwd()', () => {
    const path = getStateFilePath('hello');
    expect(path).toContain('.agentic-tdd/state-hello.json');
  });
});

describe('getLogDir', () => {
  it('returns .agentic-tdd/log under the workDir', () => {
    const dir = getLogDir('/tmp/proj');
    expect(dir).toBe(join('/tmp/proj', '.agentic-tdd', 'log'));
  });
});

describe('getErrorLogPath', () => {
  it('returns a feature-scoped error log path under .agentic-tdd/', () => {
    const path = getErrorLogPath('my-feature', '/tmp/proj');
    expect(path).toBe(join('/tmp/proj', '.agentic-tdd', 'error-my-feature.log'));
  });

  it('sanitises feature names in the filename', () => {
    const path = getErrorLogPath('Payment Retry!!', '/tmp/proj');
    expect(path).toContain('error-payment-retry.log');
    expect(path).not.toContain('!!');
  });

  it('defaults workDir to cwd()', () => {
    const path = getErrorLogPath('hello');
    expect(path).toContain('.agentic-tdd/error-hello.log');
  });
});

describe('sanitizeFilename', () => {
  it('lowercases and replaces special chars with hyphens', () => {
    expect(sanitizeFilename('My Feature!!')).toBe('my-feature');
  });

  it('collapses multiple hyphens', () => {
    expect(sanitizeFilename('a@@@b')).toBe('a-b');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeFilename('!!!bad!!!')).toBe('bad');
  });
});
