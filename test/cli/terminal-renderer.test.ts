import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalRenderer, consoleWriter, fp } from '../../src/cli/terminal-renderer.js';
import type { TerminalWriter } from '../../src/cli/terminal-renderer.js';
import type { PipelineContext } from '../../src/core/types.js';

// -- Stub writer that records all calls ------------------------------------- //

interface StubWriter extends TerminalWriter {
  logs: string[];
  warns: string[];
  errors: string[];
}

function makeWriter(): StubWriter {
  const logs: string[]   = [];
  const warns: string[]  = [];
  const errors: string[] = [];
  return {
    log:   (m) => { logs.push(m); },
    warn:  (m) => { warns.push(m); },
    error: (m) => { errors.push(m); },
    logs, warns, errors,
  };
}

// -- Minimal PipelineContext stub ------------------------------------------- //

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    featureName:          'auth',
    testCmd:              ['npm', 'test'],
    skipHitl:             false,
    maxCorrectionRetries: 3,
    pipelineVersion:      '1.0.0',
    sourceType:           'file',
    logLevel:             'INFO',
    specFileAbsPath:      '/workspace/specs/auth.md',
    featureDescription:   '',
    baseBranch:           undefined,
    originalBaseSha:      '',
    artefactDir:          '/workspace/specs',
    designMmdPath:        '/workspace/specs/auth.mmd',
    specGherkinPath:      '/workspace/specs/auth.gherkin',
    errorLogPath:         '/workspace/specs/.opencode_error.log',
    ...overrides,
  } as PipelineContext;
}

// ===========================================================================
// fp
// ===========================================================================

describe('fp', () => {
  it('returns string padded to max when short enough', () => {
    const result = fp('hello', 10);
    expect(result).toHaveLength(10);
    expect(result).toBe('hello     ');
  });

  it('truncates with leading "..." when longer than max', () => {
    const result = fp('this-is-a-very-long-string', 15);
    expect(result).toHaveLength(15);
    expect(result).toBe('...-long-string');
  });

  it('when longer than max, truncates body to max-3 then prepends "..."', () => {
    const result = fp('abcdefghijklmno', 10);
    expect(result).toHaveLength(10);
    expect(result).toBe('...ijklmno');
  });
});

// ===========================================================================
// TerminalRenderer
// ===========================================================================

describe('TerminalRenderer', () => {
  describe('passHeader', () => {
    it('writes 5 lines: blank / ruler / label / ruler / blank', () => {
      const w = makeWriter();
      new TerminalRenderer(w).passHeader('My Label');
      expect(w.logs).toHaveLength(5);
      expect(w.logs[0]).toBe('');
      expect(w.logs[1]).toBe('━'.repeat(68));
      expect(w.logs[2]).toBe('  My Label');
      expect(w.logs[3]).toBe('━'.repeat(68));
      expect(w.logs[4]).toBe('');
    });

    it('ruler length equals boxWidth (custom 40)', () => {
      const w = makeWriter();
      new TerminalRenderer(w, 40).passHeader('X');
      const rulers = w.logs.filter(l => /^━+$/.test(l));
      expect(rulers).toHaveLength(2);
      expect(rulers[0]).toHaveLength(40);
      expect(rulers[1]).toHaveLength(40);
    });
  });

  describe('passOk', () => {
    it('writes a single line containing the label', () => {
      const w = makeWriter();
      new TerminalRenderer(w).passOk('Pass 3 -- Core Implementation');
      expect(w.logs).toHaveLength(1);
      expect(w.logs[0]).toContain('Pass 3 -- Core Implementation');
      expect(w.logs[0]).toContain('✓');
    });
  });

  describe('gitInfo', () => {
    it('prefixes message with "  [git]  "', () => {
      const w = makeWriter();
      new TerminalRenderer(w).gitInfo('committed changes');
      expect(w.logs).toHaveLength(1);
      expect(w.logs[0]).toBe('  [git]  committed changes');
    });
  });

  describe('warnBox', () => {
    it('routes output through w.warn, not w.log or w.error', () => {
      const w = makeWriter();
      new TerminalRenderer(w).warnBox(['line one', 'line two']);
      expect(w.warns.length).toBeGreaterThan(0);
      expect(w.logs.length).toBe(0);
      expect(w.errors.length).toBe(0);
    });

    it('output contains each input line', () => {
      const w = makeWriter();
      new TerminalRenderer(w).warnBox(['alpha', 'beta']);
      const out = w.warns.join('\n');
      expect(out).toContain('alpha');
      expect(out).toContain('beta');
      expect(out).toContain('⚠');
    });

    it('does not crash with empty lines array', () => {
      const w = makeWriter();
      expect(() => new TerminalRenderer(w).warnBox([])).not.toThrow();
      expect(w.warns.length).toBeGreaterThan(0);
      expect(w.warns.join('')).toContain('⚠');
    });
  });

  describe('banner', () => {
    it('calls w.log (not w.warn or w.error)', () => {
      const w = makeWriter();
      new TerminalRenderer(w).banner(makeCtx());
      expect(w.logs.length).toBeGreaterThan(0);
      expect(w.warns.length).toBe(0);
      expect(w.errors.length).toBe(0);
    });

    it('output contains PIPELINE_VERSION string', () => {
      const w = makeWriter();
      new TerminalRenderer(w).banner(makeCtx());
      const out = w.logs.join('\n');
      expect(out).toContain('v1.0.0');
    });

    it('output contains ctx.specFileAbsPath', () => {
      const w = makeWriter();
      new TerminalRenderer(w).banner(makeCtx());
      const out = w.logs.join('\n');
      expect(out).toContain('/workspace/specs/auth.md');
    });

    it('output contains ctx.sourceType', () => {
      const w = makeWriter();
      new TerminalRenderer(w).banner(makeCtx({ sourceType: 'file' }));
      const out = w.logs.join('\n');
      expect(out).toContain('file');
    });

    it('output contains the joined testCmd', () => {
      const w = makeWriter();
      new TerminalRenderer(w).banner(makeCtx({ testCmd: ['pytest', '-v'] }));
      const out = w.logs.join('\n');
      expect(out).toContain('pytest -v');
    });

    it('shows "disabled (--skip-hitl)" when ctx.skipHitl is true', () => {
      const w = makeWriter();
      new TerminalRenderer(w).banner(makeCtx({ skipHitl: true }));
      const out = w.logs.join('\n');
      expect(out).toContain('disabled (--skip-hitl)');
      expect(out).not.toContain('enabled');
    });

    it('shows "enabled" when ctx.skipHitl is false', () => {
      const w = makeWriter();
      new TerminalRenderer(w).banner(makeCtx({ skipHitl: false }));
      const out = w.logs.join('\n');
      expect(out).toContain('enabled');
      expect(out).not.toContain('disabled');
    });
  });

  describe('fatal', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(
        (_code?: number | string | null | undefined) => { throw new Error('process.exit called'); },
      );
    });

    afterEach(() => exitSpy.mockRestore());

    it('calls process.exit(1)', () => {
      const w = makeWriter();
      const r = new TerminalRenderer(w);
      expect(() => r.fatal('boom')).toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('writes [FATAL] prefix to w.error', () => {
      const w = makeWriter();
      const r = new TerminalRenderer(w);
      try { r.fatal('something went wrong'); } catch { /* swallowed */ }
      expect(w.errors.join('')).toContain('[FATAL]');
      expect(w.errors.join('')).toContain('something went wrong');
    });
  });
});
