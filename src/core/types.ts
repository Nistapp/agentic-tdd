/**
 * Core types for the agentic-tdd pipeline state machine.
 *
 * Mirrors the data structures and constants defined in the original Python
 * ``cli.py`` (ai-factory-setup/src/agentic_tdd/cli.py).
 *
 * These types are the single source of truth for event shapes, pipeline
 * state, and pass definitions.  Imported by DI interfaces and the engine.
 */

// ---------------------------------------------------------------------------
// Pass definitions — matches AGENTS / PASS_LABELS dicts in Python cli.py
// ---------------------------------------------------------------------------

export enum PipelinePass {
  Design             = 0,
  Contracts          = 1,
  TestGeneration     = 2,
  CoreImplementation = 3,
  Refactor           = 4,
  Observability      = 5,
  Security           = 6,
  Documentation      = 7,
}

export const AGENT_NAMES: Record<PipelinePass, string> = {
  [PipelinePass.Design]:             'pass-0-design-agent',
  [PipelinePass.Contracts]:          'pass-1-contracts-agent',
  [PipelinePass.TestGeneration]:     'pass-2-test-generation-agent',
  [PipelinePass.CoreImplementation]: 'pass-3-core-implementation-agent',
  [PipelinePass.Refactor]:           'pass-4-refactor-agent',
  [PipelinePass.Observability]:      'pass-5-observability-agent',
  [PipelinePass.Security]:           'pass-6-security-agent',
  [PipelinePass.Documentation]:      'pass-7-documentation-agent',
};

export const PASS_LABELS: Record<PipelinePass, string> = {
  [PipelinePass.Design]:             'Design & Architecture',
  [PipelinePass.Contracts]:          'Contracts & Types',
  [PipelinePass.TestGeneration]:     'Test Generation (Red Phase)',
  [PipelinePass.CoreImplementation]: 'Core Implementation (Green Phase)',
  [PipelinePass.Refactor]:           'Refactor & Optimise',
  [PipelinePass.Observability]:      'Observability & Logging',
  [PipelinePass.Security]:           'Security Hardening',
  [PipelinePass.Documentation]:      'Documentation',
};

// ---------------------------------------------------------------------------
// Pass classification helpers (derived from Python main() flow)
// ---------------------------------------------------------------------------

/** Passes whose agent runs are guarded by a self-correction loop. */
export const SELF_CORRECTION_PASSES = new Set<PipelinePass>([
  PipelinePass.CoreImplementation,
  PipelinePass.Refactor,
  PipelinePass.Security,
  PipelinePass.Observability,
  PipelinePass.Documentation,
]);

/** Passes where a git commit is made after the agent completes. */
export const GIT_COMMIT_PASSES = new Set<PipelinePass>([
  PipelinePass.Design,
  PipelinePass.Contracts,
  PipelinePass.TestGeneration,
  PipelinePass.CoreImplementation,
  PipelinePass.Refactor,
  PipelinePass.Security,
  PipelinePass.Observability,
  PipelinePass.Documentation,
]);

/** Default max self-correction retries (3 retries → 4 total attempts per pass). */
export const DEFAULT_MAX_CORRECTION_RETRIES = 3;

/** Passes that trigger a human-in-the-loop gate for manual review. */
export const HITL_GATE_PASSES = new Set<PipelinePass>([
  PipelinePass.Design,
  PipelinePass.TestGeneration,
]);

// ---------------------------------------------------------------------------
// Input source type — matches Python --source-type flag
// ---------------------------------------------------------------------------

export type SourceType = 'file' | 'string' | 'github';

// ---------------------------------------------------------------------------
// PassHistory — append-only record of per-pass progress, files, and errors
// ---------------------------------------------------------------------------

/**
 * Method-level target symbols keyed by file path.
 * Persisted by the WRITER after each committed pass so the READER
 * can assemble per-pass context without re-running git diff or AST.
 */
export type TargetSymbols = Record<string, string[]>;

export interface PassHistory {
  status: 'completed' | 'failed' | 'aborted';
  filesTouched: string[];
  attempts: number;
  lastError?: string;
  /**
   * The commit hash is only known after the git commit. It is written to the
   * state file immediately post-commit (dirty in working tree) and committed
   * as part of the next pass's atomic commit.
   */
  commitHash?: string;
  /** Persisted by WRITER for completed passes — filePath → qualified method names. */
  targetSymbols?: TargetSymbols;
  /** ISO 8601 timestamp when the pass was started. */
  startedAt?: string;
  /** ISO 8601 timestamp when the pass completed. */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// PipelineContext — the state object threaded through every pass
// ---------------------------------------------------------------------------

export interface PipelineContext {
  /**
   * The name of the issue/feature being worked on, derived from the input file.
   */
  featureName: string;

  /** Fully-resolved test command as an argv array. */
  testCmd: string[];

  /** If true, skip the human-in-the-loop gate after Pass 0 (Design) and Pass 2 (TestGeneration). */
  skipHitl: boolean;

  /** Maximum additional self-correction attempts (default 3 → 4 total). */
  maxCorrectionRetries: number;

  /** Pipeline semver string (e.g. "1.0.0"). */
  pipelineVersion: string;

  /** How the input source should be interpreted. */
  sourceType: SourceType;

  /** Logging verbosity ("DEBUG" | "INFO" | "WARNING" | "ERROR"). */
  logLevel: string;

  /** Resolved absolute path of the --feature-desc-file. Used for display, branch naming, and --file attachment. */
  specFileAbsPath?: string;

  /** Full contents of the --spec file; drives Pass 0 in both standard and Autopilot modes. */
  featureDescription?: string;

  /** Optional explicit base branch override for git branching. */
  baseBranch?: string;

  /** SHA of HEAD before the pipeline started, used by --abort to rewind. */
  originalBaseSha?: string;

  // -- Artefact paths --
  /** Directory for specification artefacts (`<stem>.mmd`, `<stem>.gherkin`). */
  artefactDir: string;
  designMmdPath: string;
  specGherkinPath: string;
  errorLogPath: string;

  // -- Runtime-tracking (populated as the pipeline advances) --
  /** Unique UUID for this pipeline run; set at the top of run(). */
  runId?: string;
  currentPass?: PipelinePass;
  currentAttempt?: number;

  /**
   * Append-only history indexed by Pass number (0-7).
   * Initialised as `{}` at the start of `PipelineOrchestrator.run()`.
   * Populated after each pass completes or fails.
   */
  history: Partial<Record<PipelinePass, PassHistory>>;

  /**
   * Persisted XState v5 actor snapshot (`getPersistedSnapshot()` output).
   * Written by the orchestrator after each pass so `--resume` can reboot the
   * pipeline machine losslessly via `createActor(machine, { snapshot })`.
   * Opaque to the core layer — never imported from `xstate` here.
   */
  xstateSnapshot?: Record<string, unknown>;

  /** Flag set by a root-level PAUSE event; honoured at the next inter-pass boundary. */
  pauseRequested?: boolean;
}

// ---------------------------------------------------------------------------
// ExecutionMetadata — per-run context injected into child loggers
// ---------------------------------------------------------------------------

export interface ExecutionMetadata {
  /** Unique UUID per pipeline execution. */
  runId: string;
  /** Optional target file the pipeline is operating on. */
  targetFile?: string;
  /** Optional current pass (numeric, see PipelinePass enum). */
  passId?: PipelinePass;
  /** Optional self-correction attempt counter. */
  attemptCount?: number;
}

// ---------------------------------------------------------------------------
// AgenticEvent — decouples engine from UI
// ---------------------------------------------------------------------------

export type AgenticEventKind =
  | 'PIPELINE_STARTED'
  | 'PIPELINE_COMPLETED'
  | 'PIPELINE_PAUSED'
  | 'PIPELINE_RESUMED'
  | 'PASS_STARTED'
  | 'PASS_COMPLETED'
  | 'TEST_RUN_STARTED'
  | 'TEST_RUN_COMPLETED'
  | 'TEST_RUN_FAILED'
  | 'SELF_CORRECTION_ATTEMPTED'
  | 'HITL_REQUIRED'
  | 'WARNING'
  | 'ERROR';

export interface AgenticEvent {
  /** Discriminant matching one of the AgenticEventKind literals. */
  kind: AgenticEventKind;

  /** Human-readable message. */
  message: string;

  /** When the event was emitted. */
  timestamp: Date;

  /** Which pass this event relates to (0–7). */
  pass?: PipelinePass;

  /** Human-readable pass label for UI display. */
  passLabel?: string;

  /** Optional opaque payload for UI-relevant data. */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PipelineMachineEvent — in-bound events fed to the XState v5 actor (Phase 1+)
//
// Distinct from AgenticEvent (above), which is the *out-bound* UI event bus.
// PipelineMachineEvent are the input events that drive state transitions
// inside the pipeline actor; AgenticEvent are what the actor emits to
// external listeners.  Do not conflate the two.
// ---------------------------------------------------------------------------

export type PipelineMachineEvent =
  | { type: 'START_PIPELINE'; startPass: PipelinePass }
  | { type: 'AGENT_SUCCESS'; pass: PipelinePass }
  | { type: 'AGENT_FAILED'; pass: PipelinePass; error: string }
  | { type: 'TEST_PASSED'; pass: PipelinePass }
  | { type: 'TEST_FAILED'; pass: PipelinePass; output: string }
  | { type: 'SELF_CORRECTION_RETRY'; pass: PipelinePass; attempt: number }
  | { type: 'HITL_APPROVE'; pass: PipelinePass }
  | { type: 'HITL_REJECT'; pass: PipelinePass }
  | { type: 'HITL_REWIND'; pass: PipelinePass }
  | { type: 'COMMIT_SUCCESS'; pass: PipelinePass; commitHash: string }
  | { type: 'COMMIT_FAILED'; pass: PipelinePass; error: string }
  | { type: 'PAUSE' }
  | { type: 'RESUME' };

export type HitlAction = 'APPROVE' | 'REJECT' | 'REWIND';

// ---------------------------------------------------------------------------
// Result types for the DI services (so callers don't work with raw primitives)
// ---------------------------------------------------------------------------

export interface TestRunResult {
  passed: boolean;
  output: string;
}

export interface GitCommitResult {
  kind: 'committed' | 'nothing_to_commit' | 'add_warning';
  message: string;
}

export interface FileChange {
  status: string;
  file: string;
}

export interface HitlPayload {
  files?: FileChange[];
  [k: string]: unknown;
}

export interface PassCompletedPayload {
  files?: FileChange[];
  attempts?: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// ContextFiles — categorised source files for agent context injection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Range — 1-based line range used by git diff and AST symbol resolution
// ---------------------------------------------------------------------------

export interface Range {
  /** 1-based start line (inclusive). */
  start: number;
  /** 1-based end line (inclusive). */
  end: number;
}

/** Parsed result of `git diff --unified=0` — per-file changed line ranges. */
export interface DiffLineChange {
  /** File path as reported by git diff (e.g. `src/foo.ts`). */
  file: string;
  /** Changed line ranges in the *new* file (1-based, inclusive). */
  ranges: Range[];
}

export interface ContextFiles {
  contracts: string[];
  tests: string[];
  implementation: string[];
}

/** The assembled context for a single pass — READER output. */
export interface BuiltContext {
  files: ContextFiles;
  targetSymbols: TargetSymbols;
}

/** Envelope wrapping the persisted state file. Provides forward-compat schema versioning. */
export interface StateFileEnvelope {
  schemaVersion: string;
  context: PipelineContext;
}

// ---------------------------------------------------------------------------
// Agent runner DTOs — the seam between orchestrator and agent invocations
// ---------------------------------------------------------------------------

export interface AgentArtefacts {
  designMmd?: string;
  specGherkin?: string;
  specFile?: string;
  errorLog?: string;
  contextFiles?: ContextFiles;
}

export interface AgentRunRequest {
  pass: PipelinePass;
  prompt: string;
  artefacts: AgentArtefacts;
  runId?: string;
}

export interface AgentRunResult {
  output: string;
}