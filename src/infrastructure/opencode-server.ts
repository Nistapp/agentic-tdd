/**
 * opencode server lifecycle manager for the default SDK backend.
 *
 * The indexer gate calls {@link startOpencodeServer} **once per session entry**.
 * It materialises a run-scoped, isolated opencode config directory, boots the
 * SDK-managed `opencode serve` child on a free port, enforces the MCP allowlist
 * (cross-platform leak control), and returns an idempotent
 * {@link IAgentServerHandle} that owns teardown.
 *
 * All OS work goes through injectable seams so unit tests never spawn a real
 * `opencode` child or touch the real filesystem/network.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

import type { IAgentServerHandle, IFileSystem, ILogger } from '../core/interfaces.js';
import { OPENCODE_INDEXER_SERVER_NAME, type GeneratedOpencodeConfig } from './opencode-config.js';

const execFileAsync = promisify(execFile);

const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Structural SDK seams (kept SDK-typed-free so tests can inject plain stubs)
// ---------------------------------------------------------------------------

/** Minimal opencode client surface the gate needs. */
export interface OpencodeGateClient {
  config: { get(): Promise<unknown> };
  mcp: {
    status(): Promise<unknown>;
    disconnect(input: { name: string }): Promise<unknown>;
  };
}

export interface OpencodeSpawnedServer {
  url: string;
  close(): void;
}

export interface OpencodeBootResult {
  client: OpencodeGateClient;
  server: OpencodeSpawnedServer;
}

export interface OpencodeBootOptions {
  hostname: string;
  port: number;
  timeout: number;
  config: GeneratedOpencodeConfig;
}

export type OpencodeBoot = (opts: OpencodeBootOptions) => Promise<OpencodeBootResult>;

/** Applies *env* to the process for the duration of *fn* and restores it after. */
export type EnvScope = <T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
) => Promise<T>;

export type OpencodeServerFailureKind =
  | 'opencode_boot_failed'
  | 'mcp_not_connected'
  | 'mcp_leak';

/** Typed failure raised by server startup (never a bare `Error`). */
export class OpencodeServerError extends Error {
  readonly kind: OpencodeServerFailureKind;

  constructor(kind: OpencodeServerFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OpencodeServerError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Default seams
// ---------------------------------------------------------------------------

const defaultBoot: OpencodeBoot = async (opts) => {
  const { createOpencode } = await import('@opencode-ai/sdk/v2');
  const result = await createOpencode({
    hostname: opts.hostname,
    port: opts.port,
    timeout: opts.timeout,
    config: opts.config as never,
  });
  return result as unknown as OpencodeBootResult;
};

/** Default process-env scope (writes then restores `process.env`). */
export const defaultEnvScope: EnvScope = async (env, fn) => {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/**
 * Default liveness probe: a raw HTTP health request (never a cached session
 * read, which can report stale success after a crash).
 */
export async function defaultIsAlive(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/global/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ask the OS for an ephemeral free TCP port on the loopback interface. */
export async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

type Exec = (cmd: string, args: string[]) => Promise<string>;

function defaultExec(cmd: string, args: string[]): Promise<string> {
  return execFileAsync(cmd, args).then((r) => r.stdout);
}

/** Resolve the `opencode` binary via `which`/`where` (null when absent). */
export async function resolveOpencodeBinary(exec: Exec = defaultExec): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  try {
    const stdout = await exec(isWindows ? 'where' : 'which', [isWindows ? 'opencode.cmd' : 'opencode']);
    const first = stdout.split('\n')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/** Read the installed `opencode` version string (null when unavailable). */
export async function getOpencodeVersion(exec: Exec = defaultExec): Promise<string | null> {
  try {
    const stdout = await exec('opencode', ['--version']);
    const first = stdout.split('\n')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export interface StartOpencodeServerOptions {
  fs: IFileSystem;
  logger: ILogger;
  config: GeneratedOpencodeConfig;
  /** Project root the server operates in. */
  workDir: string;
  /** Run-scoped directory used as the child's `XDG_CONFIG_HOME` (POSIX). */
  runDir: string;
  /** Override the canonical MCP server name. */
  serverName?: string;
  /** Explicit port; a free port is chosen when omitted. */
  port?: number;
  timeoutMs?: number;
  /** Extra child environment (merged over the XDG override). */
  env?: Record<string, string | undefined>;
  // -- Test seams --
  boot?: OpencodeBoot;
  findFreePort?: () => Promise<number>;
  isAlive?: (baseUrl: string) => Promise<boolean>;
  envScope?: EnvScope;
}

/**
 * Boot the opencode server, enforce the MCP allowlist, and return an
 * idempotent handle. Throws an {@link OpencodeServerError} on any failure
 * (after closing a partially-booted server).
 */
export async function startOpencodeServer(
  opts: StartOpencodeServerOptions,
): Promise<IAgentServerHandle> {
  const logger = opts.logger.child({ module: 'opencode-server' });
  const serverName = opts.serverName ?? OPENCODE_INDEXER_SERVER_NAME;
  const boot = opts.boot ?? defaultBoot;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const envScope = opts.envScope ?? defaultEnvScope;

  const configDir = join(opts.runDir, 'opencode');
  const configPath = join(configDir, 'opencode.json');

  // 1. Materialise the run-scoped config directory (create/keep semantics).
  const createdRunDir = !(await opts.fs.exists(opts.runDir));
  if (createdRunDir) {
    await opts.fs.mkdir(configDir);
  }
  let writtenConfig = '';
  if (!(await opts.fs.exists(configPath))) {
    writtenConfig = JSON.stringify(opts.config, null, 2) + '\n';
    await opts.fs.writeFile(configPath, writtenConfig);
  }

  const port = opts.port ?? (await (opts.findFreePort ?? findFreePort)());
  const timeout = opts.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;

  // 2. Boot inside the isolated environment (POSIX XDG override).
  const env: Record<string, string | undefined> = {
    ...(process.platform === 'win32' ? {} : { XDG_CONFIG_HOME: opts.runDir }),
    ...opts.env,
  };

  let booted: OpencodeBootResult;
  try {
    booted = await envScope(env, () =>
      boot({ hostname: '127.0.0.1', port, timeout, config: opts.config }),
    );
  } catch (err) {
    await teardownRunDir(opts.fs, logger, createdRunDir, configPath, opts.runDir, writtenConfig);
    throw new OpencodeServerError('opencode_boot_failed', buildBootFailureMessage(err, port), {
      cause: err,
    });
  }

  let closed = false;
  const closeServer = (): void => {
    try {
      booted.server.close();
    } catch {
      // Best-effort: the child may already be gone.
    }
  };

  // 3. MCP allowlist enforcement (cross-platform leak control).
  try {
    const mergedKeys = readMcpKeys(await booted.client.config.get());
    const extras = mergedKeys.filter((name) => name !== serverName);
    for (const name of extras) {
      try {
        await booted.client.mcp.disconnect({ name });
        logger.info({ name }, 'Disconnected non-allowlisted MCP server');
      } catch (err) {
        logger.warn({ err, name }, 'Failed to disconnect non-allowlisted MCP server');
      }
    }

    const status = readMcpStatus(await booted.client.mcp.status());
    if (status[serverName] !== 'connected') {
      throw new OpencodeServerError(
        'mcp_not_connected',
        `The '${serverName}' indexer MCP server is not connected (status: ${status[serverName] ?? 'missing'}). ` +
          'Check that codebase-memory-mcp is installed and executable.',
      );
    }
    const stillConnected = Object.entries(status)
      .filter(([name, state]) => name !== serverName && state === 'connected')
      .map(([name]) => name);
    if (stillConnected.length > 0) {
      throw new OpencodeServerError(
        'mcp_leak',
        `Non-allowlisted MCP server(s) remain connected after disconnect: ${stillConnected.join(', ')}. ` +
          'Refusing to run with leaked MCP servers.',
      );
    }
  } catch (err) {
    closeServer();
    await teardownRunDir(opts.fs, logger, createdRunDir, configPath, opts.runDir, writtenConfig);
    if (err instanceof OpencodeServerError) throw err;
    throw new OpencodeServerError('mcp_not_connected', err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }

  logger.info({ baseUrl: booted.server.url, port, serverName }, 'opencode server started');

  return {
    baseUrl: booted.server.url,
    async isAlive(): Promise<boolean> {
      return isAlive(booted.server.url);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      closeServer();
      await teardownRunDir(opts.fs, logger, createdRunDir, configPath, opts.runDir, writtenConfig);
      logger.info({ baseUrl: booted.server.url }, 'opencode server closed');
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, exported for unit tests)
// ---------------------------------------------------------------------------

/** Unwrap a hey-api `RequestResult` (`{ data }`) or a raw payload. */
function unwrapData(result: unknown): unknown {
  if (result !== null && typeof result === 'object' && 'data' in result) {
    return (result as { data?: unknown }).data;
  }
  return result;
}

/** Extract the merged MCP server names from a `config.get()` result. */
export function readMcpKeys(result: unknown): string[] {
  const data = unwrapData(result);
  if (data === null || typeof data !== 'object') return [];
  const mcp = (data as { mcp?: unknown }).mcp;
  if (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp)) return [];
  return Object.keys(mcp as Record<string, unknown>);
}

/** Extract a name → status map from an `mcp.status()` result. */
export function readMcpStatus(result: unknown): Record<string, string> {
  const data = unwrapData(result);
  const out: Record<string, string> = {};
  if (data === null || typeof data !== 'object') return out;
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string') {
      out[name] = (value as { status: string }).status;
    }
  }
  return out;
}

function buildBootFailureMessage(err: unknown, port: number): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `Failed to start the opencode server on port ${port}: ${detail}\n` +
    'Check that the `opencode` binary is installed and compatible (tested with 1.18.29), ' +
    `and that port ${port} is free.`
  );
}

async function teardownRunDir(
  fs: IFileSystem,
  logger: ILogger,
  created: boolean,
  configPath: string,
  runDir: string,
  writtenConfig: string,
): Promise<void> {
  if (!created || writtenConfig === '') return;
  try {
    if (await fs.exists(configPath)) {
      const current = await fs.readFile(configPath);
      if (current !== writtenConfig) {
        logger.info({ configPath }, 'Keeping opencode config (modified since creation)');
        return;
      }
    }
    await fs.deleteFile(configPath);
    await fs.deleteDirectory?.(runDir);
  } catch (err) {
    logger.warn({ err, runDir }, 'Failed to tear down run-scoped opencode config');
  }
}
