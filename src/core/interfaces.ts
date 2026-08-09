/**
 * Dependency-injection contracts for the agentic-tdd pipeline engine.
 *
 * Every OS-side-effect (spawning processes, reading files, emitting events)
 * is expressed as an abstract interface.  The state machine only depends on
 * these contracts — never on ``child_process.execSync``, ``fs.writeFileSync``,
 * or any concrete logger.  This makes the engine:
 *
 *   - fully unit-testable (inject mocks),
 *   - embeddable in a VS Code extension (swap out the CLI implementation).
 */

import type { PipelineContext, AgenticEvent, AgenticEventKind, GitCommitResult, TestRunResult, FileChange, Range, DiffLineChange, AgentRunRequest, AgentRunResult, BuiltContext, PipelinePass, CreateFeatureBranchOutcome } from './types.js';

// ---------------------------------------------------------------------------
// IGitService — git operations that the pipeline engine needs
// ---------------------------------------------------------------------------

export interface IGitService {
  /**
   * Stage *files* and create an atomic commit.
   *
   * Implementation must gracefully handle:
   *   - git not availabe on PATH → log warning, return ``{ kind: 'add_warning' }``
   *   - no changes to commit → return ``{ kind: 'nothing_to_commit' }``
   *
   * @returns An {@link GitCommitResult} describing what happened.
   */
  commit(files: string[], message: string): Promise<GitCommitResult>;

  /** Retrieve the list of uncommitted file changes (status and path). */
  getPendingChanges(): Promise<FileChange[]>;

  /** Return the name of the currently active branch. */
  getCurrentBranch(): Promise<string>;

  /** Return `true` when the working directory has uncommitted changes. */
  isDirty(): Promise<boolean>;

  /** Return the SHA of the current HEAD commit. */
  getCurrentCommitSha(): Promise<string>;

  /**
   * Parse git log to find the highest completed Pass number.
   *
   * Looks for commit messages matching `chore(ai): completed Pass N -- ...`
   * (optionally suffixed with `- <feature-name>`) where N is a number 0-7.
   * Returns the highest N found, or null if none.
   */
  getLastCompletedPass(): Promise<number | null>;

  /** Execute `git reset --hard HEAD` and `git clean -fd` to wipe uncommitted files. */
  resetWorkingTree(): Promise<void>;

  /** Execute `git reset --hard <sha>` and `git clean -fd` to rewind to a specific commit. */
  abortToSha(sha: string): Promise<void>;

  /**
   * Create (or check out) a feature branch for the given issue reference.
   *
   * @param issueRef - Free-form issue reference (e.g. "PAY-404", "Add OAuth").
   * @param baseBranchOverride - Explicit base branch, or `null` to use the current branch.
   * @param skipHitl - If `true`, skip user prompt when the target branch already exists.
   * @param promptUser - Optional async callback for HITL prompts (defaults to rejecting).
   * @returns An {@link CreateFeatureBranchOutcome} describing what happened.
   */
  createFeatureBranch(
    issueRef: string,
    baseBranchOverride: string | null,
    skipHitl: boolean,
    promptUser?: (question: string) => Promise<boolean>,
  ): Promise<CreateFeatureBranchOutcome>;

  /** Create a lightweight git tag pointing at the current HEAD commit. */
  tag(name: string): Promise<void>;

  /**
   * Compute changed line ranges between two refs via `git diff --unified=0`.
   *
   * Returns per-file changed line ranges in the **new** file (1-based, inclusive).
   * Implementations should cache the result for the same (fromRef, toRef) pair
   * since multiple passes may request the same diff.
   */
  getDiffLineRanges(fromRef: string, toRef: string): Promise<DiffLineChange[]>;
}

// ---------------------------------------------------------------------------
// IFileSystem — file read/write that the engine needs (no raw fs calls)
// ---------------------------------------------------------------------------

export interface IFileSystem {
  /** Check whether a file (or directory) exists at *path*. */
  exists(path: string): Promise<boolean>;

  /** Read the full content of a UTF-8 file.  Throws if it does not exist. */
  readFile(path: string): Promise<string>;

  /** Overwrite *path* with *content* (creates file if missing). */
  writeFile(path: string, content: string): Promise<void>;

  /** Recursively create a directory and any missing parents. */
  mkdir(path: string): Promise<void>;

  /** Delete *path* if it exists. */
  deleteFile(path: string): Promise<void>;

  /** Rename *oldPath* to *newPath*. */
  renameFile(oldPath: string, newPath: string): Promise<void>;

  /** List entries in a directory (non-recursive). Throws if dir is missing. */
  readdir(path: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// ICommandRunner — process-spawning that the engine needs
// ---------------------------------------------------------------------------

export interface ICommandRunner {
  /**
   * Execute *testCmd* in the project root and return the result.
   *
   * Must capture (and not swallow) combined stdout+stderr so the
   * self-correction loop can write a meaningful error log.
   */
  runTests(testCmd: string[]): Promise<TestRunResult>;
}

// ---------------------------------------------------------------------------
// IAgentRunner — invokes an AI agent for a pipeline pass
// ---------------------------------------------------------------------------

export interface IAgentRunner {
  /**
   * Execute an agent run for the given pass.
   *
   * The caller (orchestrator) has already decided which artefacts to attach
   * and built the prompt. The runner is responsible for translating these
   * into tool-specific invocation arguments and spawning the agent process.
   *
   * @returns The agent's combined stdout+stderr output.
   * @throws {Error} If the agent exits with a non-zero status.
   */
  execute(request: AgentRunRequest): Promise<AgentRunResult>;
}

// ---------------------------------------------------------------------------
// IOpencodeSpawner — low-level opencode process spawning (with watchdog)
// ---------------------------------------------------------------------------

export interface IOpencodeSpawner {
  /**
   * Spawn the opencode CLI with the given pre-built argument array.
   *
   * Implementations own process lifecycle concerns: stdout/stderr streaming,
   * heartbeat watchdog, and hard timeout. The caller (OpenCodeAgentRunner)
   * is responsible for argv assembly — this contract is purely about
   * spawning and monitoring.
   *
   * @returns Combined stdout+stderr output.
   * @throws {Error} If opencode exits non-zero or hits the hard timeout.
   */
  spawn(args: string[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// IEventBus — pub/sub for decoupled UI
// ---------------------------------------------------------------------------

export interface IEventBus {
  /** Emit an event to all registered listeners for ``event.kind``. */
  emit(event: AgenticEvent): void;

  /**
   * Register a synchronous handler for a specific event kind.
   *
   * @returns An unsubscribe function that removes the listener.
   */
  on(kind: AgenticEventKind, handler: (event: AgenticEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// IStateStore — persistence for pipeline session state
// ---------------------------------------------------------------------------

export interface IStateStore {
  /** Absolute path to the state file managed by this store. */
  readonly path: string;

  save(ctx: PipelineContext): Promise<void>;
  load(): Promise<PipelineContext>;
  delete(): Promise<void>;
  exists(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// ILogger — structured logging (no dependency on pino or process.stdout)
// ---------------------------------------------------------------------------

export interface ILogger {
  debug(msgOrObj: string | object, msg?: string): void;
  info(msgOrObj: string | object, msg?: string): void;
  warn(msgOrObj: string | object, msg?: string): void;
  error(msgOrObj: string | object, msg?: string): void;
  child(bindings: Record<string, unknown>): ILogger;
  /** Read-only intent: gates CLI flags like --print-logs/--log-level. */
  level: string;
}

// ---------------------------------------------------------------------------
// PipelineConfig — configuration values injected at construction time
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  readonly opencodeLogPath: string;
  readonly apiKeySet: 'present' | 'missing';
}

// ---------------------------------------------------------------------------
// ISymbolResolver — maps git-diff line ranges to enclosing function/method names
// ---------------------------------------------------------------------------

export interface ISymbolResolver {
  /**
   * For each {@link Range} in *ranges*, find the enclosing function, method,
   * or class in *source* and return the qualified name (e.g. `Foo.methodA`).
   *
   * Parsing is done entirely in-memory — the implementation MUST NOT read the
   * filesystem. *filePath* is provided for language detection and for error
   * messages; it is not opened by the resolver.
   *
   * Ranges without an enclosing symbol are silently dropped.
   * Malformed source returns an empty array (never throws).
   *
   * @returns Deduplicated, sorted array of qualified names.
   */
  mapRangesToSymbols(filePath: string, source: string, ranges: Range[]): string[];
}

// ---------------------------------------------------------------------------
// IContextProvider — pure synchronous assembler over ctx.history (READER)
// ---------------------------------------------------------------------------

export interface IContextProvider {
  /**
   * Assemble per-pass context from the persisted {@link PipelineContext}.
   *
   * This method is **pure and synchronous** — it performs no git, no AST,
   * and no async calls.  It reads ``ctx.history`` (hydrated from the state
   * file on resume), merges the ``targetSymbols`` from upstream passes
   * according to {@link CONTEXT_RULES}, and returns a {@link BuiltContext}.
   *
   * Missing history entries are silently treated as empty — no exceptions.
   */
  build(ctx: PipelineContext, pass: PipelinePass): BuiltContext;
}

