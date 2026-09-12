/**
 * Thin client over the `codebase-memory-mcp cli <tool> ...` one-shot mode.
 *
 * The indexer binary exposes a CLI mode (`codebase-memory-mcp cli --json
 * <tool> --flags`) that returns an MCP-style JSON envelope on stdout. The
 * harness uses it for the **mandatory index bootstrap** (G6): guarantee the
 * target repo is indexed before Pass 0 dispatches.
 *
 * All process spawning goes through an injected {@link ProcessRunner} so unit
 * tests never touch the real binary.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BINARY_NAME_POSIX = 'codebase-memory-mcp';
const BINARY_NAME_WINDOWS = 'codebase-memory-mcp.cmd';

export interface IndexerCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  opts?: { timeoutMs?: number },
) => Promise<IndexerCliResult>;

/**
 * Default process runner backed by `execa`. `reject: false` so non-zero exits
 * are returned as structured results; spawn/timeout failures reject (the
 * caller maps them to typed failures).
 *
 * `stdin` is ignored: the CLI one-shot reads piped stdin for JSON args, so an
 * execa pipe that never closes would make it block until timeout.
 */
export const execaProcessRunner: ProcessRunner = async (file, args, opts) => {
  const { execa } = await import('execa');
  const result = await execa(file, [...args], {
    reject: false,
    timeout: opts?.timeoutMs,
    stdin: 'ignore',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 1,
  };
};

/** MCP CLI JSON envelope written to stdout by `cli --json <tool>`. */
interface McpCliEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  error?: string;
}

export interface IndexedProject {
  name: string;
  rootPath: string;
}

export interface IndexStatusInfo {
  status?: string;
  headSha?: string;
  project?: string;
}

export type BootstrapOutcome =
  | { kind: 'fresh'; project: string }
  | { kind: 'indexed'; project: string }
  | { kind: 'already_indexed'; project: string }
  | { kind: 'failed'; reason: 'missing_project' | 'reindex_failed' | 'cli_failed' | 'timeout' | 'parse_failed'; message: string };

// ---------------------------------------------------------------------------
// Parsing helpers (pure, exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Unwrap the MCP CLI JSON envelope to the tool's structured content.
 * Throws a {@link Error} when the output is not parseable JSON.
 */
export function unwrapMcpCliResult(stdout: string): Record<string, unknown> {
  const envelope = JSON.parse(stdout.trim()) as McpCliEnvelope;
  if (envelope.structuredContent !== undefined && envelope.structuredContent !== null) {
    if (typeof envelope.structuredContent !== 'object' || Array.isArray(envelope.structuredContent)) {
      throw new Error('indexer CLI returned a non-object structuredContent');
    }
    return envelope.structuredContent as Record<string, unknown>;
  }
  const text = envelope.content?.[0]?.text;
  if (typeof text === 'string' && text.trim() !== '') {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through — surface raw text as an opaque result.
    }
    return { _rawText: text };
  }
  return {};
}

export function toCliErrorMessage(raw: Record<string, unknown>): string | undefined {
  const err = raw['error'];
  return typeof err === 'string' && err.trim() !== '' ? err : undefined;
}

// ---------------------------------------------------------------------------
// IndexerCli — one-shot CLI operations
// ---------------------------------------------------------------------------

export class IndexerCli {
  readonly #binary: string;
  readonly #runner: ProcessRunner;

  constructor(binary: string, runner: ProcessRunner = execaProcessRunner) {
    this.#binary = binary;
    this.#runner = runner;
  }

  #args(tool: string, flags: Array<[string, string | boolean | number]>): string[] {
    const out = ['cli', '--json', tool];
    for (const [flag, value] of flags) {
      out.push(`--${flag}`, String(value));
    }
    return out;
  }

  async #run(
    tool: string,
    flags: Array<[string, string | boolean | number]>,
    timeoutMs?: number,
  ): Promise<{ structured: Record<string, unknown>; error?: string }> {
    let result: IndexerCliResult;
    try {
      result = await this.#runner(this.#binary, this.#args(tool, flags), { timeoutMs });
    } catch (err) {
      const isTimeout = err instanceof Error && /timed? ?out|timeout/i.test(err.message);
      throw new IndexerCliFailure(
        isTimeout ? 'timeout' : 'cli_failed',
        `codebase-memory-mcp ${tool} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new IndexerCliFailure(
        'cli_failed',
        `codebase-memory-mcp ${tool} exited with code ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 400)}`,
      );
    }

    let structured: Record<string, unknown>;
    try {
      structured = unwrapMcpCliResult(result.stdout);
    } catch (err) {
      throw new IndexerCliFailure(
        'parse_failed',
        `Could not parse codebase-memory-mcp ${tool} output: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const error = toCliErrorMessage(structured);
    if (error !== undefined) {
      return { structured, error };
    }
    return { structured };
  }

  async listProjects(timeoutMs?: number): Promise<IndexedProject[]> {
    const { structured, error } = await this.#run('list_projects', [], timeoutMs);
    if (error !== undefined) throw new IndexerCliFailure('cli_failed', error);
    const raw = structured['projects'];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((p): IndexedProject | undefined => {
        if (p === null || typeof p !== 'object') return undefined;
        const rec = p as Record<string, unknown>;
        const name = rec['name'];
        const rootPath = rec['root_path'];
        if (typeof name !== 'string' || typeof rootPath !== 'string') return undefined;
        return { name, rootPath };
      })
      .filter((p): p is IndexedProject => p !== undefined);
  }

  async findProjectForRoot(root: string, timeoutMs?: number): Promise<IndexedProject | undefined> {
    const projects = await this.listProjects(timeoutMs);
    const normalized = normalizeRoot(root);
    return projects.find((p) => normalizeRoot(p.rootPath) === normalized);
  }

  async indexStatus(project: string, timeoutMs?: number): Promise<IndexStatusInfo> {
    const { structured } = await this.#run('index_status', [['project', project], ['verbose', true]], timeoutMs);
    const status = typeof structured['status'] === 'string' ? structured['status'] : undefined;
    const git = structured['git'];
    let headSha: string | undefined;
    if (git !== null && typeof git === 'object') {
      const h = (git as Record<string, unknown>)['head_sha'];
      if (typeof h === 'string') headSha = h;
    }
    const proj = typeof structured['project'] === 'string' ? structured['project'] : undefined;
    return { status, headSha, project: proj };
  }

  async indexRepository(repoPath: string, mode = 'full', timeoutMs?: number): Promise<void> {
    const { structured, error } = await this.#run(
      'index_repository',
      [['repo-path', repoPath], ['mode', mode]],
      timeoutMs,
    );
    if (error !== undefined) {
      throw new IndexerCliFailure('cli_failed', `index_repository reported: ${error}`);
    }
  }
}

export class IndexerCliFailure extends Error {
  readonly kind: 'cli_failed' | 'timeout' | 'parse_failed';

  constructor(kind: IndexerCliFailure['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Normalise a repo root for comparison (strip trailing separators). */
export function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+$/, '');
}

// ---------------------------------------------------------------------------
// Binary resolution (no hardcoded fallback)
// ---------------------------------------------------------------------------

/**
 * Resolve the `codebase-memory-mcp` binary via `which` (POSIX) / `where`
 * (Windows). Returns `null` when it is not on PATH — never a hardcoded
 * fallback. *exec* is injectable for tests.
 */
export async function resolveIndexerBinary(
  exec?: (cmd: string, args: string[]) => Promise<string>,
): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const lookupCmd = isWindows ? 'where' : 'which';
  const lookupArgs = [isWindows ? BINARY_NAME_WINDOWS : BINARY_NAME_POSIX];

  const runner = exec ?? ((cmd: string, args: string[]) =>
    execFileAsync(cmd, args).then((r) => r.stdout)
  );

  try {
    const stdout = await runner(lookupCmd, lookupArgs);
    const firstLine = stdout.split('\n')[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

let cachedBinaryPromise: Promise<string | null> | undefined;

/**
 * Resolve the indexer binary once per process and reuse the result for every
 * bridge tool / CLI call in the run. The gate resolves it first, so the cache
 * is normally warm by the time sessions are created.
 */
export function getResolvedIndexerBinary(): Promise<string | null> {
  cachedBinaryPromise ??= resolveIndexerBinary();
  return cachedBinaryPromise;
}

// ---------------------------------------------------------------------------
// ensureIndexed — the G6 mandatory index bootstrap
// ---------------------------------------------------------------------------

export interface EnsureIndexedDeps {
  binary: string;
  workDir: string;
  /** Runner for the one-shot CLI (defaults to {@link execaProcessRunner}). */
  runner?: ProcessRunner;
  /** Current HEAD SHA of *workDir*; when provided a stale index is refreshed. */
  currentHeadSha?: string;
  /**
   * Force a full reindex even when the index is present and matches
   * *currentHeadSha*. Used when the ignore rules changed (e.g. a new
   * `.cbmignore`) so the exclusion set is guaranteed to take effect.
   */
  force?: boolean;
  /** `index_repository` mode (default `'full'`). */
  mode?: string;
  /** Timeout for a single CLI call (default 120s for indexing, 30s for checks). */
  cliTimeoutMs?: number;
  /** Timeout specifically for `index_repository` (default {@link cliTimeoutMs}). */
  indexTimeoutMs?: number;
  /** Optional client override (unit tests). */
  cli?: IndexerCli;
}

/**
 * Guarantee *workDir* is indexed before the pipeline dispatches Pass 0.
 *
 * Decision ladder:
 *   1. Locate the project by matching `root_path` against *workDir*.
 *   2. If found and `index_status` reports `ready` with a `head_sha` equal to
 *      *currentHeadSha* → fresh, nothing to do. When `force` is set the
 *      freshness shortcut is skipped so changed ignore rules are applied.
 *   3. Otherwise run `index_repository --repo-path <workDir> --mode <mode>`
 *      (absent or stale). A crash/timeout/non-zero exit is a hard failure.
 *
 * The MCP server auto-refreshes watched projects in the background once it is
 * running, so G6 only guarantees the starting state.
 */
export async function ensureIndexed(deps: EnsureIndexedDeps): Promise<BootstrapOutcome> {
  const cli = deps.cli ?? new IndexerCli(deps.binary, deps.runner ?? execaProcessRunner);
  const checkTimeout = deps.cliTimeoutMs ?? 30_000;
  const indexTimeout = deps.indexTimeoutMs ?? 120_000;
  const mode = deps.mode ?? 'full';

  try {
    const project = await cli.findProjectForRoot(deps.workDir, checkTimeout);

    if (project !== undefined) {
      if (deps.force === true) {
        // Ignore rules changed — reindex so the new exclusions take effect.
        return await reindex(cli, deps, mode, indexTimeout);
      }
      if (deps.currentHeadSha === undefined) {
        return { kind: 'already_indexed', project: project.name };
      }
      let info: IndexStatusInfo;
      try {
        info = await cli.indexStatus(project.name, checkTimeout);
      } catch (err) {
        if (err instanceof IndexerCliFailure && err.kind === 'cli_failed') {
          // Project listed but status failed (deleted mid-flight) → reindex.
          return await reindex(cli, deps, mode, indexTimeout);
        }
        throw err;
      }
      if (info.status === 'ready' && info.headSha === deps.currentHeadSha) {
        return { kind: 'fresh', project: project.name };
      }
      // Stale — index is behind the current HEAD.
      return await reindex(cli, deps, mode, indexTimeout);
    }

    return await reindex(cli, deps, mode, indexTimeout);
  } catch (err) {
    if (err instanceof IndexerCliFailure) {
      return {
        kind: 'failed',
        reason: err.kind === 'timeout' ? 'timeout' : err.kind,
        message: err.message,
      };
    }
    return { kind: 'failed', reason: 'cli_failed', message: err instanceof Error ? err.message : String(err) };
  }
}

async function reindex(
  cli: IndexerCli,
  deps: EnsureIndexedDeps,
  mode: string,
  indexTimeout: number,
): Promise<BootstrapOutcome> {
  await cli.indexRepository(deps.workDir, mode, indexTimeout);
  const project = await cli.findProjectForRoot(deps.workDir, deps.cliTimeoutMs ?? 30_000);
  if (project === undefined) {
    return {
      kind: 'failed',
      reason: 'reindex_failed',
      message: `index_repository succeeded but no project was registered for '${deps.workDir}'`,
    };
  }
  return { kind: 'indexed', project: project.name };
}
