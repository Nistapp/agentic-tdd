# 0006. Static Prefix Ordering for Prompt Cache Hits

* **Status:** Accepted
* **Date:** 2026-07-01 (estimated)
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: We need to give right context to agents. How do we focus the agents on the specific changes of previous agents but also ensure that we give some leeway for the LLM to improvise. See Context Enrichment Architecture docs in artefact directory for details -->

## Decision
<!-- TODO: Agents/Passes log the changes. We build accurate context. Give some leeway to LLM -->

## Consequences
### Positive
* <!-- TODO: Prevent attention drift and context rot while controlling costs -->

### Negative / Trade-offs
* <!-- TODO: File ordering is a hidden contract; changes to CONTEXT_RULES can silently break cache hits. -->
