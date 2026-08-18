# 0007. `@ast-grep/napi` for In-Process Symbol Resolution

* **Status:** Accepted
* **Date:** 2026-08-08
* **Deciders:** @kcramakrishna

---

## Context

Context enrichment ([3. Context Engineering § 6](../contributor-deep-dive/03-context-engineering.md#6-context-enrichment--anchored-change-descriptors)) needs to tell each downstream pass **which symbols changed**, not just which files. After every guarded-pass commit, `doAtomicCommit` diffs the pass's base ref to its new HEAD and resolves each hunk to the enclosing function/method/class — producing `targetSymbols` and the anchored `fileChanges` that later passes consume ([`src/core/machines/pipeline.machine.ts#L941-L989`](../../../src/core/machines/pipeline.machine.ts#L941-L989)).

That resolution is a **per-hunk, in-memory AST lookup**: given a 1-based git-diff line range and the file's source, return the qualified name of the symbol that contains it. The port contract is explicit — `ISymbolResolver` **MUST** parse fully in memory, never open the filesystem, silently drop ranges without an enclosing symbol, and return `[]` (never throw) on malformed source ([`src/core/interfaces.ts#L219-L237`](../../../src/core/interfaces.ts#L219-L237)).

The implementation choice mattered because this runs inside the hot path of every guarded-pass commit, synchronously between the diff and the state-file write.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **Subprocess tools (tree-sitter CLI, semgrep)** | Rejected — spawns a binary per file/hunk, adding latency and process-management complexity; risk of race conditions and orphan processes. |
| **`@ast-grep/napi`** | **Chosen** — embedded native addon exposing a synchronous, in-process, zero-config tree-sitter-based API; simple to integrate and fast enough for real-time context. |
| **`web-tree-sitter` / WASM** | Deferred — kept as a future portability path (see placeholder A-2); not needed for the CLI-first engine today. |

---

## Decision

Use **`@ast-grep/napi ^0.45.1`** ([`package.json#L39`](../../../package.json#L39)) as the in-process AST parser and implement `AstGrepSymbolResolver` ([`src/infrastructure/ast-grep-symbol-resolver.ts#L231-L255`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L231-L255)) behind the `ISymbolResolver` port.

`mapRangesToSymbols(filePath, source, ranges)` ([`ast-grep-symbol-resolver.ts#L232-L254`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L232-L254)):

1. **Language detection** — `detectLang` maps the file extension via `EXTENSION_LANG` (`.ts/.tsx/.js/.jsx/.css/.html`) ([`#L6-L13`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L6-L13), [`#L31-L36`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L31-L36)); unsupported extensions return `[]`.
2. **In-memory parse** — `parse(lang, source)` with no filesystem or subprocess involvement; a parse failure returns `[]` (never throws).
3. **Enclosing-symbol walk** — `findEnclosingSymbol` walks the AST depth-first for the deepest node that contains the line and is in `ENCLOSING_KINDS` (`function_declaration`, `method_definition`, `arrow_function`, `class_declaration`, `generator_function_declaration`, `function_expression`) ([`#L15-L22`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L15-L22), [`#L205-L225`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L205-L225)).
4. **Qualified naming** — `buildQualifiedName` produces `ClassName.method` (class ancestors prepended) and, for test-style calls, `describe('Foo') › it('edge case')` via `TEST_CALL_NAMES` = `describe`/`it`/`test`/`context` ([`#L29`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L29), [`#L73-L84`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L73-L84), [`#L96-L138`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L96-L138)).
5. **Line-system conversion** — git ranges are 1-based, ast-grep is 0-based; the offset is applied at [`#L247`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L247).
6. **Dedupe + sort** — results are returned as a sorted, unique symbol list (the interface contract).

**Integration path:**

| Stage | Where | Role |
|---|---|---|
| 1. Diff ranges | `GitService.getDiffLineRanges(fromRef, toRef)` ([`src/infrastructure/git-service.ts#L99-L115`](../../../src/infrastructure/git-service.ts#L99-L115)) | `git diff --unified=0` parsed into per-hunk line ranges. |
| 2. Resolve symbols | `AstGrepSymbolResolver.mapRangesToSymbols` (above) | Per-hunk enclosing-symbol lookup. |
| 3. Anchor capture | `extractAnchor` ([`src/core/machines/pipeline.machine.ts#L716-L723`](../../../src/core/machines/pipeline.machine.ts#L716-L723)) | ~5 source lines at the hunk start — the drift-resistant anchor. |
| 4. Persist | `doAtomicCommit` ([`pipeline.machine.ts#L941-L989`](../../../src/core/machines/pipeline.machine.ts#L941-L989)) | Writes `symbols` + `anchor` into `fileChanges` and merges into `targetSymbols`. |
| 5. DI wiring | `createPipelineServices` ([`src/cli/di-container.ts#L58`](../../../src/cli/di-container.ts#L58)) | `new AstGrepSymbolResolver()` — disabled entirely under `--no-context-enrich`. |

> [!NOTE] Future: `web-tree-sitter` / WASM
> `@ast-grep/napi` was chosen over `web-tree-sitter` for its **simplicity** — a synchronous, zero-config, in-process API versus a WASM runtime plus async loader. Support for `web-tree-sitter` / WASM is planned for later versions to open pure-JS / browser-based environments; it is **not** shipped today. See placeholder A-2 and [2. High-Level Architecture § 3 — B.3](../user-overview/02-high-level-architecture.md#3-key-architectural-decisions).

---

## Consequences

### Positive

* **Fast, deterministic symbol anchoring** — in-process parse per file; no subprocess spawn latency, no race conditions or orphan processes per hunk.
* **Simplicity** — synchronous API, zero configuration, language-agnostic tree-sitter grammars bundled in the addon; a single small adapter satisfies the port.
* **Respects the pure-core DI contract** — the resolver never touches the filesystem (per `ISymbolResolver`), so it is unit-testable without I/O ([`test/infrastructure/ast-grep-symbol-resolver.test.ts`](../../../test/infrastructure/ast-grep-symbol-resolver.test.ts)) and keeps `src/core/` infrastructure-free ([ADR-0001](./0001-pure-core-engine.md)).
* **High-quality context in real time** — qualified `ClassName.method` / test-suite names are the raw material for `targetSymbols` and drift-resistant anchors.
* **Graceful degradation** — unsupported extension or parse error yields `[]`, never an exception; context enrichment can never block the pipeline ([`pipeline.machine.ts#L981-L983`](../../../src/core/machines/pipeline.machine.ts#L981-L983)).

### Negative / Trade-offs

* **Native addon** — `@ast-grep/napi` ships platform-specific binaries, adding install/build complexity versus a pure-JS parser; it must remain on the approved runtime-dependency registry (see placeholder A-1).
* **WASM portability deferred** — `web-tree-sitter` / WASM environments (browser tooling, sandboxed runners) are unsupported until the later-version work lands.
* **Limited language coverage** — `EXTENSION_LANG` covers TS/TSX/JS/JSX/CSS/HTML only; other languages silently produce no symbols, so enrichment is a no-op there.
* **Lossy grammar fidelity** — ast-grep grammars are coarser than a full language server; exotic node shapes can degrade qualified names to `anonymous` (placeholder A-4).
* **Silent metadata gaps** — because failures are swallowed by design, missing symbols are invisible except via structured logs.

---

## Placeholders / Open Items

| # | Topic | What is missing |
|---|---|---|
| A-1 | Approved runtime-dependency registry | The draft referenced an "Approved Runtime Dependencies sign-off in AGENTS.md § 10", but no such registry exists today — decide where the runtime-dependency approval list lives. |
| A-2 | `web-tree-sitter` / WASM support | Planned for later versions but not shipped; no timeline or triggering requirement is recorded. |
| A-3 | Language coverage | Whether/when to extend `EXTENSION_LANG` beyond TS/JS/CSS/HTML (e.g. Python, Go) is open; unsupported languages get no enrichment. |
| A-4 | `anonymous` fallback frequency | No data on how often qualified-name resolution degrades to `anonymous` for real code. |
| A-5 | Decision date & deciders | Date is set (2026-08-08); no decider GitHub handles are recorded. |
