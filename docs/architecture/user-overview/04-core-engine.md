# 4. The Core Engine (High-Level Overview)

> **Target Audience:** Users — CTOs, Team Leads, and Architects evaluating agentic-tdd.
> **Key Goal:** Explain *why* the core engine is built the way it is — as a **state machine** — and why that is the right mental model for orchestrating AI agents.
> **Status:** Draft — wiki page 4 of the User Overview. Concept-focused; implementation details are linked out to the Contributor Track.

---

## Executive Summary

The core engine is the part of agentic-tdd that **orchestrates the pipeline**: it decides which pass runs next, when to stop, when to ask a human, and how to recover from a failure. It is deliberately modelled as a **state machine** — not as a script of `if`/`while` steps.

This page explains, in plain terms, what a state machine is, what it buys you, and why it is an unusually good fit for *orchestrating AI*.

> [!NOTE]
> This page is conceptual. If you want the concrete implementation — `PipelineOrchestrator`, the XState machines, the DI boundaries — see **[1. Core Engine Internals (Contributor)](../contributor-deep-dive/01-core-engine-internals.md)**.

---

## 1. What Is a State Machine?

A **state machine** is a way of describing a system as a finite set of *states* plus the *transitions* between them. Two concepts only:

- **State** — "where the system is right now." For the pipeline: `pass_0_design`, `awaiting_hitl`, `committing`, `paused`, `pipeline_complete`…
- **Transition** — "what event moves it to the next state." For the pipeline: `PASS_COMPLETED`, `HITL_APPROVE`, `TEST_RUN_FAILED`…

The core rule: **the machine can only ever be in one state at a time, and it can only move along declared transitions.** It cannot "drift" into some half-defined condition, because there is no such condition to be in.

> [!TIP] A familiar example
> A traffic light is a state machine: `red → green → amber → red`. You never get `red+green` at once, because that state was never declared. A pedestrian crossing works the same way — you cannot enter the road while cars are moving, because the `crossing-allowed` state only exists when the light is red.

---

## 2. Why State Machines?

| Benefit | What it means for a pipeline |
|---|---|
| **No undefined states** | The system can never be in an in-between condition. Either the pass committed or it didn't — there is no "sort of committed" state to corrupt the repo. |
| **Explicit, inspectable flow** | Every possible path is visible in one diagram (see [3. The 8-Pass Pipeline](03-8-pass-pipeline.md)). You can *see* the whole system's behaviour instead of tracing through scattered code. |
| **Deterministic execution** | The same event in the same state always produces the same transition. No hidden branching, no order-dependent behaviour. |
| **First-class pause / resume** | A state machine's current position is a single, serialisable value. Saving it = pausing; loading it = resuming. This is exactly what `--pause` / `--resume` need. |
| **Safe failure & rollback** | If a step fails, the machine knows exactly which state it is in — and can retry, rewind, or abort from a known point instead of guessing. |
| **Exhaustively testable** | Because all states and transitions are declared, tests can walk *every* path. No "we never tested that branch" gaps. |

---

## 3. Why It's a Good Fit for *Our* Use Case

Orchestrating AI agents is one of the **best-case scenarios** for a state machine, for three reasons:

### 3.1 AI output is non-deterministic — the machine is not

Agents produce different output every run. Left unmanaged, that non-determinism compounds. The state machine provides the *fixed, deterministic scaffold* around the non-deterministic agent: the agent may write any code, but the machine strictly controls *when* it runs, *what* it may touch, and *when its output is accepted*. See [1. § 2.1 — Deterministic Verification of Non-Deterministic Generation](01-why-this-exists.md#21-deterministic-verification-of-non-deterministic-generation).

### 3.2 The pipeline is inherently sequential and gated

Eight passes in a fixed order, with human gates and test gates between them — that is literally a state machine. Expressing it that way is not ceremony; it *is* the simplest accurate description:

```text
Pass N --(agent completes)--> Test gate --(passes)--> commit --> Pass N+1
                                                --(fails)--> retry loop
```

### 3.3 Human-in-the-loop checkpoints are natural states

HITL is not an exception to the flow — it is a **state** the machine parks in (`awaiting_hitl`), waits for human input, and leaves via a declared transition (`HITL_APPROVE` / `HITL_REWIND` / `HITL_REJECT`). The human is a first-class participant in the machine, not an interruption bolted on later.

> [!IMPORTANT] The one-line takeaway
> **The pipeline's job is to control *when* agents act — and a state machine is the most reliable known way to control "when".** Agents are the wild cards; the machine is the cage that keeps the wild cards from wrecking the repo.

### 3.4 Why we chose XState

We chose XState simply becuase it is the most widely used, and well tested. It has very rich features which will be useful when this framework evolves to support complex use-cases and even parallel pipelines.  

---

## 4. What the Engine *Is* (in one paragraph)

Technically, the engine is **`src/core/` — a pure, dependency-injected state machine**. "Pure" means it has zero direct knowledge of filesystems, git, or processes; every OS side-effect is injected through interfaces, so the engine only ever talks to contracts. This is what makes it fully unit-testable and embeddable (a future VS Code extension can reuse it unchanged). See [ADR-0001 — Pure Core Engine](../adrs/0001-pure-core-engine.md).

---

## Deep Dives (Contributor Track)

The implementation of everything above lives in the Contributor Track:

| Topic | Where |
|---|---|
| `PipelineOrchestrator` — the host that runs the machines, bridges HITL, persists state | [1. Core Engine Internals — The Host `PipelineOrchestrator`](../contributor-deep-dive/01-core-engine-internals.md) |
| The two XState machines (`createPipelineMachine`, `createSelfCorrectionMachine`) | [1. Core Engine Internals — Harness Engineering (XState)](../contributor-deep-dive/01-core-engine-internals.md) |
| Engine module map & DI boundaries | [1. Core Engine Internals — Boundaries](../contributor-deep-dive/01-core-engine-internals.md) · [5. CLI & DI Wiring](../contributor-deep-dive/05-cli-di-wiring.md) |
| Why pure + XState (the decisions) | [ADR-0001](../adrs/0001-pure-core-engine.md) · [ADR-0002](../adrs/0002-xstate-machines.md) |

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| C-1 | Config-driven evolution | Since we have XState, the engine can easily evolve into a **config-driven framework** — planned, not shipped. Track in [9. ADRs & Roadmap]. |

---

## Related Pages

- Previous: [3. The 8-Pass Pipeline](03-8-pass-pipeline.md)
- Next: [5. Agent Prompt System & Routing](05-agent-prompt-system.md)
- Deep dives: [1. Core Engine Internals — Harness Engineering (XState)](../contributor-deep-dive/01-core-engine-internals.md) · [3. Context Engineering](../contributor-deep-dive/03-context-engineering.md) · [5. CLI & DI Wiring](../contributor-deep-dive/05-cli-di-wiring.md)
- ADRs: [0001 Pure Core Engine](../adrs/0001-pure-core-engine.md) · [0002 XState Machines](../adrs/0002-xstate-machines.md)
