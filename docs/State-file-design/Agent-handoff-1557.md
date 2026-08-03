# Agent Handoff Spec: State-Driven Context Management

## 1. Context and Rationale
The `agentic-tdd` repository orchestrates an 8-pass AI software development pipeline. Currently, the orchestrator issues an atomic `git commit` after every pass. Consequently, the working directory is clean when the next pass begins. This leaves subsequent agents "blind" to the files created or modified by prior passes, forcing them to guess or inefficiently search the codebase. 

Additionally, the current `--resume` feature relies on parsing `git log` messages to determine the last completed pass, which is brittle and lacks contextual state.

**The Goal:** Implement a robust `StateStore` that preserves **any and all information** (progress, file modifications, errors, and attempt counts) per pass until the successful completion of the pipeline. Maintaining this full, append-only history with clearly marked Pass numbers is critical not just for dynamic context injection, but as an invaluable debugging trail for human developers tracking AI hallucinations.

---

## 2. Core Data Structures (`src/core/types.ts`)

Extend the `PipelineContext` to maintain a comprehensive history of passes. The structure uses a dictionary indexed by the Pass number to explicitly mark the timeline.

```typescript
export interface PassHistory {
  status: 'completed' | 'failed' | 'aborted';
  /**
   * Due to the atomic commit lifecycle, the commit hash for Pass X is only known 
   * AFTER the commit is made. To preserve full history, write this hash to the 
   * state file immediately post-commit. It will be tracked in the working directory 
   * and formally committed in the subsequent Pass X+1. 
   */
  commitHash?: string;
  /** List of file paths created/modified during this pass */
  filesTouched: string[];
  /** Attempt count (valuable for self-correction debugging) */
  attempts: number;
  /** Any error messages if the pass aborted or failed */
  lastError?: string;
  /** Optional field for future AI-generated summaries of the pass */
  annotations?: string; 
}

export interface PipelineContext {
  // ... existing fields ...
  /** Full, append-only history indexed by Pass number (0-7) */
  history: Record<number, PassHistory>;
}
```

---

## 3. StateStore Implementation (`src/infrastructure/state-store.ts`)

The interface `IStateStore` is already defined in `src/core/interfaces.ts`. Implement the `JsonStateStore` adapter:

1.  **Dynamic Naming:** The state file should be named `.opencode/state-<featureName>.json` (ensure `featureName` is sanitized for valid filenames).
2.  **Atomicity:** When saving, write to a `.tmp` file first and use `fs.rename` to ensure atomicity and prevent corruption.
3.  **Interface Methods:** Ensure `save(ctx: PipelineContext)`, `load(featureName: string): Promise<PipelineContext>`, `exists(featureName: string)`, and `delete(featureName: string)` are fully implemented.

---

## 4. Orchestrator Integration (`src/core/orchestrator.ts`)

Update `PipelineOrchestrator` to inject and utilize the `IStateStore`:

1.  **Constructor:** Add `stateStore: IStateStore` to the constructor dependencies.
2.  **State Initialization:** In `run()`, ensure `ctx.history` is initialized.
3.  **The `#maybeCommit(ctx)` Lifecycle:** This method handles the atomic commit and must be updated to manage state securely.
    *   **Pre-commit:**
        *   Call `await this.#git.getPendingChanges()` to extract the list of modified/added files.
        *   Update `ctx.history[ctx.currentPass]` with `status: 'completed'`, `attempts: ctx.currentAttempt`, and `filesTouched`.
        *   Save the context: `await this.#stateStore.save(ctx)`.
        *   Stage the state file so it is included in the commit: `git add .opencode/state-*.json`.
    *   **Commit:** Execute the standard atomic `git commit`.
    *   **Post-commit (The Hash Resolution):**
        *   Retrieve the `HEAD` commit hash using the `IGitService`.
        *   Update `ctx.history[ctx.currentPass].commitHash = headHash`.
        *   Save the context again: `await this.#stateStore.save(ctx)`. (This updated file remains unstaged in the working directory until Pass X+1).
4.  **Error Handling:** In the catch block of `run()`, update `ctx.history[ctx.currentPass]` with `status: 'failed'` and `lastError: err.message`, then `save(ctx)`. This preserves vital human-readable debugging data.

---

## 5. The ContextBuilder Abstraction

Currently, context is built loosely inside `src/core/runners/shared.ts` via `buildArtefacts` and `getAgentContextPayload`. Extract this into a dedicated `ContextBuilder` class or functional module.

The `ContextBuilder` must analyze `ctx.history` to determine which source files to attach via `--file` arguments based on the *current* pass:

*   **Pass 2 (Test Generation):** Needs the `filesTouched` from Pass 1 (Contracts).
*   **Pass 3 (Core Implementation):** Needs `filesTouched` from Pass 1 (Contracts) and Pass 2 (Tests).
*   **Pass 4 (Refactor), Pass 5 (Security), Pass 6 (Observability):** Needs `filesTouched` from Pass 3 (Implementation) and Pass 2 (Tests).
*   **Pass 7 (Documentation):** Needs `filesTouched` from Pass 3-6 (Implementation files).

**Agent Payload Updates:**
When constructing the prompt payload (the JSON sent to the agent), explicitly categorize the attached files so the LLM understands their roles. For example:
```json
{
  "contextFiles": {
    "contracts": ["src/models/user.ts"],
    "tests": ["test/user.test.ts"]
  }
}
```

---

## 6. CLI Wiring and Resume Logic (`src/cli/index.ts`)

1.  **DI Wiring:** Instantiate `JsonStateStore` and pass it to the `PipelineOrchestrator` constructor in `di-container.ts` or `index.ts`.
2.  **Resume Feature:** Refactor the `--resume` command flag logic.
    *   *Current behavior:* Derives the last completed pass by parsing `git log` messages.
    *   *New behavior:* Use `stateStore.load(featureName)` to load the `PipelineContext` directly. The `ctx.currentPass` and `ctx.history` provide absolute deterministic state to resume execution immediately, complete with rich debugging history.
3.  **Cleanup:** Upon successful completion of Pass 7 (or at pipeline termination), call `stateStore.delete(featureName)` and execute a final `git rm .opencode/state-*.json && git commit` to clean up the repository.

---

## 7. Execution Directives for the Implementing Agent

1.  **Testing:** Do not break existing Vitest tests. Update `orchestrator.test.ts` to mock the new `IStateStore` dependencies and verify `save()` calls. Write tests for the atomic `JsonStateStore`.
2.  **No Logic Changes in Agents:** Do NOT modify the markdown files in `src/agents/`. This task is strictly focused on the TypeScript orchestrator core, CLI, and infrastructure layers.
3.  **Strict Typing:** Ensure all changes adhere strictly to the project's TypeScript configuration (`strict: true`, no `any`, proper error handling).
