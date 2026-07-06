// ── Contracts (pass-1-contracts-agent) ─────────────────────────────────────
//
// Entities and types derived from the Mermaid design artefact and Gherkin spec:
//   - buildOpencodeCommand(agentName, prompt, targetFile, artefactDir, errorLog?) => string[]
//   - runOpencode(cmdArgs) => void  (throws Error on non-zero exit)
//   - Static-prefix ordering: <stem>.mmd → <stem>.gherkin → targetFile → errorLog → --dangerously-skip-permissions → prompt
//
// Scenario references (opencode.gherkin):
//   Line 12 - Happy path: all artefact files + errorLog present
//   Line 37 - Edge: no artefact files, no errorLog
//   Line 50 - Edge: only Gherkin spec exists
//   Line 68 - Error: runOpencode throws when command fails
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "child_process";

/**
 * Constant for the opencode CLI binary name.
 * @see {stem}.mmd — artefact diagram (filename derived from target file stem at runtime)
 */
export const OPENCODE_CMD: string = "opencode";

/**
 * File extensions for pipeline artefacts.
 * Artefact filenames are dynamic: `<stem>.mmd` and `<stem>.gherkin` where
 * `<stem>` is derived from the target source file name (e.g. `my_module.mmd`).
 * These constants represent ONLY the extensions; do NOT hard-code full filenames.
 *
 * @deprecated Use the fully-resolved paths from `PipelineContext.designMmdPath`
 *   and `PipelineContext.specGherkinPath` instead of constructing paths from these.
 */
export const ARTEFACT_DESIGN_EXT: string = ".mmd";
export const ARTEFACT_GHERKIN_EXT: string = ".gherkin";

/** @deprecated Use ARTEFACT_DESIGN_EXT. Kept for backward compatibility. */
export const ARTEFACT_DESIGN: string = "design.mmd";
/** @deprecated Use ARTEFACT_GHERKIN_EXT. Kept for backward compatibility. */
export const ARTEFACT_GHERKIN: string = "spec.gherkin";

/**
 * Flags used in argument construction.
 */
export const FLAG_FILE: string = "--file";
export const FLAG_DANGEROUSLY_SKIP_PERMISSIONS: string =
  "--dangerously-skip-permissions";
export const OPENCODE_SUBCOMMAND_RUN: string = "run";

/**
 * Input parameters for {@link buildOpencodeCommand}.
 *
 * @property agentName  - Identifier for the pipeline agent (e.g. "pass-3-implement-agent").
 *                        Used for logging/tracing only; not injected into the argument array.
 * @property prompt     - The instruction text passed via `--dangerously-skip-permissions`.
 * @property targetFile - Path to the source file the agent should work on.
 * @property artefactDir - Directory containing the dynamically-named Mermaid diagram
 *                        (`<stem>.mmd`) and Gherkin spec (`<stem>.gherkin`) artefacts.
 * @property errorLog   - Optional path to an error-log artefact; included only when the file exists.
 */
export interface BuildOpencodeCommandParams {
  readonly agentName: string;
  readonly prompt: string;
  readonly targetFile: string;
  readonly artefactDir: string;
  readonly errorLog?: string;
}

/**
 * Result of {@link buildOpencodeCommand}: an ordered array of CLI arguments
 * ready to pass to `child_process.spawnSync` or similar.
 */
export type OpencodeArgs = string[];

/**
 * Possible exit outcomes for {@link runOpencode}.
 *
 * - `success`: the child process exited with status 0; no return value needed.
 * - `failure`: the child process exited with a non-zero status; an Error is thrown.
 */
export type RunOpencodeResult = void;

// ── End of Contracts section ─────────────────────────────────────────────────

/**
 * Opencode Runner Module
 *
 * Responsible for constructing and executing commands for the `opencode` CLI.
 * Artefact file names are **dynamic** — they are derived from the target source
 * file's stem at pipeline initialisation time (e.g. `my_module.mmd`,
 * `my_module.gherkin`).  The orchestrator resolves the full paths and passes
 * them directly; this module does NOT construct paths from static names.
 *
 * Constants:
 * - `OPENCODE_CMD = "opencode"`
 * - `ARTEFACT_DESIGN_EXT = ".mmd"` (extension only; full path is dynamic)
 * - `ARTEFACT_GHERKIN_EXT = ".gherkin"` (extension only; full path is dynamic)
 *
 * Functions to implement:
 * 1. `buildOpencodeCommand(agentName, prompt, targetFile, artefactDir, errorLog?): string[]`
 *    - Constructs an array of arguments for `opencode run`.
 *    - Enforces the "Static Prefix" rule: the Mermaid artefact (`<stem>.mmd`)
 *      MUST come first if it exists, then the Gherkin artefact (`<stem>.gherkin`)
 *      if it exists, then `targetFile`.
 *    - If `errorLog` is provided and exists, add it as a `--file`.
 *    - Finally, append `--dangerously-skip-permissions` and the `prompt`.
 *    - Returns the argument array.
 *
 * 2. `runOpencode(cmdArgs: string[]): void`
 *    - Executes the opencode command using `child_process.spawnSync` or `execFileSync`.
 *    - Must run in the current working directory (`process.cwd()`).
 *    - Should stream stdout and stderr to the terminal (e.g., `stdio: 'inherit'`).
 *    - Throws an error if the command exits with a non-zero status.
 */

/**
 * Construct an ordered array of CLI arguments for `opencode run`.
 *
 * The returned array enforces the static-prefix contract:
 *   [`opencode`, `run`, `--file`, mmdPath?, `--file`, gherkinPath?, `--file`, targetFile, `--file`, errorLog?, `--dangerously-skip-permissions`, prompt]
 *
 * Artefact paths are fully-resolved by the orchestrator before being passed
 * to this function — they follow the pattern `<artefactDir>/<stem>.mmd` and
 * `<artefactDir>/<stem>.gherkin` where `<stem>` is derived from the target
 * source file name.
 *
 * @param agentName   - Pipeline agent identifier (used for logging only).
 * @param prompt      - Instruction text passed via `--dangerously-skip-permissions`.
 * @param targetFile  - Path to the source file the agent must edit.
 * @param artefactDir - Directory containing the dynamically-named Mermaid and Gherkin artefacts.
 * @param errorLog    - Optional path to an error-log artefact (included only when the file exists).
 *
 * @returns An ordered string[] of CLI arguments.
 *
 * @see opencode.gherkin lines 12, 37, 50
 * @see opencode.mmd lines 6, 10–27
 */
export function buildOpencodeCommand(
  agentName: string,
  prompt: string,
  targetFile: string,
  artefactDir: string,
  errorLog?: string,
): OpencodeArgs {
  throw new Error("not implemented");
}

/**
 * Execute the `opencode` CLI command with the given arguments.
 *
 * Uses `child_process.spawnSync` with `{ stdio: 'inherit', cwd: process.cwd() }`.
 * Throws an `Error` if the child process exits with a non-zero status.
 *
 * @param cmdArgs - The full argument array (binary + flags + positional args).
 *
 * @throws {Error} When the opencode command exits with a non-zero status.
 *
 * @see opencode.gherkin line 68
 * @see opencode.mmd lines 30–33
 */
export function runOpencode(cmdArgs: OpencodeArgs): RunOpencodeResult {
  throw new Error("not implemented");
}
