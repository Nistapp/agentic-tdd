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
  Security           = 5,
  Observability      = 6,
  Documentation      = 7,
}

export const AGENT_NAMES: Record<PipelinePass, string> = {
  [PipelinePass.Design]:             'pass-0-design-agent',
  [PipelinePass.Contracts]:          'pass-1-contracts-agent',
  [PipelinePass.TestGeneration]:     'pass-2-test-generation-agent',
  [PipelinePass.CoreImplementation]: 'pass-3-core-implementation-agent',
  [PipelinePass.Refactor]:           'pass-4-refactor-agent',
  [PipelinePass.Security]:           'pass-5-security-agent',
  [PipelinePass.Observability]:      'pass-6-observability-agent',
  [PipelinePass.Documentation]:      'pass-7-documentation-agent',
};

export const PASS_LABELS: Record<PipelinePass, string> = {
  [PipelinePass.Design]:             'Design & Architecture',
  [PipelinePass.Contracts]:          'Contracts & Types',
  [PipelinePass.TestGeneration]:     'Test Generation (Red Phase)',
  [PipelinePass.CoreImplementation]: 'Core Implementation (Green Phase)',
  [PipelinePass.Refactor]:           'Refactor & Optimise',
  [PipelinePass.Security]:           'Security Hardening',
  [PipelinePass.Observability]:      'Observability & Logging',
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
]);

/** Passes where a git commit is made after the agent completes. */
export const GIT_COMMIT_PASSES = new Set<PipelinePass>([
  PipelinePass.Contracts,
  PipelinePass.TestGeneration,
  PipelinePass.CoreImplementation,
  PipelinePass.Refactor,
  PipelinePass.Security,
  PipelinePass.Observability,
  PipelinePass.Documentation,
]);

/** Default max self-correction retries — matches Python MAX_CORRECTION_RETRIES. */
export const DEFAULT_MAX_CORRECTION_RETRIES = 2;

// ---------------------------------------------------------------------------
// Input source type — matches Python --source-type flag
// ---------------------------------------------------------------------------

export type SourceType = 'file' | 'string' | 'github';

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

  /** If true, skip the human-in-the-loop gate after Pass 0. */
  skipHitl: boolean;

  /** Maximum additional self-correction attempts (default 2 → 3 total). */
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

export interface PassCompletedPayload {
  files?: FileChange[];
  attempts?: number;
  [k: string]: unknown;
}