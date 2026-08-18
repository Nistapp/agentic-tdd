import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateAndResolveOptions } from '../../src/cli/validators.js';
import { TerminalRenderer, consoleWriter } from '../../src/cli/terminal-renderer.js';

describe('validateAndResolveOptions', () => {
  let workDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'agentic-tdd-val-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (_code?: number | string | null | undefined) => { throw new Error('process.exit called'); },
    );
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    await rm(workDir, { recursive: true, force: true });
  });

  function makeRenderer(): TerminalRenderer {
    return new TerminalRenderer(consoleWriter);
  }

  it('fails when --feature-desc-file is missing', async () => {
    const renderer = makeRenderer();
    await expect(
      validateAndResolveOptions({}, renderer),
    ).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails when --test-cmd is missing (new session)', async () => {
    const renderer = makeRenderer();
    await expect(
      validateAndResolveOptions({ featureDescFile: 'specs/foo.md' }, renderer),
    ).rejects.toThrow('process.exit called');
  });

  it('resolves all options when feature-desc-file and test-cmd are provided', async () => {
    const specDir = join(workDir, 'specs');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'my-feature.md');
    await writeFile(specPath, '# My Feature\n\nImplement a thing.', { flag: 'wx' });

    const renderer = makeRenderer();
    const result = await validateAndResolveOptions({
      featureDescFile: specPath,
      testCmd: 'npm test',
      skipHitl: true,
      logLevel: 'DEBUG',
      baseBranch: 'develop',
    }, renderer);

    expect(result.featureName).toBe('my-feature');
    expect(result.testCmd).toEqual(['npm', 'test']);
    expect(result.skipHitl).toBe(true);
    expect(result.logLevel).toBe('DEBUG');
    expect(result.baseBranch).toBe('develop');
    expect(result.featureDescription).toContain('Implement a thing');
  });

  it('fails when the spec file does not exist', async () => {
    const renderer = makeRenderer();
    await expect(
      validateAndResolveOptions({
        featureDescFile: '/nonexistent/spec.md',
        testCmd: 'npm test',
      }, renderer),
    ).rejects.toThrow('process.exit called');
  });
});
