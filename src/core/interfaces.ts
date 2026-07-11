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

import type { PipelineContext, AgenticEvent, AgenticEventKind, GitCommitResult, TestRunResult, FileChange } from './types.js';

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
   * where N is a number 0-7. Returns the highest N found, or null if none.
   */
  getLastCompletedPass(): Promise<number | null>;

  /** Execute `git reset --hard HEAD` and `git clean -fd` to wipe uncommitted files. */
  resetWorkingTree(): Promise<void>;

  /** Execute `git reset --hard <sha>` and `git clean -fd` to rewind to a specific commit. */
  abortToSha(sha: string): Promise<void>;
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

  /**
   * Execute the opencode agent invocation.
   *
   * The caller has already built the full argument array via
   * ``buildOpencodeCommand``.  This contract only cares about spawning.
   *
   * Must stream opencode's stdout/stderr to the terminal (``stdio: 'inherit'``)
   * so the developer can see progress in real time.
   *
   * @returns The combined stdout+stderr output for post-processing.
   * @throws {Error} If opencode exits with a non-zero status.
   */
  runOpenCode(args: string[]): Promise<string>;
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
// IStateStore — persistence for pipeline session state (DEFERRED)
// ---------------------------------------------------------------------------

export interface IStateStore {
  save(ctx: PipelineContext): Promise<void>;
  load(): Promise<PipelineContext>;
  delete(): Promise<void>;
  exists(): Promise<boolean>;
}