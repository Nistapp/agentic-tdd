import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';

import { NodeFileSystem } from '../../src/infrastructure/file-system.js';
import { EventBus } from '../../src/infrastructure/event-bus.js';
import { GitService } from '../../src/infrastructure/git-service.js';
import { CommandRunner } from '../../src/infrastructure/command-runner.js';
import type { AgenticEvent } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// NodeFileSystem — real I/O with temp files
// ---------------------------------------------------------------------------

describe('NodeFileSystem', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentic-tdd-fs-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exists returns false for a non-existent path', async () => {
    const fs = new NodeFileSystem();
    expect(await fs.exists(join(dir, 'nope.txt'))).toBe(false);
  });

  it('exists returns true after writeFile', async () => {
    const fs = new NodeFileSystem();
    const path = join(dir, 'hello.txt');
    await fs.writeFile(path, 'hello');
    expect(await fs.exists(path)).toBe(true);
  });

  it('readFile returns the written content', async () => {
    const fs = new NodeFileSystem();
    const path = join(dir, 'data.txt');
    await fs.writeFile(path, 'Hello, World!');
    expect(await fs.readFile(path)).toBe('Hello, World!');
  });

  it('deleteFile removes the file', async () => {
    const fs = new NodeFileSystem();
    const path = join(dir, 'temp.txt');
    await fs.writeFile(path, 'x');
    await fs.deleteFile(path);
    expect(await fs.exists(path)).toBe(false);
  });

  it('deleteFile does not throw on non-existent file', async () => {
    const fs = new NodeFileSystem();
    await expect(fs.deleteFile(join(dir, 'ghost.txt'))).resolves.toBeUndefined();
  });

  it('mkdir creates a directory recursively', async () => {
    const fs = new NodeFileSystem();
    const nested = join(dir, 'a', 'b', 'c');
    await fs.mkdir(nested);
    expect(await fs.exists(nested)).toBe(true);
  });

  it('writeFile creates parent directories automatically', async () => {
    const fs = new NodeFileSystem();
    const path = join(dir, 'deep', 'nested', 'file.txt');
    await fs.writeFile(path, 'deep content');
    expect(await fs.readFile(path)).toBe('deep content');
  });
});

// ---------------------------------------------------------------------------
// EventBus — typed pub/sub
// ---------------------------------------------------------------------------

describe('EventBus', () => {
  it('calls a registered listener when emit fires', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('PASS_STARTED', handler);
    const evt: AgenticEvent = {
      kind: 'PASS_STARTED',
      message: 'Pass 0 started',
      timestamp: new Date(),
      pass: 0,
      passLabel: 'Design & Architecture',
    };
    bus.emit(evt);
    expect(handler).toHaveBeenCalledWith(evt);
  });

  it('does not call a listener for a different event kind', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('PASS_COMPLETED', handler);
    bus.emit({
      kind: 'PASS_STARTED',
      message: 'x',
      timestamp: new Date(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function that stops the listener', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.on('ERROR', handler);
    bus.emit({ kind: 'ERROR', message: 'err1', timestamp: new Date() });
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    bus.emit({ kind: 'ERROR', message: 'err2', timestamp: new Date() });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports multiple listeners on the same event kind', () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('TEST_RUN_COMPLETED', h1);
    bus.on('TEST_RUN_COMPLETED', h2);
    bus.emit({ kind: 'TEST_RUN_COMPLETED', message: 'ok', timestamp: new Date() });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GitService — smoke tests with mocked execa
// ---------------------------------------------------------------------------

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('GitService', () => {
  let execaMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const execaModule = await import('execa');
    execaMock = execaModule.execa as unknown as ReturnType<typeof vi.fn>;
    execaMock.mockReset();
  });

  it('getCurrentBranch returns trimmed stdout', async () => {
    execaMock.mockResolvedValue({ stdout: '  feature/foo\n  ' });
    const git = new GitService();
    expect(await git.getCurrentBranch()).toBe('feature/foo');
  });

  it('isDirty returns true when status has output', async () => {
    execaMock.mockResolvedValue({ stdout: ' M src/file.ts\n' });
    const git = new GitService();
    expect(await git.isDirty()).toBe(true);
  });

  it('isDirty returns false when status output is empty', async () => {
    execaMock.mockResolvedValue({ stdout: '' });
    const git = new GitService();
    expect(await git.isDirty()).toBe(false);
  });

  it('isDirty returns false when git command fails', async () => {
    execaMock.mockRejectedValue(new Error('not a git repo'));
    const git = new GitService();
    expect(await git.isDirty()).toBe(false);
  });

  it('commit returns committed on success', async () => {
    execaMock.mockResolvedValue({ stdout: '', stderr: '' });
    const git = new GitService();
    const result = await git.commit(['file.ts'], 'chore: test');
    expect(result.kind).toBe('committed');
    expect(result.message).toBe('chore: test');
  });

  it('commit returns nothing_to_commit when commit fails with "nothing to commit"', async () => {
    // git add succeeds, git commit fails
    const orig = execaMock.mockResolvedValue;
    execaMock
      .mockResolvedValueOnce({ stdout: '' }) // git add
      .mockRejectedValueOnce(new Error('nothing to commit, working tree clean'));
    const git = new GitService();
    const result = await git.commit(['file.ts'], 'msg');
    expect(result.kind).toBe('nothing_to_commit');
  });

  it('commit returns add_warning when git add fails but commit succeeds', async () => {
    execaMock
      .mockRejectedValueOnce(new Error('add failed')) // git add fails
      .mockResolvedValueOnce({ stdout: '' });  // git commit succeeds
    const git = new GitService();
    const result = await git.commit(['bad.ts'], 'msg');
    expect(result.kind).toBe('add_warning');
  });

  // -- Rebase Pattern: new methods --
  it('getCurrentCommitSha returns trimmed HEAD SHA', async () => {
    execaMock.mockResolvedValue({ stdout: 'abc123def456\n' });
    const git = new GitService();
    expect(await git.getCurrentCommitSha()).toBe('abc123def456');
  });

  it('getLastCompletedPass returns the highest completed pass from git log', async () => {
    execaMock.mockResolvedValue({
      stdout:
        'a1b2c3d chore(ai): completed Pass 3 -- Core Implementation\n' +
        'e4f5g6h chore(ai): completed Pass 1 -- Contracts & Types\n',
    });
    const git = new GitService();
    expect(await git.getLastCompletedPass()).toBe(3);
  });

  it('getLastCompletedPass returns null when no pass commits found', async () => {
    execaMock.mockResolvedValue({ stdout: 'a1b2c3d initial commit\n' });
    const git = new GitService();
    expect(await git.getLastCompletedPass()).toBe(null);
  });

  it('getLastCompletedPass returns null when git log fails', async () => {
    execaMock.mockRejectedValue(new Error('not a git repo'));
    const git = new GitService();
    expect(await git.getLastCompletedPass()).toBe(null);
  });

  it('resetWorkingTree calls git reset --hard HEAD and git clean -fd', async () => {
    execaMock.mockResolvedValue({ stdout: '' });
    const git = new GitService();
    await git.resetWorkingTree();
    expect(execaMock).toHaveBeenCalledWith('git', ['reset', '--hard', 'HEAD']);
    expect(execaMock).toHaveBeenCalledWith('git', ['clean', '-fd']);
  });

  it('abortToSha calls git reset --hard <sha> and git clean -fd', async () => {
    execaMock.mockResolvedValue({ stdout: '' });
    const git = new GitService();
    await git.abortToSha('abc123');
    expect(execaMock).toHaveBeenCalledWith('git', ['reset', '--hard', 'abc123']);
    expect(execaMock).toHaveBeenCalledWith('git', ['clean', '-fd']);
  });
});

// ---------------------------------------------------------------------------
// CommandRunner — smoke tests with mocked execa
// ---------------------------------------------------------------------------

describe('CommandRunner', () => {
  let execaMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const execaModule = await import('execa');
    execaMock = execaModule.execa as unknown as ReturnType<typeof vi.fn>;
    execaMock.mockReset();
  });

  it('runTests returns passed=true when exit code is 0', async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'ok\n', stderr: '' });
    const runner = new CommandRunner();
    const result = await runner.runTests(['npm', 'test']);
    expect(result.passed).toBe(true);
    expect(result.output).toContain('ok');
  });

  it('runTests returns passed=false when exit code is non-zero', async () => {
    execaMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'AssertionError\n' });
    const runner = new CommandRunner();
    const result = await runner.runTests(['pytest']);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('AssertionError');
  });

  it('runOpenCode passes args through to execa and returns output', async () => {
    execaMock.mockImplementation(() => {
      const thenable: any = Promise.resolve({ stdout: 'agent output\n', stderr: '', exitCode: 0 });
      thenable.pid = 12345;
      thenable.stdout = undefined;
      thenable.stderr = undefined;
      thenable.kill = vi.fn();
      return thenable;
    });
    const runner = new CommandRunner();
    const result = await runner.runOpenCode(['run', '--agent', 'pass-0-design-agent']);
    expect(execaMock).toHaveBeenCalledWith('opencode', ['run', '--agent', 'pass-0-design-agent'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(result).toBe('agent output\n\n');
  });

  it('runOpenCode rejects when execa throws', async () => {
    const err = new Error('opencode crashed');
    execaMock.mockImplementation(() => {
      const thenable: any = Promise.reject(err);
      thenable.pid = 12346;
      thenable.stdout = undefined;
      thenable.stderr = undefined;
      thenable.kill = vi.fn();
      thenable.killed = false;
      return thenable;
    });
    const runner = new CommandRunner();
    await expect(runner.runOpenCode(['run', '--agent', 'pass-0-design-agent'])).rejects.toThrow('opencode crashed');
  });
});