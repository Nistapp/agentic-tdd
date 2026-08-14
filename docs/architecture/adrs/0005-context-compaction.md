# 0005. Context Compaction — Delete Error Logs on Pass Success

* **Status:** Accepted
* **Date:** 2026-07-01 (estimated)
* **Deciders:** <!-- @github-handle -->

---

## Context

Guarded passes (3–7) run a **self-correction loop** ([ADR-0002](./0002-xstate-machines.md)): dispatch agent → run tests → on failure, write the failing test output to an **error log** → retry (up to `maxCorrectionRetries` retries) → on success, advance to the next pass.

The error log is the feedback channel for the *next attempt of the same pass* — it is re-attached to the agent's context on retries via `buildArtefacts(ctx, fs, built, ctx.errorLogPath)` ([`src/core/machines/self-correction.machine.ts#L364`](../../../src/core/machines/self-correction.machine.ts#L364)). But the log lives at a **fixed, per-feature path** — `getErrorLogPath(featureName)` → `<stateDir>/error-<feature>.log` ([`src/utils/paths.ts#L28-L31`](../../../src/utils/paths.ts#L28-L31)) — that is referenced unconditionally by every subsequent context build ([`getAgentContextPayload` paths.errorLog](../../../src/core/runners/shared.ts#L21) and [`buildArtefacts`](../../../src/core/runners/shared.ts#L31-L68)).

If a resolved error log is left on disk after a pass succeeds, it leaks into **every later pass's context window**:

* **Token waste** — the stale log is re-serialised into each downstream agent prompt, burning tokens on failure output that is no longer relevant.
* **Stale noise / accuracy drift** — Pass 4's agent sees Pass 3's resolved failures and may "fix" phantom problems or hedge its behaviour around them, degrading the determinism the pipeline exists to provide.

The two "context control" levers were **Static Prefix** (cache-hit file ordering) and **Context Compaction**. Static Prefix has since been deprecated pending research ([ADR-0006](./0006-context-control-optimisation.md), [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53)); **Context Compaction is the surviving, shipped token/accuracy lever**.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **Keep error logs forever** | Rejected — every later pass re-pays the token cost and inherits stale failure noise. |
| **Attach the log only on explicit retries** | Rejected as insufficient — the fixed path in `ctx.errorLogPath` resurrects the file for every context build; the file must be *removed*, not just skipped. |
| **Delete the log on pass success** (Context Compaction) | **Chosen** — removes the stale data at its source, so later passes start with a clean slate. |

---

## Decision

**On successful completion of a guarded pass, the pass error log is deleted.** Implemented in the `cleanupAfterSuccess` actor ([`src/core/machines/self-correction.machine.ts#L426-L437`](../../../src/core/machines/self-correction.machine.ts#L426-L437)), invoked from the `success` state of the Self-Correction Machine ([`self-correction.machine.ts#L654-L683`](../../../src/core/machines/self-correction.machine.ts#L654-L683)):

```ts
if (await fs.exists(errorLogPath)) {
  await fs.deleteFile(errorLogPath);
}
```

**Full error-log lifecycle:**

| Stage | Where | Behaviour |
|---|---|---|
| 1. Written on retry | `writing_error_log` state → `writeErrorLog` actor ([`self-correction.machine.ts#L420-L424`](../../../src/core/machines/self-correction.machine.ts#L420-L424), [`#L622-L638`](../../../src/core/machines/self-correction.machine.ts#L622-L638)) | Persists `_testResult.output` (the failing test output) to `ctx.errorLogPath`. |
| 2. Re-attached on the next attempt | `dispatchAgent` for attempts ≥ 2 ([`#L364`](../../../src/core/machines/self-correction.machine.ts#L364)) | `buildArtefacts(ctx, fs, built, ctx.errorLogPath)` feeds the log back to the same agent as `artefacts.errorLog`. |
| 3. **Deleted on success** | `cleanupAfterSuccess` (**Context Compaction**) | `fs.deleteFile(errorLogPath)` — later passes start clean. |
| 4. Deleted on run start | `PipelineOrchestrator.run()` ([`src/core/orchestrator.ts#L80-L86`](../../../src/core/orchestrator.ts#L80-L86)) | Any stale log left by a previously interrupted run is cleared before a new/resumed run. |

**Supporting facts:**

* The log path is derived per feature (`getErrorLogPath`, [`paths.ts#L28-L31`](../../../src/utils/paths.ts#L28-L31)), set in the session context ([`src/cli/session.ts#L36`](../../../src/cli/session.ts#L36)), and carried on `PipelineContext.errorLogPath` ([`src/core/types.ts#L170`](../../../src/core/types.ts#L170)).
* Logs are transient and git-ignored ([`.gitignore#L12`](../../../.gitignore#L12)) — they are *not* part of the repo; compaction is their only persistence.
* The retry signal is surfaced to the user: `SELF_CORRECTION_ATTEMPTED` events are rendered as `[compaction]` messages by `TerminalRenderer.logCompaction` ([`src/cli/terminal-event-listener.ts#L57-L58`](../../../src/cli/terminal-event-listener.ts#L57-L58), [`src/cli/terminal-renderer.ts#L183-L185`](../../../src/cli/terminal-renderer.ts#L183-L185)).

---

## Consequences

### Positive

* **No stale-failure pollution** — later passes never inherit resolved failure output; each pass starts from the committed state plus its own target symbols.
* **Token savings** — the resolved error log is not re-serialised into any subsequent agent prompt (this is the pipeline's primary shipped token/context lever since [ADR-0006](./0006-context-control-optimisation.md) was deprecated).
* **Log present exactly while relevant** — the file exists precisely during the retry loop that needs it, then disappears on success.
* **Crash-safe cleanliness** — the `run()`-start deletion ([`orchestrator.ts#L80-L86`](../../../src/core/orchestrator.ts#L80-L86)) guarantees an interrupted run never leaks a stale log into the next run.

### Negative / Trade-offs

* **Post-mortem debugging is harder** — once a pass succeeds, its transient failures are gone from disk; reconstructing them requires the pino run logs (see [6. Observability & Operations § 2.2](../contributor-deep-dive/06-observability-operations.md#22-error-log--context-compaction)).
* **Compaction failure is fatal to a successful pass** — `cleanupAfterSuccess` runs inside the machine's `success` state; if `deleteFile` throws, the transition's `onError` routes to `failed` (`emitAgentError`). A pass whose tests passed can still be marked failed if disk cleanup fails.
* **Failure-path logs do not survive a resume** — the unconditional deletion at `run()` start also removes a failed pass's error log when a run is resumed, so the diagnostic detail can be lost across a resume.
* **Best-effort visibility** — because logs are git-ignored and deleted, the only durable record of a transient failure is the structured pino log, not the error file.

---

## Placeholders / Open Items

| # | Topic | What is missing |
|---|---|---|
| C-1 | Token-savings quantification | No measured data on how many tokens Context Compaction saves; the "token waste" rationale is qualitative. |
| C-2 | Failure-path retention policy | The behaviour described under "Failure-path logs do not survive a resume" has not been formally decided — whether a failed pass's error log should be preserved until explicitly cleaned is an open design question. |
| C-3 | Compaction failure semantics | Whether `cleanupAfterSuccess` should be best-effort (log-and-continue) rather than fail-the-pass on `deleteFile` errors is undecided (current behaviour: fail the pass). |
| C-4 | Decision date & deciders | Date is estimated (2026-07-01); no decider GitHub handles are recorded. |
