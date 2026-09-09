/**
 * Mandatory indexer gate — G7 wiring in
 * artefacts/Plan-Mandatory-indexer-gate.md.
 *
 * Composes, once per session start:
 *   G1 backend gate → G2 static checks → G3 live probe → G6 index bootstrap.
 *
 * Any failure returns an actionable {@link IndexerGateResult} that the caller
 * renders via `renderer.fatal` (non-zero exit) before any pass dispatches.
 * All OS work stays behind injectable seams; no real binary/pi session is
 * touched in unit tests.
 */

import { cwd } from 'node:process';

import type { IFileSystem, IGitService, ILogger } from '../core/interfaces.js';
import {
  ensureIndexed,
  type BootstrapOutcome,
  type ProcessRunner,
} from './indexer-client.js';
import {
  defaultIsExecutable,
  resolveIndexerBinary,
  runLiveIndexerProbe,
  runStaticIndexerChecks,
  type IndexerProbeFailure,
  type LiveProbeDeps,
  type PiSdkLike,
  type ProbeModelConfig,
  type StaticIndexerProbeResult,
} from './indexer-probe.js';

export type IndexerGateResult =
  | { ok: true }
  | { ok: false; message: string };

export interface IndexerGateDeps {
  fs: IFileSystem;
  git: IGitService;
  logger: ILogger;
  /** Selected `--backend`. `opencode-cli` is a fatal exit while the gate is mandatory. */
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
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const defaultLoadPiSdk = async (): Promise<PiSdkLike> => {
  const mod = await import('@earendil-works/pi-coding-agent');
  return mod as unknown as PiSdkLike;
};

export async function ensureIndexerAccess(deps: IndexerGateDeps): Promise<IndexerGateResult> {
  const workDir = deps.workDir ?? cwd();

  // G1 — backend gate: only `pi` is supported while the indexer is mandatory.
  if (deps.backend !== undefined && deps.backend !== 'pi') {
    return {
      ok: false,
      message:
        `backend '${deps.backend}' is not supported while the indexer gate is mandatory — ` +
        'see artefacts/Plan-Mandatory-indexer-gate.md (G1).',
    };
  }

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

  // G6 — mandatory index bootstrap (guarantee the starting state).
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

  deps.logger.info(
    { workDir, project: outcome.project, outcome: outcome.kind },
    'Indexer gate passed',
  );
  return { ok: true };
}

function formatFailure(failure: IndexerProbeFailure): string {
  return `[${failure.kind}] ${failure.message}`;
}

function formatBootstrapFailure(outcome: Extract<BootstrapOutcome, { kind: 'failed' }>): string {
  return `Index bootstrap failed (${outcome.reason}): ${outcome.message}`;
}
