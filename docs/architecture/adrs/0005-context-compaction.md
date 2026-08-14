# 0005. Context Compaction — Delete Error Logs on Pass Success

* **Status:** Accepted
* **Date:** 2026-07-01 (estimated)
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: Error logs from a failed attempt, if left on disk, are injected into the next pass's context window, polluting it with stale failure noise and burning tokens. -->

## Decision
<!-- TODO: On successful pass completion, the error.log for that pass is deleted. Future passes start with a clean slate. -->

## Consequences
### Positive
* <!-- TODO -->

### Negative / Trade-offs
* <!-- TODO: Post-mortem debugging of transient failures is harder — logs are gone after success. -->
