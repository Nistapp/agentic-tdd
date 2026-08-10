# Context Passing and StateFile Implementation Plan

> **⛔ SUPERSEDED (07 Aug 2026).** Superseded by
> [`artefacts/Context-Enrichment-Architecture-07Aug26.md`](../../artefacts/Context-Enrichment-Architecture-07Aug26.md)
> and the phased
> [`artefacts/Context-Enrichment-Imp-Plan-07Aug26.md`](../../artefacts/Context-Enrichment-Imp-Plan-07Aug26.md).
> Keep for historical context.

## Goal Description
Currently, the orchestrator does not track which source files are created or modified across passes. Because an atomic `git commit` is made after each pass, the working directory is clean when the next pass starts. This leaves subsequent agents blind to previous work, forcing them to guess or inefficiently search the codebase.

Furthermore, the current "resume" feature relies on brittle parsing of `git log` messages rather than deterministic state. 

This plan details how to implement a robust, state-driven context management system. By tracking progress, commit hashes, errors, and file modifications in an **append-only history** within the state file, we preserve *any and all information* per pass. This provides a rich debugging trail for human developers and allows us to dynamically build the exact context each agent needs.

---

## Review and Critique of the Alternative Approach

A peer suggested a refined approach focused on logging associated details (diffs, annotations), tracking commit hashes, committing the state file to git, and appending the feature name to the state file.

### Critique & Synthesis
1. **Logging progress and details for better 'resume' context:** **AGREED.** The ability to resume effectively depends entirely on knowing exactly what happened prior. A state file is a hard dependency for this. We will preserve *any and all* information (attempts, errors, files) for both agent context and human debugging.
2. **Logging the commit hash to the state file:** **EXCELLENT ADDITION.** Since the pipeline makes atomic commits after every pass, storing the Git SHA in the state file provides a cryptographic, deterministic anchor. It allows a "Context Builder" to run `git diff <hash>^ <hash>` to show subsequent agents exactly what was changed in a prior pass, rather than just passing file paths.
3. **Context Building as a Separate Functionality:** **AGREED.** Instead of hardcoding which files get attached inside the orchestrator engine, we should decouple this into a `ContextBuilder`. This makes it trivial to tweak whether we send full files, diffs, or AI-generated annotations to the LLM in the future.
4. **Naming the file with `<feature-name>` and committing it:** **AGREED.** 
   - **Naming:** Changing from a singleton `.opencode/active-run.json` to `.opencode/state-<feature-name>.json` allows multiple features/branches to be developed concurrently without state collision.
   - **Committing:** Committing the state file alongside the code changes in the per-pass atomic commit (`chore(ai): completed Pass X`) ensures that the state travels with the branch. If a developer pushes a failing Pass 4 to GitHub, another developer can pull the branch, run `--resume`, and the orchestrator immediately knows the exact context. We will delete this file at the end of the pipeline.

---

## Proposed Architectural Changes

### 1. Extend `PipelineContext` & State Tracking
Update `src/core/types.ts` to include a rich history tracker, explicitly indexed by Pass number.

```typescript
export interface PassHistory {
  status: 'completed' | 'failed' | 'aborted';
  commitHash?: string;
  filesTouched: string[];
  attempts: number;
  lastError?: string;
  annotations?: string; // Room for future AI-generated summaries of the pass
}

export interface PipelineContext {
  // ... existing fields ...
  /** Full, append-only history indexed by Pass number (0-7) */
  history: Record<number, PassHistory>;
}
```

### 2. Feature-Specific State File & Git Lifecycle
Update `src/infrastructure/state-store.ts` and `src/utils/paths.ts`:
- Change the state file path resolution to use `featureName` (e.g., `.opencode/state-payment-retry.json`).
- Modify `PipelineOrchestrator.#maybeCommit`:
  - Before committing, capture `git.getPendingChanges()` to get `filesTouched`.
  - Update `ctx.history[ctx.currentPass]` with files and attempt counts.
  - Save `PipelineContext` to the state file.
  - Stage the state file (`git add .opencode/state-*.json`) so it is included in the atomic commit.
  - After the commit succeeds, retrieve the `HEAD` commit hash and update `ctx.history[currentPass].commitHash`, then save the state file again (this won't be committed until the *next* pass).
- In the error catch block, ensure we update `ctx.history` with `status: 'failed'` and `lastError` to preserve the debugging trail.

### 3. The `ContextBuilder` Abstraction
Extract context generation out of `shared.ts` into a dedicated `ContextBuilder`:
- **Pass 2 (Test Generation):** Reads the state file to find `filesTouched` in Pass 1. Attaches these Contract files + `design.mmd` + `spec.gherkin`.
- **Pass 3 (Core Implementation):** Reads history for Pass 1 (Contracts) and Pass 2 (Tests). Attaches them so the agent can fill in the stubs to make tests pass.
- **Pass 4-6 (Hardening):** Reads history for Pass 3 (Implementation) and Pass 2 (Tests). 

### 4. Wire State Store in CLI for Resume
Update `src/cli/index.ts`:
- Remove the brittle `getLastCompletedPass()` git-log parser.
- `--resume` now simply loads `.opencode/state-<feature-name>.json` to instantly restore `PipelineContext`, including all historical file paths, attempt counts, and commit hashes.

## User Review Required
> [!IMPORTANT]
> **Commit Hash Chicken-and-Egg Problem:**
> If we want to store the commit hash of Pass X inside the state file, we have a paradox: we can't know the commit hash until *after* we create the commit, but if we create the commit first, the state file inside that commit won't contain its own hash. 
> 
> **Resolution Accepted:** The state file committed during Pass X will contain the history up to Pass X-1, plus the `filesTouched` for Pass X. The `commitHash` for Pass X will be added to the state file *immediately after* the commit, meaning it gets tracked in the Git working directory and will be formally committed in the *next* pass (Pass X+1). The TypeScript interface will have an explicit documentation block explaining this timing.

## Verification Plan
### Automated Tests
- Add tests in `test/orchestrator.test.ts` to verify `ctx.history` is populated correctly with `filesTouched` before commits, and errors are captured.
- Add tests in `test/infrastructure/state-store.test.ts` to verify feature-specific file naming and JSON serialization.

### Manual Verification
- Run a dry pipeline up to Pass 3, then abort. 
- Verify the `.opencode/state-*.json` file exists in the Git tree and contains the correct history and `filesTouched`.
- Run with `--resume` and verify the agent receives the correct files from the history as context.
