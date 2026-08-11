# 0003. Atomic Git Commits Per Pass (Not Squashed)

* **Status:** Accepted
* **Date:** 2026-06-01 (estimated)
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: Multi-pass pipelines risk "merge hell" if all AI changes land in one commit. Explain the debugging advantage of being able to git revert exactly one pass. -->

## Decision
<!-- TODO: Each pass (from Pass 1) produces one atomic git commit. Rollback = git revert <sha>. originalBaseSha in state file enables full run revert via --abort. -->

## Consequences
### Positive
* <!-- TODO -->

### Negative / Trade-offs
* <!-- TODO: Linear history; squash-merging to main loses per-pass granularity. -->
