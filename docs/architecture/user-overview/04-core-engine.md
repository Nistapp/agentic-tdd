# 4. The Core Engine

> **Target Audience:** Users — CTOs, Team Leads, and Architects (high-level; contributor details live in the Contributor Track).
> **Status:** PLACEHOLDER — not yet drafted.
> **Source of truth for structure:** [wiki-structure.md §4](../../../artefacts/documentation-prep/wiki/wiki-structure.md).

---

## Outline

- **Strict Boundaries:** `src/core/` has zero OS/Git imports. All side-effects injected via DI.
- **PipelineOrchestrator:** the central brain managing the 8 passes.

---

## Existing material to mine

- ADR [0001 — Pure Core Engine](../adrs/0001-pure-core-engine.md).
- DI contracts: `src/core/interfaces.ts` (`IGitService`, `IFileSystem`, `ICommandRunner`, `IAgentRunner`, `IEventBus`, `IStateStore`, `ILogger`, `ISymbolResolver`, `IContextProvider`).
- `PipelineOrchestrator` at `src/core/orchestrator.ts` (e.g. [`run()` at L80-L188](../../../src/core/orchestrator.ts#L80-L188)).
- Rationale for DI boundaries: [Misc-stuff §B.5](../../../artefacts/documentation-prep/wiki/Misc-stuff-to-include-in-wiki.md) (minimal own-surface / delegate to harness).

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| C-1 | Level-appropriate depth | User page must stay high-level; deep XState/detail belongs in Contributor page 8. Decide the split explicitly. |
| C-2 | Diagram | Reuse the "Multi-Pass Pipeline" / component Mermaid diagrams from `docs/architecture-manifesto.md`. |
