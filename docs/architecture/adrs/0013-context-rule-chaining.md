# 0013. Chain Cumulative Context Across Additive Passes

* **Status:** Accepted
* **Date:** 2026-09-12
* **Deciders:** @kcramakrishna

---

## Context

`CONTEXT_RULES` ([`src/core/context-builder.ts#L10-L104`](../../../src/core/context-builder.ts#L10-L104)) declares, per pass, which upstream passes contribute source files (`files`) and which contribute `targetSymbols`/`fileChanges` (`target`). It is the single control point for the context hand-off described in [3. Context Engineering](../contributor-deep-dive/03-context-engineering.md).

An audit of the hand-off from Pass 2 onward found that the table under-delivered context to the later passes:

1. **Prompt/bucket mismatch** — Pass 2 and Pass 3 prompts instructed the agent to read the Pass 1 contracts from `contextFiles.implementation`, but Pass 1 output is categorised as `contextFiles.contracts`, leaving `implementation` empty. Pass 1 itself pointed at an always-empty bucket.
2. **Additive passes dropped their history.** Passes 5 (Observability) and 6 (Security) inherited implementation files from **Refactor only** (`files.implementation: [Refactor]`). Refactor edits a *subset* of Pass 3's output, so any file created/edited in Pass 3 but untouched by Refactor vanished from `contextFiles`. If Refactor was skipped or made no changes, Pass 5/6 received an entirely empty implementation set, `targetSymbols`, and `fileChanges`.
3. **No Observability → Security chain.** Security's `targetSymbols`/`fileChanges` derived from Refactor only, so it lacked the precise descriptors for the log statements it is required to audit (recorded as open item O-1 in [ADR-0008](./0008-observability-before-security.md)).
4. **Documentation missed Pass 1 contracts.** Pass 7 is the only pass that treats `targetSymbols` as a hard scope boundary, but it sourced symbols only from Passes 3–6. Pure type/interface declarations introduced in Pass 1 — the public API surface — could only be documented if a later hunk happened to enclose them.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **Keep "N receives N−1 only"** | Rejected — additive passes degrade when their immediate predecessor is partial or skipped, and Security cannot review Observability's changes precisely. |
| **Chain the full implementation history** (chosen) | Pass each additive pass the cumulative union of its upstream implementation passes. A skipped or partial predecessor can no longer blank out context, and each specialist sees the complete instrumented surface. |
| **Have agents discover everything via the indexer** | Rejected as the sole mechanism — the curated payload exists to avoid full-repo rescanning and token bloat ([ADR-0006](./0006-context-control-optimisation.md)); the indexer remains the supplement, not the replacement. |

---

## Decision

`CONTEXT_RULES` chains cumulative context across the additive passes:

| Pass | files.implementation | target (merge from) |
|---|---|---|
| 3 CoreImplementation | — (contracts + tests only) | Pass 1, Pass 2 |
| 4 Refactor | Pass 3 | Pass 3 |
| 5 Observability | Pass 3, Pass 4 | Pass 3, Pass 4 |
| 6 Security | Pass 3, Pass 4, Pass 5 | Pass 3, Pass 4, Pass 5 |
| 7 Documentation | Pass 3, 4, 5, 6 | Pass 1, Pass 3, 4, 5, 6 |

Additional decisions in the same change set:

* **Prompt bucket alignment.** Pass 2/3 read Pass 1 contracts from `contextFiles.contracts`; Pass 1 no longer references an empty bucket; Pass 2's dead `use-file-changes` rule is removed (it has no implementation upstream).
* **Pass 7 contract scope.** Pass 7 now receives Pass 1 contract files **and** symbols, closing the type-only documentation hole.
* **Merge semantics unchanged.** `targetSymbols` is unioned (deduped + sorted) across the chained passes; `fileChanges` remains **latest-pass-wins per file** ([`context-provider.ts#L33-L39`](../../../src/core/context-provider.ts#L33-L39)). Chaining broadens the symbol map without a schema change.

---

## Consequences

### Positive

* **Resilient to partial/skipped predecessors** — Pass 5/6 keep Pass 3 context even when Refactor makes no changes.
* **Security reviews the full instrumented surface** — Pass 6 now carries Observability's `targetSymbols`/`fileChanges`, resolving ADR-0008 O-1.
* **Public API is documented** — Pass 7 can document the Pass 1 contract symbols that form the frozen API surface.
* **Prompt and payload agree** — agents are told to read the bucket that actually holds the data.

### Negative / Trade-offs

* **Larger payloads** — Passes 5–7 receive more files and symbols, raising token cost; the curated cap (a few implementation passes) keeps this bounded.
* **`fileChanges` latest-wins per file** — for a file touched by several chained passes, only the newest pass's hunks are carried. Drift-resistant anchors still locate the code, and `commitHash` provenance is preserved per record. A future ADR may union hunks with per-hunk provenance.
* **Non-JS/TS symbol coverage** — `AstGrepSymbolResolver` currently resolves symbols only for TypeScript/JavaScript/CSS/HTML, so `targetSymbols` (and therefore Pass 7's hard scope) is empty on other languages. Chaining does not change this; a web-tree-sitter replacement is tracked separately.

---

## Related

* [3. Context Engineering](../contributor-deep-dive/03-context-engineering.md) · [6. Context Engineering — User View](../user-overview/06-context-and-token-savings.md)
* [ADR-0007 AST-Grep Resolver](./0007-ast-grep-symbol-resolver.md) · [ADR-0008 Observability Before Security](./0008-observability-before-security.md) (O-1 resolved)
* `src/core/context-builder.ts`, `src/core/context-provider.ts`, `src/core/runners/shared.ts`
