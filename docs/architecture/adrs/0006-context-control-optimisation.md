# 0006. Static Prefix Ordering for Prompt Cache Hits

* **Status:** Deprecated — low priority, may no longer be relevant
* **Date:** 2026-07-01 (estimated)
* **Deciders:** <!-- @github-handle -->

> [!NOTE] Deprecation
> Static Prefix caching has been **deprecated** pending further research. Each agent/pass can now be configured with its own LLM, and the value of engineering prefix-cache hits across passes is no longer clear. Tracked in [discussion #53 — "Static Prefix caching redundant?"](https://github.com/Nistapp/agentic-tdd/discussions/53). The feature is not lost to regression, but it is deferred until we establish whether it still helps in our context.

## Context
<!-- TODO: We need to give right context to agents. How do we focus the agents on the specific changes of previous agents but also ensure that we give some leeway for the LLM to improvise. See Context Enrichment Architecture docs in artefact directory for details -->

## Decision
<!-- TODO: Agents/Passes log the changes. We build accurate context. Give some leeway to LLM -->

## Consequences
### Positive
* <!-- TODO: Prevent attention drift and context rot while controlling costs -->

### Negative / Trade-offs
* <!-- TODO: File ordering is a hidden contract; changes to CONTEXT_RULES can silently break cache hits. -->
* Prefix-cache engineering may be moot once each pass uses a different model — see [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53).
