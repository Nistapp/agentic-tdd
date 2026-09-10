/**
 * Deterministic, one-per-session verification that the mandatory
 * `codebase-memory` indexer is usable by the pipeline (G2 static checks + G3
 * live probe in artefacts/Plan-Mandatory-indexer-gate.md).
 *
 * All failures are **typed result objects** (never throws) so callers and
 * tests can branch on the specific failed check. No real binary or pi session
 * is ever touched in unit tests — every OS seam is injectable.
 */

import { join } from 'node:path';
import { cwd } from 'node:process';

import type { IFileSystem, ILogger } from '../core/interfaces.js';
import { AGENT_NAMES, PipelinePass } from '../core/types.js';
import { PACKAGE_AGENTS_DIR } from '../utils/paths.js';
import { INDEXER_TOOLS, MCP_INDEXER_SERVER_PREFIX, buildToolsAllowlist, isIndexerToolName } from './agent-runners/pi-sdk-runner.js';
import {
  execaProcessRunner,
  resolveIndexerBinary,
  unwrapMcpCliResult,
  type ProcessRunner,
} from './indexer-client.js';
import { buildIndexerBridgeTools } from './agent-runners/indexer-bridge.js';
import { OPENCODE_INDEXER_CORE_TOOL_SUFFIXES } from './opencode-config.js';

export { resolveIndexerBinary, getResolvedIndexerBinary } from './indexer-client.js';

/**
 * Minimum-viable indexer tool set the live probe must see on a session.
 * The probe tolerates additional/newer tools (dynamic discovery) and only
 * fails when one of these core tools is missing.
 */
export const INDEXER_CORE_TOOLS: readonly string[] = [
  'search_graph',
  'get_code_snippet',
  'index_repository',
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type IndexerProbeFailureKind =
  | 'binary_missing'
  | 'binary_not_executable'
  | 'adapter_not_found'
  | 'mcp_entry_missing'
  | 'direct_tools_missing'
  | 'no_model'
  | 'tools_missing'
  | 'binary_unresponsive'
  | 'probe_timeout'
  | 'probe_failed'
  | 'opencode_missing'
  | 'opencode_boot_failed'
  | 'mcp_leak'
  | 'mcp_not_connected'
  | 'mcp_roundtrip_failed';

export interface IndexerProbeFailure {
  kind: IndexerProbeFailureKind;
  message: string;
}

export type IndexerProbeResult =
  | { ok: true }
  | { ok: false; failure: IndexerProbeFailure };

/** Structural view of the pi SDK surface the live probe needs. */
export interface PiSdkLike {
  getAgentDir(): string;
  parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string };
  ModelRuntime: { create(): Promise<unknown> };
  DefaultResourceLoader: new (opts: Record<string, unknown>) => { reload(): Promise<void> };
  SessionManager: { inMemory(workDir?: string): unknown };
  resolveCliModel(opts: { cliModel: string; modelRuntime: unknown }): {
    model?: unknown;
    thinkingLevel?: string;
    warning?: string;
    error?: string;
  };
  createAgentSession(opts: Record<string, unknown>): Promise<{ session: PiSessionLike }>;
}

export interface PiSessionLike {
  getActiveToolNames(): string[];
  getAllTools(): Array<{ name: string }>;
  dispose(): void;
}

export interface ProbeModelConfig {
  models?: Partial<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** Default executable check backed by `access(..., X_OK)`. */
export async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    const [{ access }, { constants }] = await Promise.all([
      import('node:fs/promises'),
      import('node:fs'),
    ]);
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// G2 — static checks (typed results, fast, before any session spawn)
// ---------------------------------------------------------------------------

export interface StaticIndexerProbeDeps {
  fs: IFileSystem;
  logger: ILogger;
  /** Path to the binary (null = not found on PATH). */
  binary: string | null;
  /** Pi agent config dir (e.g. `~/.pi/agent`). */
  agentDir: string;
  /** Project root (defaults to the process cwd). */
  workDir?: string;
  /** Candidate merged-MCP-config files, in adapter merge order. */
  mcpConfigFiles?: string[];
  /** Executable check (defaults to a real `access(X_OK)`). */
  isExecutable?: (path: string) => Promise<boolean>;
}

export type StaticIndexerProbeResult =
  | { ok: true; binary: string }
  | { ok: false; failure: IndexerProbeFailure };

export async function runStaticIndexerChecks(
  deps: StaticIndexerProbeDeps,
): Promise<StaticIndexerProbeResult> {
  const logger = deps.logger.child({ module: 'indexer-static-probe' });
  const workDir = deps.workDir ?? cwd();
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;

  // 1. Binary present + executable.
  if (deps.binary === null) {
    return {
      ok: false,
      failure: {
        kind: 'binary_missing',
        message:
          'codebase-memory-mcp is not on PATH. ' +
          'The indexer is a mandatory harness prerequisite — install it (see its README) ' +
          'before running the pipeline.',
      },
    };
  }
  if (!(await isExecutable(deps.binary))) {
    return {
      ok: false,
      failure: {
        kind: 'binary_not_executable',
        message: `codebase-memory-mcp resolves to '${deps.binary}' but is not executable — check its permissions.`,
      },
    };
  }

  // 2a. pi-mcp-adapter declared in pi's agent settings `packages`.
  const settingsPath = join(deps.agentDir, 'settings.json');
  let adapterDeclared = false;
  if (await deps.fs.exists(settingsPath)) {
    try {
      const parsed = JSON.parse(await deps.fs.readFile(settingsPath)) as { packages?: unknown };
      if (Array.isArray(parsed.packages)) {
        adapterDeclared = parsed.packages.some((p) => typeof p === 'string' && p.includes('pi-mcp-adapter'));
      }
    } catch (err) {
      logger.warn({ err, settingsPath }, 'Could not parse pi agent settings.json');
    }
  }
  if (!adapterDeclared) {
    return {
      ok: false,
      failure: {
        kind: 'adapter_not_found',
        message:
          `pi-mcp-adapter is not declared in '${settingsPath}' packages. ` +
          'Install it via pi\'s package manager (it is the canonical access path for ' +
          'the codebase-memory MCP server) and retry.',
      },
    };
  }

  // 2b. Merged MCP config (as pi-mcp-adapter would resolve it) has a
  //     `codebase-memory` entry and it registers direct tools.
  const candidateFiles = deps.mcpConfigFiles ?? [
    join(workDir, '.mcp.json'),
    join(deps.agentDir, 'mcp.json'),
  ];
  let entryFile: string | undefined;
  let entryHasDirectTools = false;
  for (const candidate of candidateFiles) {
    if (!(await deps.fs.exists(candidate))) continue;
    let parsed: { mcpServers?: Record<string, unknown> };
    try {
      parsed = JSON.parse(await deps.fs.readFile(candidate)) as { mcpServers?: Record<string, unknown> };
    } catch {
      logger.warn({ candidate }, 'Could not parse MCP config file');
      continue;
    }
    const server = parsed.mcpServers?.['codebase-memory'];
    if (server !== null && typeof server === 'object') {
      entryFile = candidate;
      entryHasDirectTools = (server as Record<string, unknown>)['directTools'] === true;
      break;
    }
  }
  if (entryFile === undefined) {
    return {
      ok: false,
      failure: {
        kind: 'mcp_entry_missing',
        message:
          'No `codebase-memory` server entry found in the merged MCP config ' +
          `(checked ${candidateFiles.join(', ')}). ` +
          'Add the server entry (or let the harness write .mcp.json from mcp.template.json) and retry.',
      },
    };
  }
  if (!entryHasDirectTools) {
    return {
      ok: false,
      failure: {
        kind: 'direct_tools_missing',
        message:
          `The 'codebase-memory' server entry in '${entryFile}' lacks "directTools": true. ` +
          'Without it the pi-mcp-adapter registers a single namespace-proxy tool instead of the ' +
          'canonical mcp__codebase-memory__* tools the pipeline allowlists. ' +
          'Fix mcp.template.json (or that config file) and retry.',
      },
    };
  }

  return { ok: true, binary: deps.binary };
}

// ---------------------------------------------------------------------------
// G3 — live probe (once per session start, no LLM prompt, no API cost)
// ---------------------------------------------------------------------------

export interface LiveProbeDeps {
  fs: IFileSystem;
  logger: ILogger;
  /** Resolved indexer binary (proved present by the static checks). */
  binary: string;
  /** Project root (defaults to the process cwd). */
  workDir?: string;
  /** Pi agent config dir (defaults to `sdk.getAgentDir()`). */
  agentDir?: string;
  /** Per-agent model config, used to resolve the probe's Design-pass model. */
  modelConfig?: ProbeModelConfig;
  /** Path to the Design agent file (defaults to the shipped pass-0 agent). */
  agentFile?: string;
  /**
   * Minimum indexer tools the probe must observe (unprefixed, e.g.
   * `search_graph`). Defaults to {@link INDEXER_CORE_TOOLS}. Additional
   * indexer tools are tolerated (dynamic discovery).
   */
  coreTools?: readonly string[];
  /** Lazy pi SDK loader (tests inject a fake). */
  loadPiSdk?: () => Promise<PiSdkLike>;
  /** Process runner for the one-shot `list_projects` response check. */
  runCli?: ProcessRunner;
  /** Whole-probe timeout (defaults to ~30s, matching pi-mcp-adapter init). */
  timeoutMs?: number;
}

const DESIGN_THINKING_LEVEL = 'high';

export async function runLiveIndexerProbe(deps: LiveProbeDeps): Promise<IndexerProbeResult> {
  const loadPiSdk = deps.loadPiSdk ?? (async () => {
    const mod = await import('@earendil-works/pi-coding-agent');
    return mod as unknown as PiSdkLike;
  });
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const workDir = deps.workDir ?? cwd();
  const coreToolNames = (deps.coreTools ?? INDEXER_CORE_TOOLS).map(
    (name) => MCP_INDEXER_SERVER_PREFIX + name,
  );
  const logger = deps.logger.child({ module: 'indexer-live-probe' });
  const agentName = AGENT_NAMES[PipelinePass.Design];

  try {
    return await withProbeTimeout(async (): Promise<IndexerProbeResult> => {
      const sdk = await loadPiSdk();
      const agentDir = deps.agentDir ?? sdk.getAgentDir();
      const agentFile = deps.agentFile ?? join(PACKAGE_AGENTS_DIR, `${agentName}.md`);

      let agentMd: string;
      try {
        agentMd = await deps.fs.readFile(agentFile);
      } catch (err) {
        return {
          ok: false,
          failure: {
            kind: 'no_model',
            message: `Could not read probe agent file '${agentFile}': ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      const { frontmatter, body } = sdk.parseFrontmatter(agentMd);

      const configured = deps.modelConfig?.models?.[agentName];
      const frontmatterModel = typeof frontmatter.model === 'string' ? frontmatter.model : undefined;
      const canonicalModel = configured ?? frontmatterModel;
      if (!canonicalModel) {
        return {
          ok: false,
          failure: {
            kind: 'no_model',
            message:
              `No model configured for probe session (agent '${agentName}'). ` +
              'The indexer probe needs a resolvable model to shape a session exactly like a per-pass session. ' +
              'Passes need models anyway — set agents.models in your agentic-tdd config.',
          },
        };
      }

      let session: PiSessionLike | undefined;
      try {
        const modelRuntime = await sdk.ModelRuntime.create();
        const resolved = sdk.resolveCliModel({
          cliModel: `${canonicalModel}:${DESIGN_THINKING_LEVEL}`,
          modelRuntime,
        });
        if (!resolved.model || resolved.error) {
          return {
            ok: false,
            failure: {
              kind: 'no_model',
              message: resolved.error ?? `No model resolved for '${canonicalModel}'`,
            },
          };
        }

        const tools = buildToolsAllowlist(frontmatter);
        // Register the in-session indexer bridge exactly like a per-pass
        // PiSdkRunner session so the probe proves the real session shape.
        const customTools = buildIndexerBridgeTools(INDEXER_TOOLS, { binary: deps.binary });
        const resourceLoader = new sdk.DefaultResourceLoader({
          cwd: workDir,
          agentDir,
          systemPromptOverride: () => body,
        });
        await resourceLoader.reload();

        const sessionManager = sdk.SessionManager.inMemory(workDir);
        const created = await sdk.createAgentSession({
          model: resolved.model,
          thinkingLevel: resolved.thinkingLevel ?? DESIGN_THINKING_LEVEL,
          tools,
          customTools,
          cwd: workDir,
          agentDir,
          resourceLoader,
          sessionManager,
          modelRuntime,
        });
        session = created.session;

        logger.debug({ activeToolCount: session.getActiveToolNames().length }, 'Probe session created');

        // Dynamic discovery with minimum-viable verification: the probe needs
        // the CORE indexer tools to be present, but tolerates any additional or
        // newer tools the indexer server may register (no exact-set match).
        const activeNames = session.getActiveToolNames();
        const registeredNames = session
          .getAllTools()
          .map((t) => t.name)
          .filter((name) => isIndexerToolName(name));
        const observed = new Set([...activeNames, ...registeredNames]);

        const missing = coreToolNames.filter((name) => !observed.has(name));
        if (missing.length > 0) {
          return {
            ok: false,
            failure: {
              kind: 'tools_missing',
              message: buildToolsMissingMessage(missing),
            },
          };
        }

        // Prove the binary actually responds through the same one-shot CLI the
        // bridge tools use for every per-call execution.
        await assertBinaryResponds(deps.binary, deps.runCli, logger, timeoutMs);

        return { ok: true };
      } finally {
        session?.dispose();
      }
    }, timeoutMs);
  } catch (err) {
    return { ok: false, failure: toProbeFailure(err) };
  }
}

async function assertBinaryResponds(
  binary: string,
  runCli: ProcessRunner | undefined,
  logger: ILogger,
  timeoutMs: number,
): Promise<void> {
  const runner = runCli ?? execaProcessRunner;

  let failureMessage: string | undefined;
  try {
    const res = await runner(binary, ['cli', '--json', 'list_projects'], { timeoutMs });
    if (res.exitCode !== 0) {
      failureMessage = `list_projects exited with code ${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 300)}`;
    } else {
      const structured = unwrapMcpCliResult(res.stdout);
      const err = structured['error'];
      if (typeof err === 'string' && err.trim() !== '') {
        failureMessage = `list_projects reported an error: ${err}`;
      }
    }
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err);
  }

  if (failureMessage !== undefined) {
    logger.error({ binary, failureMessage }, 'Indexer binary did not respond to list_projects');
    throw new BinaryUnresponsiveError(failureMessage);
  }
}

export class BinaryUnresponsiveError extends Error {}

function buildToolsMissingMessage(missing: string[]): string {
  const lines: string[] = [
    'Core indexer tools not reachable on the probe session (indexer version skew or allowlist bug):',
    `  missing: ${missing.join(', ')}`,
    'The harness registers the indexer bridge tools via pi SDK customTools; a missing tool here means ' +
      'the bridge did not register, or the tools allowlist dropped it.',
  ];
  return lines.join('\n');
}

async function withProbeTimeout<T>(body: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return body();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([body(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Indexer probe timed out after ${timeoutMs}ms`);
  }
}

// ---------------------------------------------------------------------------
// Typed-result adapter — maps thrown probe errors to typed failures
// ---------------------------------------------------------------------------

export function toProbeFailure(err: unknown): IndexerProbeFailure {
  if (err instanceof ProbeTimeoutError) {
    return { kind: 'probe_timeout', message: err.message };
  }
  if (err instanceof BinaryUnresponsiveError) {
    return { kind: 'binary_unresponsive', message: err.message };
  }
  return {
    kind: 'probe_failed',
    message: `Indexer live probe failed: ${err instanceof Error ? err.message : String(err)}`,
  };
}

// ---------------------------------------------------------------------------
// opencode-path probes (G2 static + G5 LLM-free MCP round-trip)
// ---------------------------------------------------------------------------

export interface OpencodeStaticDeps {
  logger: ILogger;
  /** Resolved indexer binary (null = not found on PATH). */
  binary: string | null;
  /** Executable check (defaults to a real `access(X_OK)`). */
  isExecutable?: (path: string) => Promise<boolean>;
  /** Resolve the `opencode` binary (defaults to the real `which`). */
  resolveOpencodeBinary?: () => Promise<string | null>;
  /** Read the installed `opencode` version (defaults to the real binary). */
  getOpencodeVersion?: () => Promise<string | null>;
}

export type OpencodeStaticResult =
  | { ok: true; binary: string; opencodeVersion: string | null }
  | { ok: false; failure: IndexerProbeFailure };

/**
 * G2 for the opencode backend: prove the indexer binary is present/executable
 * and the `opencode` binary is resolvable (recording its version).
 */
export async function runOpencodeStaticChecks(deps: OpencodeStaticDeps): Promise<OpencodeStaticResult> {
  const logger = deps.logger.child({ module: 'opencode-static-probe' });
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;

  if (deps.binary === null) {
    return {
      ok: false,
      failure: {
        kind: 'binary_missing',
        message:
          'codebase-memory-mcp is not on PATH. ' +
          'The indexer is a mandatory harness prerequisite — install it (see its README) ' +
          'before running the pipeline.',
      },
    };
  }
  if (!(await isExecutable(deps.binary))) {
    return {
      ok: false,
      failure: {
        kind: 'binary_not_executable',
        message: `codebase-memory-mcp resolves to '${deps.binary}' but is not executable — check its permissions.`,
      },
    };
  }

  const resolveOpencode = deps.resolveOpencodeBinary ?? (async () => {
    const { resolveOpencodeBinary } = await import('./opencode-server.js');
    return resolveOpencodeBinary();
  });
  const opencodeBinary = await resolveOpencode();
  if (opencodeBinary === null) {
    return {
      ok: false,
      failure: {
        kind: 'opencode_missing',
        message:
          'The `opencode` binary is not on PATH. The opencode SDK backend requires it ' +
          '(tested with opencode 1.18.29). Install opencode or run with --backend pi.',
      },
    };
  }

  const getVersion = deps.getOpencodeVersion ?? (async () => {
    const { getOpencodeVersion } = await import('./opencode-server.js');
    return getOpencodeVersion();
  });
  const version = await getVersion();
  logger.info({ opencodeBinary, version }, 'opencode binary resolved');

  return { ok: true, binary: deps.binary, opencodeVersion: version };
}

/** Minimal structural MCP client surface the round-trip needs. */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<{ isError?: boolean }>;
  close(): Promise<void>;
}

/** Minimal structural MCP SDK loader seam (tests inject a stub). */
export interface McpSdkLike {
  createClient(): McpClientLike;
  createTransport(binary: string): unknown;
}

export interface OpencodeRoundTripDeps {
  /** Resolved indexer binary. */
  binary: string;
  /** Whole-probe timeout (defaults to ~30s). */
  timeoutMs?: number;
  /** Core tool suffixes the round-trip must observe (bare MCP names). */
  coreToolSuffixes?: readonly string[];
  /** Lazy MCP SDK loader (tests inject a fake). */
  loadMcpSdk?: () => Promise<McpSdkLike>;
}

const defaultLoadMcpSdk = async (): Promise<McpSdkLike> => {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  return {
    createClient: () => new Client({ name: 'agentic-tdd', version: '0.0.0' }) as unknown as McpClientLike,
    createTransport: (binary) => new StdioClientTransport({ command: binary, args: [], stderr: 'pipe' }),
  };
};

/**
 * G5 — LLM-free direct MCP stdio round-trip against the indexer binary:
 * `initialize` → `tools/list` (assert core tool names) → `tools/call
 * list_projects` (assert `isError !== true`). No LLM prompt, no API cost.
 *
 * Note: the raw MCP protocol exposes **bare** tool names (`search_graph`); the
 * `<serverName>_<tool>` prefix is added by the opencode client when it presents
 * the tools to the model, so it is not asserted here.
 */
export async function runOpencodeMcpRoundTrip(deps: OpencodeRoundTripDeps): Promise<IndexerProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const expected = deps.coreToolSuffixes ?? OPENCODE_INDEXER_CORE_TOOL_SUFFIXES;
  const loadMcpSdk = deps.loadMcpSdk ?? defaultLoadMcpSdk;

  try {
    return await withProbeTimeout(async (): Promise<IndexerProbeResult> => {
      const sdk = await loadMcpSdk();
      const client = sdk.createClient();
      try {
        await client.connect(sdk.createTransport(deps.binary));

        const tools = await client.listTools();
        const names = new Set(tools.tools.map((t) => t.name));
        const missing = expected.filter((name) => !names.has(name));
        if (missing.length > 0) {
          return {
            ok: false,
            failure: {
              kind: 'mcp_roundtrip_failed',
              message:
                `MCP tools/list did not expose the expected core indexer tools: ${missing.join(', ')}. ` +
                'The indexer binary may be an incompatible version.',
            },
          };
        }

        const call = await client.callTool({ name: 'list_projects', arguments: {} });
        if (call.isError === true) {
          return {
            ok: false,
            failure: {
              kind: 'mcp_roundtrip_failed',
              message: 'MCP tools/call list_projects returned isError=true.',
            },
          };
        }

        return { ok: true };
      } finally {
        try {
          await client.close();
        } catch {
          // Best-effort close.
        }
      }
    }, timeoutMs);
  } catch (err) {
    if (err instanceof ProbeTimeoutError) {
      return { ok: false, failure: { kind: 'probe_timeout', message: err.message } };
    }
    return {
      ok: false,
      failure: {
        kind: 'mcp_roundtrip_failed',
        message: `Direct MCP round-trip failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}
