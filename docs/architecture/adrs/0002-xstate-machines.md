# 0002. XState Machines Over Ad-hoc Loops for Pipeline & Self-Correction

* **Status:** Accepted
* **Date:** 2026-08-01 (estimated)
* **Deciders:** <!-- @github-handle -->

---

## Context

The agentic-tdd pipeline is an **8-pass orchestration problem** ([`PipelinePass`](../../../src/core/types.ts#L15-L24)) with human-in-the-loop gates, test-gated retry loops, atomic per-pass commits, and pause/resume. The original prototype implemented this as an imperative Python script (`pipeline_v3_1.py`, part of the predecessor `ai-factory-setup` repo — the constants in [`src/core/types.ts`](../../../src/core/types.ts#L1-L9) are explicitly mirrored from that prototype's `cli.py`).

As the pipeline grew, the ad-hoc loop approach became hard to reason about:

- **Implicit control flow.** The order of passes, gates, and retries was buried in `for`/`while` loops and `if` branches scattered across the script. There was no single declarative view of "what states exist, and what may transition where."
- **No exhaustive transition list.** Nothing prevented the code from drifting into an unintended in-between condition (e.g. a commit that is "sort of" done, a pass that is neither running nor failed). Such states cannot exist in a declared state machine.
- **Side-effects entangled with control flow.** File writes, git calls, and process spawning were interleaved with the sequencing logic, so the orchestration logic could not be unit-tested without real I/O.
- **No first-class pause/resume or rewind.** The machine's current position is a single, serialisable value; an ad-hoc script has no such position to save and replay. The prototype had no clean mechanism for `--pause`/`--resume` or for rewinding a pass after a human rejects it.
- **Failure recovery was ad-hoc.** Retry-until-tests-pass, rewind-to-pass-start, and abort paths were special-cased rather than declared transitions.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **Keep the imperative prototype** (`pipeline_v3_1.py`) | Rejected — implicit state, un-testable without real I/O, and complexity grew with every new gate. |
| **Workflow-orchestration platform (e.g. Temporal, Durable Functions)** | Rejected — heavyweight runtime and infrastructure dependency, disproportionate for a single-process CLI that must stay `npx`-executable and embeddable. |
| **XState v5** (a zero-runtime state-machine library) | **Chosen** — pure in-process library, declarative state machines with guards/actors, no infrastructure dependency. |

XState was selected because it is the most widely used, well-tested state-machine library for TypeScript ([`package.json`](../../../package.json#L47): `xstate@^5.32.5`), and its actor-model features are expected to support future evolutions such as config-driven and parallel pipelines.

---

## Decision

Replace ad-hoc loop logic with **two pure XState v5 machines**, each a pure function with zero filesystem/git/process I/O. Every side-effect is injected via the DI interfaces in [`src/core/interfaces.ts`](../../../src/core/interfaces.ts), honouring the boundary of [ADR-0001](./0001-pure-core-engine.md).

1. **`createPipelineMachine`** ([`src/core/machines/pipeline.machine.ts#L679-L1710`](../../../src/core/machines/pipeline.machine.ts#L679-L1710)) — orchestrates the 8 passes. It owns:
   - initial pass routing from `startPass` (`__begin` state + `atPass0…atPass7` guards);
   - per-pass invocation (design/contracts/test-generation run directly; passes 3–7 delegate to Self-Correction Machine instances);
   - HITL gates for Pass 0 and Pass 2 (`awaiting_hitl_pass_0/2`, with `HITL_APPROVE` / `HITL_REWIND` / `HITL_REJECT` transitions and `rewindToPassStart`);
   - atomic commits (`committing` → `doAtomicCommit` — see [ADR-0003](./0003-atomic-commits-per-pass.md));
   - pause/resume (`paused` state, `RESUME` event) and terminal states (`pipeline_complete`, `pipeline_failed`).

2. **`createSelfCorrectionMachine`** ([`src/core/machines/self-correction.machine.ts#L319-L705`](../../../src/core/machines/self-correction.machine.ts#L319-L705)) — the per-pass retry loop used for **guarded passes** 3–7 ([`SELF_CORRECTION_PASSES`](../../../src/core/types.ts#L53-L59)). It owns the loop:
   - `dispatching_agent` → `evaluating_skip` → `running_tests` → `evaluating` → (`success` | `writing_error_log` → retry | `failed`);
   - test-gated acceptance: `testsPassed`, `canRetry` (`attempt < maxCorrectionRetries + 1`; default 3 retries → 4 total attempts, [`DEFAULT_MAX_CORRECTION_RETRIES`](../../../src/core/types.ts#L74));
   - skip-signal handling (`SKIP:N:reason`, via [`parseSkipSignal`](../../../src/core/skip-parser.ts));
   - error-log write on retry and error-log deletion on success (**Context Compaction**, [ADR-0005](./0005-context-compaction.md)).

Both machines are constructed via `setup({...}).createMachine({...})` with `fromPromise` actors, and are hosted by the thin `PipelineOrchestrator` coordinator ([`src/core/orchestrator.ts#L22-L189`](../../../src/core/orchestrator.ts#L22-L189)), which wires the DI services, bridges HITL decisions, and persists/restores the `xstateSnapshot` for `--resume`.

Each file also carries a module-level visualisation config (`pipelineMachineConfig` / `selfCorrectionMachineConfig`) with stubbed actors so the machine remains Stately-visualisable; the real factories `.provide()` the live actors.

---

## Consequences

### Positive

* **Exhaustive, inspectable control flow** — all states, transitions, and guards are declared and visible in one place ([state diagrams](../contributor-deep-dive/01-core-engine-internals.md#11-state-map)); there is no hidden branch that can corrupt the repo.
* **Deterministic execution** — the same event in the same state always produces the same transition; no order-dependent or implicit behaviour.
* **Testable without side-effects** — because the machines are pure functions, unit tests drive them purely in memory via stubbed DI (see `test/machines/pipeline.machine.test.ts` and `test/machines/self-correction.machine.test.ts`).
* **First-class HITL, pause/resume, and rewind** — human gates, `--pause`/`--resume`, and pass rewinding are declared states/transitions rather than special-cased control flow; the serialisable snapshot makes resume exact.
* **Reusable machine instances** — one Self-Correction Machine definition instantiated five times (`selfCorrectionPass3…7`) with child loggers, keeping the retry-loop logic DRY.

### Negative / Trade-offs

* **XState v5 learning curve** — the actor model, `fromPromise` actors, and `.provide()` wiring add indirection compared to a plain loop; newcomers must learn XState idioms before contributing ([opencode-style agents are directed to the Deep Dive](../contributor-deep-dive/01-core-engine-internals.md)).
* **Two machine definitions to keep in sync** — the visualisation config (stubbed actors) and the real factory must stay aligned manually.
* **Declarative verbosity** — a fully-specified machine with invoke/`onDone`/`onError` blocks is more verbose than the imperative loop it replaces (`createPipelineMachine` measures 28 cyclomatic / 63 cognitive complexity).
* **Actor indirection for debugging** — tracing a single run requires following `invoke` actor boundaries; stack traces are less linear than in a synchronous script.

---

## Placeholders / Open Items

| # | Topic | What is missing |
|---|---|---|
| X-1 | Original prototype (`pipeline_v3_1.py`) | The prototype source is **not in this repository** (it lived in the predecessor `ai-factory-setup` repo). Its failure modes are described from the ADR skeleton guidance and code comments in [`src/core/types.ts#L1-L9`](../../../src/core/types.ts#L1-L9), not from first-hand inspection. Link to the archived repo if available. |
| X-2 | Decision date & deciders | Date is estimated (2026-08-01); no decider GitHub handles are recorded. |
| X-3 | Library choice rationale | The claim that XState is "most widely used / best tested" is a team assertion; a quantitative comparison vs. alternative libraries is not recorded. |
