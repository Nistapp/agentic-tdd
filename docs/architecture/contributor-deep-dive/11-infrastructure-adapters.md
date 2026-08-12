# 11. Infrastructure Adapters

> **Target Audience:** Contributors implementing or replacing DI adapters.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline

- **OpenCode Agent Runner:** `src/infrastructure/open-code-agent-runner.ts` — `execa`/spawner wrappers, argv assembly, per-pass log persistence.
- **AST-Grep Symbol Resolver:** `src/infrastructure/ast-grep-symbol-resolver.ts` — `@ast-grep/napi` mapping of diff hunks to enclosing symbols (see [10. Context Engineering §6](10-context-engineering.md#6-context-enrichment--anchored-change-descriptors)).
- **State Store:** session persistence (`IStateStore`).
- **Git Service:** atomic commits, diff line ranges, feature branches, `--abort` rewinds.
- **Command Runner / Event Bus / File System / Logger:** the remaining DI ports.

---

## Existing material to mine

- DI port contracts: [`src/core/interfaces.ts`](../../../src/core/interfaces.ts).
- Wiring: `src/cli/di-container.ts` (see [12. CLI & DI Wiring](12-cli-di-wiring.md)).
- ADR [0007 — AST-Grep Symbol Resolver](../adrs/0007-ast-grep-symbol-resolver.md).

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| I-1 | Adapter-by-adapter map | Per-interface table: port → concrete class → key methods → line anchors. |
| I-2 | Lifecycle edge cases | Session locking, crash recovery, partial-commit handling. |
