# 0004. Human-in-the-Loop Gate After Pass 0 Only

* **Status:** Accepted
* **Date:** 2026-06-01 (estimated)
* **Deciders:** @kcramakrishna

> [!WARNING] Title vs. shipped behaviour
> The title records the original decision (a single gate after Pass 0). The **shipped code implements two gates** — after Pass 0 (Design) and after Pass 2 (Test Generation). This ADR documents the shipped behaviour as authoritative; the title should be amended (see [Placeholders — H-2](#placeholders--open-items)).

---

## Context

The most expensive failure mode of agentic generation is the AI **hallucinating the wrong architecture**. If the design diagram and behaviour specification are wrong, every downstream pass — contracts, tests, implementation, refactor — is built on a false foundation. Catching that at the start is cheap; catching it after seven agent passes have committed code is very expensive.

Two artefacts encode the decisions that everything else depends on:

- **Pass 0 (Design)** writes `design.mmd` (Mermaid) and `spec.gherkin` (Gherkin). These bind what the rest of the pipeline may build. Getting them wrong poisons the whole run.
- **Pass 2 (Test Generation, Red Phase)** writes the test suite. The tests encode the *acceptance criteria*; a human reviewing them before the Green Phase catches vacuous, tautological, or wrong-direction tests — i.e. suites that pass while testing nothing.

A human check at exactly these two points is the **cheapest, highest-leverage safety intervention**: approve what will be built (design) and approve how success will be measured (tests), then let the machine run autonomously through everything in between.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **No gates** (fully autonomous run) | Rejected — unsafe for a tool whose value proposition is human oversight; a hallucinated design would be committed and built upon. |
| **Gate after every pass** | Rejected — destroys the autonomy/token-cost benefit; passes 1, 3–7 are already test-gated or low-risk. |
| **Single gate after Pass 0 only** (original decision) | Chosen initially; **extended to Pass 2** once test-generation quality warranted a second human check. |
| **Two gates: after Pass 0 and after Pass 2** | **Current shipped decision** — documents the implementation and the `--skip-hitl` escape hatch for CI. |

---

## Decision

The pipeline fires a **HITL (Human-in-the-Loop) gate** at two checkpoints — after Pass 0 (Design) and after Pass 2 (Test Generation) — declared by [`HITL_GATE_PASSES`](../../../src/core/types.ts#L77-L80). The rest of the passes run without a human gate (they are test-gated by the self-correction loop, [ADR-0002](./0002-xstate-machines.md)).

**Machine mechanics** ([`src/core/machines/pipeline.machine.ts`](../../../src/core/machines/pipeline.machine.ts#L1258-L1318)):

1. On pass completion, the `onDone` transition is guarded: if `skipHitl` is true it routes straight to `committing`; otherwise to `preparing_hitl_pass_N`.
2. `prepareHitl` ([`pipeline.machine.ts#L844`](../../../src/core/machines/pipeline.machine.ts#L844)) collects pending git changes, and `emitHitlRequired` ([`pipeline.machine.ts#L1097`](../../../src/core/machines/pipeline.machine.ts#L1097)) emits `HITL_REQUIRED` with a `{ files }` payload — the machine parks in `awaiting_hitl_pass_0` / `awaiting_hitl_pass_2`.
3. The human decision is bridged back into the machine by `PipelineOrchestrator` via `HITL_EVENT_MAP` ([`src/core/orchestrator.ts#L14-L19`](../../../src/core/orchestrator.ts#L14-L19)):

| Human action | Machine event | Result |
|---|---|---|
| Approve (Enter) | `HITL_APPROVE` | → `committing` (atomic commit, [ADR-0003](./0003-atomic-commits-per-pass.md)) |
| Rewind (`r`) | `HITL_REWIND` | → `rewinding_pass_N` → `rewindToPassStart` re-runs the pass from the previous commit |
| Reject (`x`) | `HITL_REJECT` | → `pipeline_failed` (abort) |

**DI-injectable handler.** The gate is a port, not a concrete UI: `HitlHandler` ([`src/core/orchestrator.ts#L14`](../../../src/core/orchestrator.ts#L14)) is injected into the orchestrator, defaulting to auto-approve for non-interactive hosts ([`orchestrator.ts#L48`](../../../src/core/orchestrator.ts#L48)). The shipped CLI implementation is [`createHitlHandler`](../../../src/cli/hitl-handler.ts#L13-L26) — a readline prompt ([`promptHitl`](../../../src/cli/hitl-handler.ts#L28-L56)) with two renders: [`renderDesignHitl`](../../../src/cli/hitl-handler.ts#L58-L94) (lists `design.mmd` + `spec.gherkin`) and [`renderTestGenerationHitl`](../../../src/cli/hitl-handler.ts#L96-L137) (lists the generated test files). A future VS Code extension or web UI can supply its own handler without core changes.

**Bypass for CI.** `--skip-hitl` ([`src/cli/index.ts#L72`](../../../src/cli/index.ts#L72)) sets `ctx.skipHitl`, which the machine's `skipHitl` guard ([`pipeline.machine.ts#L1159`](../../../src/core/machines/pipeline.machine.ts#L1159)) uses to skip both gates entirely — required for unattended pipeline runs.

---

## Consequences

### Positive

* **Cheapest high-leverage safety** — the architecture is human-approved before 7 passes of token spend; a hallucinated design is caught at the door.
* **Acceptance-criteria review** — reviewing the Red-Phase test suite before the Green Phase prevents vacuous/wrong-direction tests from being built against.
* **Human as a first-class machine state** — HITL is a declared state (`awaiting_hitl_pass_N`) with explicit `APPROVE`/`REWIND`/`REJECT` transitions, not an exception bolted onto the flow.
* **Port-based UI** — `HitlHandler` DI means the terminal readline prompt can be swapped for a VS Code/web UI without touching the core engine.
* **Autonomy preserved** — `--skip-hitl` keeps fully unattended CI runs possible for teams that opt out.

### Negative / Trade-offs

* **Manual latency** — each gate pauses the run for a human; blocks fully-autonomous CI runs without an explicit `--skip-hitl` flag.
* **Decision/title drift** — the original decision (gate after Pass 0 only) was extended in the implementation to two gates; the ADR title is stale relative to shipped behaviour (see H-2).
* **Destructive rewind** — `HITL_REWIND` performs `git reset --hard <prevCommit>` + `git clean -fd` ([`rewindToPassStart`](../../../src/core/machines/pipeline.machine.ts#L852-L870)); this is only safe because per-pass atomic commits provide an exact rewind target ([ADR-0003](./0003-atomic-commits-per-pass.md)).
* **Default auto-approve** — `onHitl` defaults to `() => Promise.resolve('APPROVE')`; a host that forgets to inject a real handler silently approves every gate.

---

## Placeholders / Open Items

| # | Topic | What is missing |
|---|---|---|
| H-1 | Prototype gate behaviour | Whether the predecessor prototype (`pipeline_v3_1.py`, `ai-factory-setup` repo) gated Pass 0 only or Pass 0 + 2 is not verifiable from this repository. |
| H-2 | **Title staleness** | ADR title "After Pass 0 Only" contradicts the shipped two-gate implementation. **Recommendation:** rename to `0004-hitl-gates-design-and-tests.md` (updating the [ADR index](../README.md) and all cross-references in the same change set, per STYLE_GUIDE § 3.1) or supersede this ADR. |
| H-3 | Decision date & deciders | Date is estimated (2026-06-01); no decider GitHub handles are recorded. |
| H-4 | Dead constant | `HITL_GATE_PASSES` ([`types.ts#L77-L80`](../../../src/core/types.ts#L77-L80)) is declared but **not consumed at runtime** — the machine hard-codes the pass-0/pass-2 gate wiring. Refactor candidate: drive the gate states from the set. |
