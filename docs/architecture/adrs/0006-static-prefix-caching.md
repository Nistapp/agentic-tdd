# 0006. Static Prefix Ordering for Prompt Cache Hits

* **Status:** Accepted
* **Date:** 2026-07-01 (estimated)
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: LLM providers (Anthropic, OpenAI) cache the KV state of a prompt prefix if the leading tokens are identical across requests. Randomly-ordered context files defeat this cache. -->

## Decision
<!-- TODO: contextFiles in every agent payload are ordered deterministically: contracts first (stable), then tests, then implementation. This immutable prefix maximises provider-level cache hits across all passes for the same feature run. -->

## Consequences
### Positive
* <!-- TODO: Measurable token cost reduction on long runs. -->

### Negative / Trade-offs
* <!-- TODO: File ordering is a hidden contract; changes to CONTEXT_RULES can silently break cache hits. -->
