# 2. High-Level Architecture

> **Target Audience:** Users — CTOs, Team Leads, and Architects.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline

- **System Context (C4 Level 1):** Actors (Dev, Admin), External Systems (VCS, LLMs).
- **Component Map (C4 Level 2):** `core` / `infrastructure` / `cli` boundaries.
- **Data Flow:** Dev → CLI → Orchestrator → Agent Runner → LLM → Parse → Commit.

---

## Notes (design rationale for this page)

- **B.1 — Language: Node.js / TypeScript (not Python):** initially started in Python, shifted to Node/TS for ecosystem interoperability.
- **B.2 — State machine: XState:** XState helps manage transitions more robustly.
- **B.3 — Code parsing: napi (vs web-tree-sitter):** napi chosen for real-time high-quality context; web-tree-sitter may be supported later.
- **B.4 — Code-indexing: `codebase-memory-mcp`:** used instead of opencode's inbuilt indexer → independence + accurate context → fewer hallucinations / fewer duplicate utilities.
- **B.5 — Minimal own-surface: delegate to the harness:** let opencode handle as much as possible; support other tools in future (possibly `pi`).

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| A-1 | C4 Level 1 & 2 diagrams | Draft Mermaid diagrams from the existing C4-style diagrams (do not redraw). Link them here. |
| A-2 | Data flow diagram | `Dev → CLI → Orchestrator → Agent Runner → LLM → Parse → Commit` — verify against `src/cli/index.ts` and `src/core/orchestrator.ts`. |
| A-3 | Diátaxis placement | This is an Explanation/Architecture doc — follow `docs/templates/architecture-doc-template.md`. |
