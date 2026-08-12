# Architecture Documentation

This directory contains the high-level architecture documentation and
Architectural Decision Records (ADRs) for `agentic-tdd`.

## ADR Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](adrs/0001-pure-core-engine.md) | Pure Core Engine — No Infrastructure Imports in `src/core/` | Accepted | 2026-06-01 |
| [0002](adrs/0002-xstate-machines.md) | XState Machines Over Ad-hoc Loops | Accepted | 2026-08-01 |
| [0003](adrs/0003-atomic-commits-per-pass.md) | Atomic Git Commits Per Pass (Not Squashed) | Accepted | 2026-06-01 |
| [0004](adrs/0004-hitl-gate-after-pass-0.md) | HITL Gate After Pass 0 Only | Accepted | 2026-06-01 |
| [0005](adrs/0005-context-compaction.md) | Context Compaction — Delete Error Logs on Pass Success | Accepted | 2026-07-01 |
| [0006](adrs/0006-static-prefix-caching.md) | Static Prefix Ordering for Prompt Cache Hits | Accepted | 2026-07-01 |
| [0007](adrs/0007-ast-grep-symbol-resolver.md) | `@ast-grep/napi` for In-Process Symbol Resolution | Accepted | 2026-08-08 |
| [0008](adrs/0008-observability-before-security.md) | Swap Pass Order — Observability Before Security | Accepted | 2026-08-01 |

## Key Documents

| Document | Purpose |
|---|---|
| [architecture-manifesto.md](../../docs/architecture-manifesto.md) | Full design rationale, infrastructure decisions, agent guardrails |
| [glossary.md](glossary.md) | Canonical definitions of domain terms |
| [overview.md](overview.md) | C4-style system map (TODO: create from wiki-structure.md §2) |

## User Overview (Adopter Track)

> [!NOTE]
> Progressive-disclosure entry points for evaluators. See `artefacts/documentation-prep/wiki/wiki-structure.md` for the full planned tree. Most pages are still placeholders awaiting drafting.

| Page | Status |
|---|---|
| [1. Why This Exists — Problem & Philosophy](user-overview/01-why-this-exists.md) | Drafted (1 open item: FAQ placeholder) |
| [2. High-Level Architecture](user-overview/02-high-level-architecture.md) | Placeholder |
| [3. The 8-Pass Pipeline](user-overview/03-8-pass-pipeline.md) | Placeholder |
| [4. The Core Engine](user-overview/04-core-engine.md) | Placeholder |
| [5. Agent Prompt System & Routing](user-overview/05-agent-prompt-system.md) | Placeholder |
| [6. Token Economy & Cost Control](user-overview/06-token-economy.md) | Placeholder |
| [7. Security Model & Sandboxing](user-overview/07-security-model.md) | Placeholder |
| [14. ADRs & Roadmap (Contributor)](contributor-deep-dive/14-adrs-roadmap.md) | Placeholder |

> [!TIP]
> When adding a new ADR, assign the next sequence number and add a row to
> the index table above before merging.
