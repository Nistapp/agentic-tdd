# 10. Context Engineering — Context Builder & Payload

> **Target Audience:** Contributors extending context selection or payload shape.
> **Status:** DRAFT — grounded in `src/core/context-builder.ts`, `context-provider.ts`, `runners/shared.ts`.
> **Prev:** [2. Prompt Engineering](02-prompt-engineering.md) · **Next:** [4. Infrastructure Adapters](04-infrastructure-adapters.md)

---

## Overview

Context Engineering is the discipline of deciding **exactly which files and symbols each pass sees**. Rather than dumping the repo, the harness builds a **curated, per-pass context** so agents get *where to start* and *what changed* — without paying for irrelevant tokens or hallucinating structure.

The pipeline runs through three layers:

```
PipelineContext (history, paths, config)
    │
    ▼
StateContextProvider.build(ctx, pass)   → BuiltContext { files, targetSymbols, fileChanges }
    │
    ▼
getAgentContextPayload(ctx, built)      → JSON string (the prompt text)
buildArtefacts(ctx, fs, built, errLog)  → --file attachments
    │
    ▼
OpenCodeAgentRunner.#buildArgs()        → opencode run --agent pass-N --file … <prompt>
```

> [!IMPORTANT]
> `contextFiles` are **filename hints**, not injected file contents. The agent reads them with its own tools (`read`/`glob`/`grep`/MCP). `--file` attachments (design artefact, spec, error log) are injected directly into the context window. See [docs/Note-on-context-mgmt.md](../../../docs/Note-on-context-mgmt.md).

---

## 1. `CONTEXT_RULES` — the per-pass selection table

`src/core/context-builder.ts#L10-L83` declares, for every pass, two categories — `files` (which upstream pass outputs to attach) and `target` (which upstream passes' `targetSymbols`/`fileChanges` to merge):

| Pass | files.contracts | files.tests | files.implementation | target (merge from) |
|---|---|---|---|---|
| 0 Design | — | — | — | — |
| 1 Contracts | — | — | — | — |
| 2 TestGeneration | Pass 1 | — | — | — |
| 3 CoreImplementation | Pass 1 | Pass 2 | — | — |
| 4 Refactor | — | Pass 2 | Pass 3 | Pass 3 |
| 5 Observability | — | — | Pass 4 | Pass 4 |
| 6 Security | — | — | Pass 4 | Pass 4 |
| 7 Documentation | — | — | Pass 3,4,5,6 | — |

Rules are evaluated against `ctx.history[pass].filesTouched` to collect concrete file lists. This is the **"N's output = N+1's read-only context"** invariant, made declarative.

---

## 2. `StateContextProvider.build` — assembling the payload

`src/core/context-provider.ts#L11-L43` is a **pure, synchronous** assembler (no git/AST/async):

1. `buildContextFiles(ctx, pass)` → `{ contracts, tests, implementation }`.
2. `buildTargetPasses(pass)` → the upstream passes to inherit from.
3. For each upstream pass, **merge** its `targetSymbols` (deduped + sorted per file) and `fileChanges` (latest upstream pass wins per file).

Returned `BuiltContext`:

| Field | Meaning |
|---|---|
| `files` | `{ contracts, tests, implementation }` filename hints |
| `targetSymbols` | `filePath → [qualified symbol names]` changed upstream |
| `fileChanges` | `filePath → { commitHash, kind, hunks: [{ range, added/modified/deleted, symbols, anchor }] }` |

---

## 3. Payload & Artefact construction (`runners/shared.ts`)

### 3.1 `getAgentContextPayload`

Serialises the JSON prompt passed to the agent ([`src/core/runners/shared.ts#L5-L29`](../../../src/core/runners/shared.ts#L5-L29)):

```json
{
  "featureName": "...",
  "featureDescription": "...",
  "pipelineVersion": "...",
  "paths": { "designMmd": "...", "specGherkin": "...", "errorLog": "..." },
  "contextFiles": { "contracts": [], "tests": [], "implementation": [] },
  "targetSymbols": {},
  "fileChanges": {},
  "meta": { "attemptNumber": 1 }
}
```

On self-correction cycles (attempt ≥ 2), `meta.attemptNumber` is set and the error log path is attached so the agent can diagnose the failure.

### 3.2 `buildArtefacts`

Conditionally attaches `--file` paths ([`src/core/runners/shared.ts#L31-L68`](../../../src/core/runners/shared.ts#L31-L68)): `designMmd`, `specGherkin`, the original feature spec file, and (on retries) `errorLog`.

---

## 4. Static Prefix (ADR-0006)

> [!NOTE] Deprecated / low priority
> Static Prefix ordering (placing **stable files first** — contracts/specs — to maximise provider-level KV **cache hits** across passes) is **deprecated** pending research. Each pass can now be configured with its own LLM, and whether prefix engineering still helps is unclear. See [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53) and [ADR-0006](../adrs/0006-context-control-optimisation.md). Do not invest further in cache-hit ordering until that question is settled.

## 5. Context Compaction (ADR-0005)

On guarded-pass success, `cleanupAfterSuccess` **deletes the pass error log**, so retries of later passes start clean instead of being polluted by stale failure noise. See [ADR-0005](../adrs/0005-context-compaction.md) and [1. Core Engine Internals §2.1](01-core-engine-internals.md#21-the-loop).

## 6. Context Enrichment — anchored change descriptors

`doAtomicCommit` (pipeline machine) resolves per-hunk metadata after each commit:

1. `git diff --unified=0` between the pass's base ref and HEAD.
2. `AstGrepSymbolResolver.mapRangesToSymbols` maps each hunk to its **enclosing symbol** (function/method/class; test calls resolve to `describe('Foo') › it('edge case')`). See [`src/infrastructure/ast-grep-symbol-resolver.ts`](../../../src/infrastructure/ast-grep-symbol-resolver.ts) and [ADR-0007](../adrs/0007-ast-grep-symbol-resolver.md).
3. `extractAnchor` captures ~5 non-empty source lines at the hunk start — a **drift-resistant anchor** because absolute line numbers shift when later passes edit the same file.
4. Persist `targetSymbols` + `fileChanges` to `ctx.history[pass]` and the state store.

> [!TIP] Real worked example
> See [docs/architecture/examples/example-state-file.json](../examples/example-state-file.json) — a verbatim session state file from a real run. It shows `history[0..6].fileChanges` in practice: scoped hunks, drift-resistant anchors, and the `commitHash` provenance that makes each entry retrievable via `git show <sha>:<file>`. The descriptor *chases the changes* from pass to pass (contracts → tests → implementation → refactor → observability → security).

> [!NOTE] Non-fatal degradation
> If diff/symbol resolution fails, the commit still lands with empty metadata (`catch {}`). Design intent: context enrichment must never block the pipeline.

---

## 7. How Agents Consume It

- `context_philosophy` in every prompt: the payload is a **starting point**, not the whole picture; use the indexer to supplement.
- `target-symbols-priority`: focus edits on listed symbols, with an `OUT-OF-SCOPE` justification gate for discoveries.
- `use-file-changes`: navigate by `range` + `anchor` + `commitHash` (`git show <sha>:<file>`), not absolute lines.

See [2. Prompt Engineering §3](02-prompt-engineering.md#3-the-directive-catalogue-cross-pass-patterns).

---

## Related

- [6. Context Engineering — Code Indexing & Token Savings (User view)](../user-overview/06-context-and-token-savings.md)
- [ADR-0005 Context Compaction](../adrs/0005-context-compaction.md) · [ADR-0006 Static Prefix (deprecated)](../adrs/0006-context-control-optimisation.md) · [ADR-0007 AST-Grep Resolver](../adrs/0007-ast-grep-symbol-resolver.md)
- [docs/Note-on-context-mgmt.md](../../../docs/Note-on-context-mgmt.md)
