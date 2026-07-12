import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execa } from 'execa';
import type { ICommandRunner, IOpencodeSpawner } from '../core/interfaces.js';
import type { TestRunResult } from '../core/types.js';
import { loggers, reqLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENCODE_CONFIG_DIR = resolve(__dirname, '..', '..');
export const PACKAGE_AGENTS_DIR = resolve(OPENCODE_CONFIG_DIR, 'agent');

const OPENCODE_WATCHDOG_INTERVAL_MS = 30_000;
const OPENCODE_HEARTBEAT_THRESHOLD_MS = 120_000;
const OPENCODE_HARD_TIMEOUT_MS = 10 * 60_000;

const OPENCODE_LOG_PATH = (() => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  return `${home}/.local/share/opencode/log/opencode.log`;
})();

function isReadableStream(stream: unknown): stream is { on(event: 'data', fn: (chunk: Buffer) => void): void } {
  return typeof (stream as any)?.on === 'function';
}

export class CommandRunner implements ICommandRunner, IOpencodeSpawner {
  async runTests(testCmd: string[]): Promise<TestRunResult> {
    try {
      reqLogger().debug({ command: testCmd }, 'Executing shell command');
      const result = await execa(testCmd[0]!, testCmd.slice(1), {
        reject: false,
      });
      const stdOutput = result.stdout + '\n' + result.stderr;
      const effectiveOutput =
        stdOutput.trim() === '' && result.exitCode !== 0
          ? ((result as any).shortMessage ?? (result as any).message ?? 'Command failed with no output')
          : stdOutput;
      reqLogger().debug(
        { targetOutput: { stdout: result.stdout, stderr: result.stderr }, exitCode: result.exitCode },
        'Command execution completed'
      );
      return {
        passed: result.exitCode === 0,
        output: effectiveOutput,
      };
    } catch (err) {
      reqLogger().error({ err, command: testCmd }, 'Command execution failed');
      return {
        passed: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async spawn(args: string[]): Promise<string> {
    const child = execa('opencode', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPENCODE_CONFIG_DIR } });

    loggers.core.info({ pid: child.pid, opencode_log: OPENCODE_LOG_PATH }, 'Opencode process spawned');
    reqLogger().debug({ pid: child.pid, command: ['opencode', ...args] }, 'Executing shell command');

    let lastActivity = Date.now();

    const onStreamChunk = (stream: string, chunk: Buffer): void => {
      lastActivity = Date.now();
      const text = chunk.toString();
      reqLogger().debug({ pid: child.pid, stream, chunk: text }, '[opencode]');
    };

    if (isReadableStream(child.stdout)) {
      child.stdout.on('data', (chunk: Buffer) => onStreamChunk('stdout', chunk));
    }
    if (isReadableStream(child.stderr)) {
      child.stderr.on('data', (chunk: Buffer) => onStreamChunk('stderr', chunk));
    }

    let watchdogTimer: ReturnType<typeof setInterval> | undefined;
    let hardTimeout: ReturnType<typeof setTimeout> | undefined;

    watchdogTimer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle >= OPENCODE_HEARTBEAT_THRESHOLD_MS) {
        reqLogger().warn(
          { pid: child.pid, idleSeconds: Math.round(idle / 1000), thresholdMs: OPENCODE_HEARTBEAT_THRESHOLD_MS },
          'Opencode process silent — no stdout/stderr for >= heartbeat threshold',
        );
      }
    }, OPENCODE_WATCHDOG_INTERVAL_MS);

    hardTimeout = setTimeout(() => {
      reqLogger().error(
        { pid: child.pid, timeoutMs: OPENCODE_HARD_TIMEOUT_MS },
        'Opencode hard timeout reached — killing process',
      );
      child.kill('SIGKILL');
    }, OPENCODE_HARD_TIMEOUT_MS);

    try {
      const result = await child;

      if (watchdogTimer) clearInterval(watchdogTimer);
      if (hardTimeout) clearTimeout(hardTimeout);

      reqLogger().debug(
        {
          pid: child.pid,
          exitCode: result.exitCode,
          stdoutLen: result.stdout?.length ?? 0,
          stderrLen: result.stderr?.length ?? 0,
        },
        'Opencode process completed',
      );

      return (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    } catch (err) {
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (hardTimeout) clearTimeout(hardTimeout);

      const isKilled = (err as any)?.isCanceled === true || child.killed;
      reqLogger().error(
        {
          pid: child.pid,
          err,
          killed: isKilled,
          opencode_log: OPENCODE_LOG_PATH,
          hint: `Check ${OPENCODE_LOG_PATH} for opencode's own diagnostics`,
        },
        'Opencode invocation failed',
      );
      throw err;
    }
  }
}
