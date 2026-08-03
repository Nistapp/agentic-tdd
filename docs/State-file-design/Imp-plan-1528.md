# Context Passing and StateFile Implementation Plan

## Goal Description
Currently, the orchestrator does not track which source files are created or modified across passes. Because an atomic `git commit` is made after each pass, the working directory is clean when the next pass starts. This leaves subsequent agents blind to previous work, forcing them to guess or inefficiently search the codebase.

This plan details how to correctly track feature-specific files and pass them as explicit context to each agent, ignoring the legacy "Static Prefix" constraint to maximize accuracy since different LLMs may be used per pass.

## Current Context (What is being passed today)
For **all passes**, the orchestrator currently passes the exact same context:
1. **JSON Payload (`prompt`):** `featureName`, `featureDescription`, `pipelineVersion`, `attemptNumber`, and file paths for artifacts.
2. **File Attachments (`--file`):** `design.mmd`, `spec.gherkin`, the user's initial `specFile`, and `errorLog` (on retries).

**What is MISSING:** The source code files themselves! The markdown prompts (e.g., `pass-1-contracts-agent.md`) state `<user_code><!-- orchestrator injects paths/content here --></user_code>`, but the orchestrator never actually injects this. 

## The Right Context (Starting from Pass 2)
To give each agent exactly what it needs, we must track files by their semantic role (`contracts`, `tests`, `implementation`) and provide them dynamically:

### Pass 2 (Test Generation)
- **Context:** `design.mmd`, `spec.gherkin` + **Pass 1 Contract Files**
- **Reason:** The agent must write tests against the concrete interfaces and stubs created in Pass 1. It cannot write accurate tests without the contracts.

### Pass 3 (Core Implementation)
- **Context:** `design.mmd`, `spec.gherkin` + **Pass 1 Contract Files** + **Pass 2 Test Files**
- **Reason:** The agent needs to fill in the contract stubs to make the tests pass. The error log is also attached if tests fail on self-correction.

### Pass 4 (Refactor), Pass 5 (Observability), Pass 6 (Security)
- **Context:** **Implementation Files** + **Pass 2 Test Files**
- **Reason:** These passes structurally modify the implementation. Passing the tests helps the agent understand behavioral constraints and edge cases to ensure logic remains intact.

### Pass 7 (Documentation)
- **Context:** **Implementation Files** + `design.mmd`
- **Reason:** The agent adds docstrings to the implementation and requires the design diagram to add the mandatory `@see` architectural trace links.

---

## Proposed Changes

### 1. Extend `PipelineContext`
Update `src/core/types.ts` to include a file tracker.
```typescript
export interface PipelineContext {
  // ... existing fields ...
  featureFiles?: {
    contracts: string[];
    tests: string[];
    implementation: string[];
  };
}
```

### 2. Track Files & Implement `IStateStore` in Orchestrator
Update `src/core/orchestrator.ts`:
- Inject `IStateStore` into `PipelineOrchestrator` as outlined in `docs/statefile-design.md`.
- In `run()`, initialize `ctx.featureFiles`.
- Before `#maybeCommit(ctx)`, capture `git.getPendingChanges()` and append the file paths to the appropriate array in `ctx.featureFiles` depending on the current pass.
- After `#maybeCommit(ctx)`, call `await this.#stateStore.save(ctx)` to persist progress.

### 3. Wire State Store in CLI
Update `src/cli/index.ts`:
- Pass `JsonStateStore` to the `PipelineOrchestrator` constructor.
- Refactor the `--resume` logic to read `currentPass` and `featureFiles` from `JsonStateStore.load()` instead of deriving it loosely from `git log`.

### 4. Dynamically Pass Context to Agents
Update `src/core/runners/shared.ts`:
- Modify `buildArtefacts` to return the arrays of tracked source files.
- Update `OpenCodeAgentRunner` to append these source files as `--file` arguments to `opencode`.
- Modify `getAgentContextPayload` to explicitly list the roles of the attached files (e.g., "Contract Files: [...]") so the agent understands the context it is receiving.

## Open Questions
- Should we attach the test files in Pass 7 (Documentation), or just the implementation files? (Proposed: Just implementation, as tests don't usually need JSDoc `@see` links).

## User Review Required
> [!IMPORTANT]
> Because we are injecting source files via `--file` directly into OpenCode, OpenCode will inject the file contents into the LLM context. Does the OpenCode CLI properly handle multiple `--file` arguments for source code injection, or should we format and append the code content directly into the JSON `prompt` payload in `getAgentContextPayload`?

## Verification Plan
### Automated Tests
- Run `npm test` to ensure DI wiring and `PipelineOrchestrator` unit tests pass.
- Add tests in `test/orchestrator.test.ts` to verify `ctx.featureFiles` is populated correctly and `stateStore.save` is called per pass.
- Add tests in `test/infrastructure/state-store.test.ts` for atomic file saving.

### Manual Verification
- Run a dry pipeline on a dummy feature and verify `.opencode/active-run.json` contains the `featureFiles` tracking, and verify the agent prompt logs show the correct files being injected.
