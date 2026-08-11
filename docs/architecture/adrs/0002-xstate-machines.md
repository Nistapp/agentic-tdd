# 0002. XState Machines Over Ad-hoc Loops for Pipeline & Self-Correction

* **Status:** Accepted
* **Date:** 2026-08-01 (estimated)
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: Explain the original ad-hoc loop approach (pipeline_v3_1.py), why it became hard to reason about, and what guarantees XState gives (exhaustive transitions, no implicit state, testable without side-effects). -->

## Decision
<!-- TODO: Two machines: createPipelineMachine (8 passes) and createSelfCorrectionMachine (per-pass retry loop). Both are pure functions — no I/O, injected via DI. -->

## Consequences
### Positive
* <!-- TODO -->

### Negative / Trade-offs
* <!-- TODO: XState v5 learning curve; actor model adds indirection. -->
