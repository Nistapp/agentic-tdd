# Refactoring Plan: `src/core/orchestrator.ts`

Chronological, low-risk-first ordering. Each step is self-contained and verifiable via `npm test`.

---

## Step 1 — npm package hygiene

- [ ] 1.1 Add `"engines": { "node": ">=18.0.0" }` to `package.json`.
- [ ] 1.2 Change `prepublishOnly` to `"npm run lint && npm test && npm run build:full"`.
- [ ] 1.3 Change `const enum PipelinePass` to `enum PipelinePass` in `src/core/types.ts`.
- [ ] 1.4 Run `npm test` and `npm run lint` to verify no breakage.

---

## Step 2 — Delete dead code & minor smell fixes (keep all TODO/REMARK comments)

- [ ] 2.1 Remove empty `finally {}` block at orchestrator.ts lines 164–166.
- [ ] 2.2 Remove unused `altGherkinPath` parameter from `#ensureNonEmptyArtefacts` (orchestrator.ts:412–426).
- [ ] 2.3 Remove unused `genAiOutput` variable assignments in `#runPass1`, `#runPass2`, `#runPass7` (orchestrator.ts:178, 188, 277). Keep `#invokeOpenCode` call, just drop the left-hand side.
- [ ] 2.4 Replace 4× `as unknown as Record<string, unknown>` in `#runPass1`, `#runPass2`, `#runSelfCorrectingPass`, `#runPass7` with a proper `PassCompletedPayload` type in `src/core/types.ts`.
- [ ] 2.5 Run `npm test` to verify behavior unchanged.

---

## Step 3 — Fix `runId` assignment order (real bug)

- [ ] 3.1 In `PipelineOrchestrator.run()` (orchestrator.ts:60), move `ctx.runId = randomUUID()` **above** the first `this.#emit('PIPELINE_STARTED', ...)` call so `#buildExecContext` doesn't read a stale or undefined `runId`.
- [ ] 3.2 Run `npm test` — event payloads now carry the correct runId.

---

## Step 4 — Extract shared paths into `src/utils/paths.ts`

- [ ] 4.1 Create `src/utils/paths.ts` exporting lazy-resolved helpers:
  - `getStateFilePath(workDir?: string): string`
  - `getLogDir(workDir?: string): string`
  - `getPackageAgentsDir(): string`
  - `getOpencodeLogPath(): string`
- [ ] 4.2 Remove the module-level `STATE_FILE` constant from orchestrator.ts:16. Call `getStateFilePath()` inside methods instead.
- [ ] 4.3 Remove the duplicate `STATE_FILE` constant from `src/cli/index.ts:275`. Import from `paths.ts`.
- [ ] 4.4 Remove `PACKAGE_AGENTS_DIR` import from `../infrastructure/command-runner.js` in orchestrator.ts:14. Use `getPackageAgentsDir()` from `paths.ts`.
- [ ] 4.5 Move `#persistPassLog` (orchestrator.ts:396–410) to use `getLogDir()` from `paths.ts`.
- [ ] 4.6 Run `npm test`.

---

## Step 5 — Remove `process.env` reads from orchestrator (Config injection)

- [ ] 5.1 Define a `PipelineConfig` interface in `src/core/interfaces.ts`:
  ```ts
  export interface PipelineConfig {
    readonly opencodeLogPath: string;
    readonly apiKeySet: 'present' | 'missing';
  }
  ```
- [ ] 5.2 Add `PipelineConfig` as a constructor argument to `PipelineOrchestrator`.
- [ ] 5.3 In `#invokeOpenCode` (orchestrator.ts:364), replace `process.env.HOME` with `this.#config.opencodeLogPath`.
- [ ] 5.4 In `#logPreFlight` (orchestrator.ts:389), replace `process.env.OPENROUTER_API_KEY` check with `this.#config.apiKeySet`.
- [ ] 5.5 Update `src/cli/index.ts` to build `PipelineConfig` at construction time.
- [ ] 5.6 Update test `makeMocks()` to supply a stub `PipelineConfig`.
- [ ] 5.7 Run `npm test`.

---

## Step 6 — Deduplicate per-pass methods (keep `run()` inline)

- [ ] 6.1 Add one characterization test in `test/orchestrator.test.ts`: snapshot of `emittedEvents.map(e => e.kind)` for the full 8-pass happy path.
- [ ] 6.2 Extract a private `#runSimplePass(ctx: PipelineContext): Promise<void>` method (the body shared by passes 1, 2, 7: emit-started, log, getAgentContextPayload, log, invokeOpenCode, getPendingChanges, emit-completed).
- [ ] 6.3 Replace `#runPass1`, `#runPass2`, `#runPass7` bodies with a call to `#runSimplePass(ctx)`.
- [ ] 6.4 Keep `#runPass0` (unique artefact creation + `#ensureNonEmptyArtefacts` validation) and `#runSelfCorrectingPass` (unique loop) as separate methods.
- [ ] 6.5 Run `npm test` — characterization test must match pre-refactor snapshot.

---

## Step 7 — Logger injection (full DI)

- [ ] 7.1 Add `ILogger` port to `src/core/interfaces.ts`:
  ```ts
  export interface ILogger {
    debug(msgOrObj: string | object, msg?: string): void;
    info(msgOrObj: string | object, msg?: string): void;
    warn(msgOrObj: string | object, msg?: string): void;
    error(msgOrObj: string | object, msg?: string): void;
    child(bindings: Record<string, unknown>): ILogger;
    level: string;
  }
  ```
- [ ] 7.2 Replace all `reqLogger()`, `loggers.core`, `loggers.agent(...)` calls in orchestrator.ts with `this.#logger` (an `ILogger` instance injected via constructor).
- [ ] 7.3 Remove the `reqLogger`, `loggers`, `executionContextStorage` imports from orchestrator.ts. The class no longer depends on `src/utils/logger.ts`.
- [ ] 7.4 Update `src/cli/index.ts` to pass a concrete `ILogger` implementation (wrap pino from logger.ts).
- [ ] 7.5 Update test `makeMocks()` with a stub logger that captures calls.
- [ ] 7.6 Run `npm test`.

---

## Step 8 — Library surface (barrel + exports)

- [ ] 8.1 Create `src/core/index.ts` barrel exporting `PipelineOrchestrator`, all types from `./types.js`, and all interfaces from `./interfaces.js`.
- [ ] 8.2 Add to `package.json`:
  ```json
  "main": "./dist/core/index.js",
  "types": "./dist/core/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/core/index.d.ts",
      "import": "./dist/core/index.js"
    }
  }
  ```
- [ ] 8.3 Run `npm run build` and verify `dist/core/` structure.
- [ ] 8.4 Run `npm test`.

---

## Step 9 — Extract CLI argument builders into `OpenCodeAdapter` / `ICommandRunner`

- **Problem**: `#buildArgs` (orchestrator.ts:322–352) contains specific knowledge about how the `opencode` CLI accepts `--file`, `--dangerously-skip-permissions`, `--print-logs`, and `--log-level` flags. The orchestrator should not care about opencode's string syntax.
- **Goal**: The orchestrator says `this.#agentRunner.execute(pass, context)` instead of building argv arrays.

- [ ] 9.1 Add to `src/core/interfaces.ts`:
  ```ts
  export interface IAgentRunner {
    execute(ctx: PipelineContext, prompt: string, errorLog?: string): Promise<string>;
  }
  ```
- [ ] 9.2 Move the argv-building logic from `#buildArgs` + `#invokeOpenCode` into a new `OpenCodeAgentRunner` class in `src/infrastructure/open-code-agent-runner.ts`. This class:
  - Implements `IAgentRunner`.
  - Depends on `IFileSystem` (to check artefact existence) and maintains the internal `runOpenCode` concern.
  - Reads `OPENCODE_CONFIG_DIR`/`PACKAGE_AGENTS_DIR` from `paths.ts`.
- [ ] 9.3 Replace `ICommandRunner` with `IAgentRunner` in the `PipelineOrchestrator` constructor (keep `ICommandRunner` for `runTests` only, or bundle both).
- [ ] 9.4 Remove `#buildArgs`, `#invokeOpenCode`, `#logPreFlight`, and `#persistPassLog` from orchestrator.cs. The `IAgentRunner.execute()` call replaces all four.
- [ ] 9.5 Update `ICommandRunner` to only expose `runTests` (if it previously also had `runOpenCode`). Or keep `runOpenCode` as an infra detail of `OpenCodeAgentRunner`.
- [ ] 9.6 Update `src/cli/index.ts` to wire `OpenCodeAgentRunner` + `CommandRunner(test-only)`.
- [ ] 9.7 Update test mocks (`makeMocks`) to supply a stub `IAgentRunner`.
- [ ] 9.8 Run `npm test`.

**Benefit**: The orchestrator becomes CLI-agnostic. If opencode changes its flag syntax, or you swap to another agent tool, only `OpenCodeAgentRunner` changes.

---

## Step 10 — Extract the self-correction loop into a dedicated class

- **Problem**: `#runSelfCorrectingPass` (orchestrator.ts:193–270) is the most complex logic in the file — test loops, context compaction, error logging, retry bounds, and the double-agent-invocation issue. It belongs to the orchestrator only by membership, not by concern.
- **Goal**: Each pass can in turn become an independent agentic system. The orchestrator becomes a high-level coordinator that passes context to specialized runners.

- [ ] 10.1 Create `src/core/runners/self-correction-runner.ts` with a `SelfCorrectionRunner` class:
  - Constructor takes `IAgentRunner`, `ICommandRunner` (for `runTests`), `IFileSystem`, `IEventBus`, `ILogger`.
  - Exposes `async execute(ctx: PipelineContext): Promise<void>`.
  - Moves all loop, compaction, error-log-dance, and retry-bound logic from orchestrator.ts:193–270.
- [ ] 10.2 Fix the double-agent-invocation bug (D1): remove the pre-loop `#invokeOpenCode` call; do the agent-run as the first step of each attempt inside the loop.
- [ ] 10.3 Fix the AsyncLocalStorage mutation (D2): re-`run` a fresh execution context for each attempt instead of mutating the store.
- [ ] 10.4 Replace `#runSelfCorrectingPass` in orchestrator.cs with a call to `this.#selfCorrectionRunner.execute(ctx)`.
- [ ] 10.5 Update `src/cli/index.ts` to construct and inject `SelfCorrectionRunner`.
- [ ] 10.6 Update test mocks — the orchestrator test should stub `SelfCorrectionRunner.execute(ctx)` and verify it's called for passes 3–6. Add a dedicated `test/runners/self-correction-runner.test.ts` for the loop's own behavior.
- [ ] 10.7 Run `npm test`.

**Benefit**: Prepares for the roadmap item where each pass becomes an independent agentic system. The orchestrator becomes a true high-level coordinator.

---

## Verification Command (after each step)

```bash
npm run lint && npm test
```
