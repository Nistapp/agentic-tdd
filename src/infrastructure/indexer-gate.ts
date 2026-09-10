/**
 * Mandatory indexer gate — backend-aware composition point.
 *
 * For the default `opencode` backend the gate owns the opencode server: it
 * starts it once per session entry, enforces the MCP allowlist, proves the
 * indexer binary answers a direct MCP round-trip (LLM-free), bootstraps the
 * index, and hands the server handle to the pipeline. For the backup `pi`
 * backend it preserves the existing static + live probe path and returns no
 * server.
 *
 * Any failure returns an actionable {@link IndexerGateResult} that the caller
 * renders via `renderer.fatal` (non-zero exit) before any pass dispatches. All
 * OS work stays behind injectable seams; no real binary/server is touched in
 * unit tests.
 */

import { join } from 'node:path';
import { cwd } from 'node:process';

import type { IAgentServerHandle, IFileSystem, IGitService, ILogger } from '../core/interfaces.js';
import { AGENT_NAMES } from '../core/types.js';
import type { IndexerStatus } from '../core/types.js';
import { PACKAGE_AGENTS_DIR, getStateDir } from '../utils/paths.js';
import {
  ensureIndexed,
  type BootstrapOutcome,
  type ProcessRunner,
} from './indexer-client.js';
import {
  defaultIsExecutable,
  resolveIndexerBinary,
  runLiveIndexerProbe,
  runOpencodeMcpRoundTrip,
  runOpencodeStaticChecks,
  runStaticIndexerChecks,
  type IndexerProbeFailure,
  type LiveProbeDeps,
  type McpSdkLike,
  type PiSdkLike,
  type ProbeModelConfig,
  type StaticIndexerProbeResult,
} from './indexer-probe.js';
import {
  buildOpencodeConfig,
  OPENCODE_INDEXER_SERVER_NAME,
  type GeneratedOpencodeConfig,
  type OpencodeAgentSource,
} from './opencode-config.js';
import {
  OpencodeServerError,
  startOpencodeServer,
  type EnvScope,
  type OpencodeBoot,
} from './opencode-server.js';

export type IndexerGateResult =
  | { ok: true; server?: IAgentServerHandle; indexerStatus: IndexerStatus }
  | { ok: false; message: string };

export interface IndexerGateDeps {
  fs: IFileSystem;
  git: IGitService;
  logger: ILogger;
  /**
   * Selected `--backend`. Defaults to `opencode`. `opencode-cli` is a fatal
   * exit while the indexer gate is mandatory.
   */
  backend?: string;
  /** Project root to probe/index (defaults to the process cwd). */
  workDir?: string;
  /** Pi agent config dir; when omitted resolved via the pi SDK's `getAgentDir()`. */
  agentDir?: string;
  /** Per-agent model config used to resolve the probe's Design-pass model. */
  modelConfig?: ProbeModelConfig;
  /** Test seams (defaults exercise the real binary/session only at runtime). */
  resolveBinary?: () => Promise<string | null>;
  isExecutable?: (path: string) => Promise<boolean>;
  loadPiSdk?: () => Promise<PiSdkLike>;
  runCli?: ProcessRunner;
  currentHeadSha?: string;
  indexMode?: string;
  cliTimeoutMs?: number;
  indexTimeoutMs?: number;

  // -- opencode backend seams --
  /** Canonical MCP server name (defaults to `codebase-memory`). */
  serverName?: string;
  /** Resolve the `opencode` binary. */
  resolveOpencodeBinary?: () => Promise<string | null>;
  /** Read the installed `opencode` version. */
  getOpencodeVersion?: () => Promise<string | null>;
  /** Parse a pass file's YAML frontmatter + body. */
  parseFrontmatter?: (content: string) => Promise<{ frontmatter: Record<string, unknown>; body: string }>;
  /** Directory holding the 8 pass agent files (defaults to the shipped package). */
  agentsDir?: string;
  /** Run-scoped isolated config directory (defaults to `.agentic-tdd/opencode-run-<id>`). */
  runDir?: string;
  /** Unique run id used in the default run-dir name. */
  runId?: string;
  /** Explicit opencode server port. */
  port?: number;
  /** SDK boot seam. */
  boot?: OpencodeBoot;
  /** Free-port selector seam. */
  findFreePort?: () => Promise<number>;
  /** Raw HTTP liveness probe seam. */
  isAlive?: (baseUrl: string) => Promise<boolean>;
  /** Process-env scope seam (XDG isolation). */
  envScope?: EnvScope;
  /** MCP SDK loader seam for the LLM-free round-trip. */
  loadMcpSdk?: () => Promise<McpSdkLike>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const defaultLoadPiSdk = async (): Promise<PiSdkLike> => {
  const mod = await import('@earendil-works/pi-coding-agent');
  return mod as unknown as PiSdkLike;
};

const defaultParseFrontmatter = async (
  content: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string }> => {
  const sdk = await defaultLoadPiSdk();
  return sdk.parseFrontmatter(content);
};

export async function ensureIndexerAccess(deps: IndexerGateDeps): Promise<IndexerGateResult> {
  const workDir = deps.workDir ?? cwd();
  const backend = deps.backend ?? 'opencode';

  // G1 — backend gate.
  if (backend === 'opencode-cli') {
    return {
      ok: false,
      message:
        "backend 'opencode-cli' is not supported while the indexer gate is mandatory (G1) — " +
        'use --backend opencode (the SDK server backend).',
    };
  }
  if (backend !== 'opencode' && backend !== 'pi') {
    return {
      ok: false,
      message:
        `unknown backend '${backend}' — supported backends are opencode (default), pi and opencode-cli.`,
    };
  }

  if (backend === 'opencode') {
    return ensureOpencodeAccess(deps, workDir);
  }
  return ensurePiAccess(deps, workDir);
}

// ---------------------------------------------------------------------------
// opencode path (default): G2 static → G3/G4 server → G5 round-trip → G6
// ---------------------------------------------------------------------------

async function ensureOpencodeAccess(deps: IndexerGateDeps, workDir: string): Promise<IndexerGateResult> {
  const serverName = deps.serverName ?? OPENCODE_INDEXER_SERVER_NAME;

  // G2 — static checks (indexer + opencode binary).
  const resolveBinary = deps.resolveBinary ?? resolveIndexerBinary;
  const binary = await resolveBinary();

  const staticResult = await runOpencodeStaticChecks({
    logger: deps.logger,
    binary,
    isExecutable: deps.isExecutable ?? defaultIsExecutable,
    resolveOpencodeBinary: deps.resolveOpencodeBinary,
    getOpencodeVersion: deps.getOpencodeVersion,
  });
  if (!staticResult.ok) {
    return { ok: false, message: formatFailure(staticResult.failure) };
  }
  const binaryPath = staticResult.binary;

  // Build the isolated, run-scoped opencode config.
  let config: GeneratedOpencodeConfig;
  try {
    config = await buildOpencodeConfigFromAgents(deps, binaryPath, serverName);
  } catch (err) {
    return {
      ok: false,
      message: formatFailure({
        kind: 'probe_failed',
        message: `Could not build the opencode agent config: ${err instanceof Error ? err.message : String(err)}`,
      }),
    };
  }

  // G3/G4 — start the server and enforce the MCP allowlist.
  const runDir = deps.runDir ?? join(getStateDir(workDir), `opencode-run-${deps.runId ?? Date.now()}`);
  let server: IAgentServerHandle;
  try {
    server = await startOpencodeServer({
      fs: deps.fs,
      logger: deps.logger,
      config,
      workDir,
      runDir,
      serverName,
      port: deps.port,
      boot: deps.boot,
      findFreePort: deps.findFreePort,
      isAlive: deps.isAlive,
      envScope: deps.envScope,
    });
  } catch (err) {
    if (err instanceof OpencodeServerError) {
      return { ok: false, message: formatFailure({ kind: err.kind, message: err.message }) };
    }
    return {
      ok: false,
      message: formatFailure({
        kind: 'opencode_boot_failed',
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  // G5 — LLM-free direct MCP round-trip against the same binary.
  const roundTrip = await runOpencodeMcpRoundTrip({
    binary: binaryPath,
    timeoutMs: deps.cliTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    loadMcpSdk: deps.loadMcpSdk,
  });
  if (!roundTrip.ok) {
    await server.close();
    return { ok: false, message: formatFailure(roundTrip.failure) };
  }

  // G6 — mandatory index bootstrap (unchanged CLI path).
  const bootstrap = await runBootstrap(deps, binaryPath, workDir);
  if (!bootstrap.ok) {
    await server.close();
    return bootstrap;
  }

  deps.logger.info(
    { workDir, project: bootstrap.project, baseUrl: server.baseUrl },
    'Indexer gate passed (opencode)',
  );
  return {
    ok: true,
    server,
    indexerStatus: { available: true, indexed: true, project: bootstrap.project },
  };
}

async function buildOpencodeConfigFromAgents(
  deps: IndexerGateDeps,
  binary: string,
  serverName: string,
): Promise<GeneratedOpencodeConfig> {
  const agentsDir = deps.agentsDir ?? PACKAGE_AGENTS_DIR;
  const parseFrontmatter = deps.parseFrontmatter ?? defaultParseFrontmatter;

  const agents: OpencodeAgentSource[] = [];
  for (const name of Object.values(AGENT_NAMES)) {
    const content = await deps.fs.readFile(join(agentsDir, `${name}.md`));
    const { frontmatter, body } = await parseFrontmatter(content);
    const source: OpencodeAgentSource = { name, prompt: body };
    if (typeof frontmatter.description === 'string') source.description = frontmatter.description;
    if (typeof frontmatter.model === 'string') source.model = frontmatter.model;
    source.permission = frontmatter.permission;
    agents.push(source);
  }

  return buildOpencodeConfig({ binary, serverName, agents, models: deps.modelConfig?.models });
}

// ---------------------------------------------------------------------------
// pi path (backup): G2 static → G3 live probe → G6 (no server)
// ---------------------------------------------------------------------------

async function ensurePiAccess(deps: IndexerGateDeps, workDir: string): Promise<IndexerGateResult> {
  // G2 — static checks. Binary resolution first so a missing binary fails
  // before the (heavier) pi SDK is loaded.
  const resolveBinary = deps.resolveBinary ?? resolveIndexerBinary;
  const binary = await resolveBinary();

  // The pi agent dir is only needed once the binary is present; resolving it
  // lazily keeps a missing-binary failure free of a pi SDK import.
  let agentDir = deps.agentDir;
  if (agentDir === undefined && binary !== null) {
    agentDir = (await (deps.loadPiSdk ?? defaultLoadPiSdk)()).getAgentDir();
  }

  const staticResult: StaticIndexerProbeResult = await runStaticIndexerChecks({
    fs: deps.fs,
    logger: deps.logger,
    binary,
    agentDir: agentDir ?? '',
    workDir,
    isExecutable: deps.isExecutable ?? defaultIsExecutable,
  });
  if (!staticResult.ok) {
    return { ok: false, message: formatFailure(staticResult.failure) };
  }
  const binaryPath = staticResult.binary;

  // G3 — live probe (post-G4 allowlist), shaped exactly like a per-pass session.
  const liveProbeDeps: LiveProbeDeps = {
    fs: deps.fs,
    logger: deps.logger,
    binary: binaryPath,
    workDir,
    agentDir: agentDir ?? '',
    modelConfig: deps.modelConfig,
    loadPiSdk: deps.loadPiSdk ?? defaultLoadPiSdk,
    runCli: deps.runCli,
    timeoutMs: deps.cliTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };
  const liveResult = await runLiveIndexerProbe(liveProbeDeps);
  if (!liveResult.ok) {
    return { ok: false, message: formatFailure(liveResult.failure) };
  }

  // G6 — mandatory index bootstrap.
  const bootstrap = await runBootstrap(deps, binaryPath, workDir);
  if (!bootstrap.ok) return bootstrap;

  deps.logger.info({ workDir, project: bootstrap.project }, 'Indexer gate passed (pi)');
  return {
    ok: true,
    indexerStatus: { available: true, indexed: true, project: bootstrap.project },
  };
}

// ---------------------------------------------------------------------------
// G6 — mandatory index bootstrap (shared by both backends)
// ---------------------------------------------------------------------------

type BootstrapResult =
  | { ok: true; project: string }
  | { ok: false; message: string };

async function runBootstrap(
  deps: IndexerGateDeps,
  binaryPath: string,
  workDir: string,
): Promise<BootstrapResult> {
  let currentHeadSha = deps.currentHeadSha;
  if (currentHeadSha === undefined) {
    try {
      currentHeadSha = await deps.git.getCurrentCommitSha();
    } catch {
      // Not a git repo at gate time → skip the freshness comparison; the
      // presence check still runs (index_repository handles the repo itself).
    }
  }

  const outcome: BootstrapOutcome = await ensureIndexed({
    binary: binaryPath,
    workDir,
    currentHeadSha,
    runner: deps.runCli,
    mode: deps.indexMode,
    cliTimeoutMs: deps.cliTimeoutMs,
    indexTimeoutMs: deps.indexTimeoutMs,
  });
  if (outcome.kind === 'failed') {
    return { ok: false, message: formatBootstrapFailure(outcome) };
  }
  return { ok: true, project: outcome.project };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatFailure(failure: IndexerProbeFailure): string {
  return `[${failure.kind}] ${failure.message}`;
}

function formatBootstrapFailure(outcome: Extract<BootstrapOutcome, { kind: 'failed' }>): string {
  return `Index bootstrap failed (${outcome.reason}): ${outcome.message}`;
}
