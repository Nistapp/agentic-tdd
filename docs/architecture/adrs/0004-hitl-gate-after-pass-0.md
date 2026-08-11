# 0004. Human-in-the-Loop Gate After Pass 0 Only

* **Status:** Accepted
* **Date:** 2026-06-01 (estimated)
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: Explain the risk of AI hallucinating wrong architecture. Forcing a human to approve .mmd and .gherkin before any code is written is the cheapest and highest-leverage safety check. -->

## Decision
<!-- TODO: HITL gate fires once: after Pass 0 outputs design.mmd and spec.gherkin. Developer must explicitly approve or iterate before Passes 1-7 run. Gate is DI-injectable for future UI alternatives (VS Code extension, web UI). -->

## Consequences
### Positive
* <!-- TODO -->

### Negative / Trade-offs
* <!-- TODO: Adds a manual step; blocks fully-autonomous CI runs without a --skip-hitl flag. -->
