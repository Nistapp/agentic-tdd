# 0003. Atomic Git Commits Per Pass (Not Squashed)

* **Status:** Accepted
* **Date:** 2026-06-01 (estimated)
* **Deciders:** <!-- @github-handle -->

---

## Context

agentic-tdd runs **8 sequential agent passes** over the same working tree ([`PipelinePass`](../../../src/core/types.ts#L15-L24)). Each pass can rewrite files left behind by the previous pass, so the pipeline's git history is the only trustworthy record of *what each pass actually did*.

If all agent changes accumulated into a single final commit, the pipeline would suffer the classic **"merge hell"** failure mode:

* **No per-pass attribution.** When a bug appears, there is no way to tell which pass introduced it — the tree is one undifferentiated blob.
* **Coarse rollback.** Reverting or bisecting requires throwing away the whole run, even when only Pass 6 (Security) went wrong.
* **Poor debugging.** You cannot step back to "the state right after Pass 3's test suite went green" to inspect it.
* **Fragile resume.** Without a commit boundary per pass, there is no durable marker that a pass succeeded and the next one can build on.

The core design requirement is that **rollback is the primary safety mechanism**: `git revert` of a single pass, rewind of an in-progress pass, and full-run abort must all be cheap and deterministic.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **One squash commit at the end of the run** | Rejected — no per-pass attribution, rollback is all-or-nothing, and a single late failure destroys the entire run. |
| **No commits during the run** (working tree only) | Rejected — nothing survives a crash, no resume point, no diff base for later passes or symbol capture. |
| **One atomic commit per pass** | **Chosen** — each pass leaves a durable, independently revertable boundary. |

---

## Decision

**Each of the 8 passes produces exactly one atomic git commit.** The commit is created by the `doAtomicCommit` actor in the pipeline machine ([`src/core/machines/pipeline.machine.ts#L871-L1012`](../../../src/core/machines/pipeline.machine.ts#L871-L1012)), which:

1. **Guards the commit.** Skips committing when the pass is not in `GIT_COMMIT_PASSES` (all 8 passes — [`src/core/types.ts#L62-L71`](../../../src/core/types.ts#L62-L71)) or when the pass was explicitly skipped (`SKIP:N:reason` signal) or implicitly skipped (no pending changes). Skipped passes are recorded in history with `status: 'skipped'`, never as empty commits.
2. **Stages and commits the whole tree.** Stages `.` plus the state file and commits with the machine-readable message:
   `chore(ai): completed Pass N -- <PASS_LABELS[N]> - <featureName>` ([`pipeline.machine.ts#L917-L919`](../../../src/core/machines/pipeline.machine.ts#L917-L919)).
3. **Degrades gracefully.** The underlying `IGitService.commit` ([`src/infrastructure/git-service.ts#L144-L174`](../../../src/infrastructure/git-service.ts#L144-L174)) returns a discriminated result — `committed` | `add_warning` | `nothing_to_commit` ([`GitCommitResult`](../../../src/core/types.ts#L287-L290)) — and per-file `git add` failures do not fail the pipeline.
4. **Records the SHA.** The resulting `commitHash` is stored in `ctx.history[pass]` and persisted to the state store, giving every later pass a stable diff base via `resolveFromRef` ([`pipeline.machine.ts#L703-L711`](../../../src/core/machines/pipeline.machine.ts#L703-L711)).
5. **Captures per-pass metadata.** When a `symbolResolver` is wired, the pass diff (from the previous pass's commit to HEAD) is mapped to touched symbols and drift-resistant anchors — see [1. Core Engine Internals § 4](../contributor-deep-dive/01-core-engine-internals.md#4-atomic-commit--symbol-capture-doatomiccommit).
6. **Tags completion.** After the final Documentation pass commits, a `Completed-<featureName>` git tag is created ([`pipeline.machine.ts#L928-L934`](../../../src/core/machines/pipeline.machine.ts#L928-L934)).

### Rollback story (three granularities)

| Granularity | Mechanism | Source |
|---|---|---|
| **Single pass** | `git revert <pass-sha>` — the atomic per-pass commit makes one-pass rollback trivial. | ADR-0003 decision |
| **In-progress pass (HITL rewind)** | `HITL_REWIND` → `rewindToPassStart` → `git abortToSha(prevPassCommitHash)` + `resetWorkingTree`, then the machine re-enters the pass ([`pipeline.machine.ts#L852-L870`](../../../src/core/machines/pipeline.machine.ts#L852-L870)). | HITL gate ([ADR-0004](./0004-hitl-gate-after-pass-0.md)) |
| **Full run** | Baseline SHA `originalBaseSha` is captured at session start ([`src/cli/session.ts#L197-L224`](../../../src/cli/session.ts#L197-L224)); `agentic-tdd --abort` rewinds via `abortToSha(originalBaseSha)` (`git reset --hard <sha>` + `git clean -fd`) and deletes the state file ([`src/cli/session.ts#L40-L59`](../../../src/cli/session.ts#L40-L59), [`src/infrastructure/git-service.ts#L211-L214`](../../../src/infrastructure/git-service.ts#L211-L214)). | `--abort` ([`src/cli/index.ts#L75-L76`](../../../src/cli/index.ts#L75-L76)) |

Resume builds on the same commits: `--resume` replays the persisted `xstateSnapshot`, and `getLastCompletedPass` greps `git log --grep='chore(ai): completed Pass '` to recover the highest completed pass when the state file is stale ([`src/infrastructure/git-service.ts#L181-L204`](../../../src/infrastructure/git-service.ts#L181-L204)).

---

## Consequences

### Positive

* **Per-pass attribution & debugging** — every commit is labelled with its pass (`chore(ai): completed Pass N -- <label>`), so bisecting or blaming maps directly to a pipeline stage.
* **Cheap, precise rollback** — a bad pass is one `git revert` away; a bad run is one `--abort` away; a rejected design is one HITL rewind away — no manual git surgery.
* **Durable resume boundaries** — the pass-commit pairs form a self-describing journal that makes `--resume` exact and crash-safe.
* **Foundation for per-pass metadata** — the diff between two consecutive pass commits is the ground truth used for symbol capture and context engineering.

### Negative / Trade-offs

* **Linear, noisy history** — one commit per pass means 8 commits per feature; consumers who squash-merge to `main` lose the per-pass granularity the ADR exists to provide.
* **Commit hygiene depends on the guard logic** — skipped/no-op passes are recorded as history entries rather than commits, which is correct but means the commit count may not equal the pass count.
* **Hard-reset semantics** — rewind/abort use `git reset --hard` + `git clean -fd`, which are destructive by design; the state file is the only guard against accidental reuse of the SHA.

---

## Placeholders / Open Items

| # | Topic | What is missing |
|---|---|---|
| A-1 | Prototype baseline | The ADR skeleton notes the prototype risked "merge hell if all AI changes land in one commit"; whether the prototype (`pipeline_v3_1.py`, predecessor `ai-factory-setup` repo) actually committed per pass or squashed is not verifiable from this repository. |
| A-2 | Decision date & deciders | Date is estimated (2026-06-01); no decider GitHub handles are recorded. |
| A-3 | Squash-merge policy | No documented guidance yet for how consumers should merge the 8 per-pass commits (rebase-and-squash vs. merge commit) — see [9. ADRs & Roadmap](../contributor-deep-dive/09-adrs-roadmap.md) if this becomes a roadmap item. |
