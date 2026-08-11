# 0007. `@ast-grep/napi` for In-Process Symbol Resolution

* **Status:** Accepted
* **Date:** 2026-08-08
* **Deciders:** <!-- @github-handle -->

## Context
<!-- TODO: Agents need to know *which* methods changed in a git diff (targetSymbols), not just which files. Subprocess approaches (tree-sitter CLI, semgrep) add latency and process-management complexity. -->

## Decision
<!-- TODO: Use @ast-grep/napi (^0.45.1) — embedded, in-process, zero-config language-agnostic AST parser. AstGrepSymbolResolver maps git-diff line ranges to enclosing method/class symbols. No subprocess latency. See architecture-manifesto.md §4.4 for sign-off. -->

## Consequences
### Positive
* <!-- TODO: Fast, deterministic symbol anchoring; no subprocess race conditions. -->

### Negative / Trade-offs
* <!-- TODO: Native addon — adds platform-specific build complexity; must be listed in Approved Runtime Dependencies table. -->
