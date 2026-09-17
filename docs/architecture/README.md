# Architecture Documentation

This directory contains the high-level architecture documentation and
Architectural Decision Records (ADRs) for `agentic-tdd`.

## ADR Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](adrs/0001-pure-core-engine.md) | Pure Core Engine — No Infrastructure Imports in `src/core/` | Accepted | 2026-06-01 |
| [0002](adrs/0002-xstate-machines.md) | XState Machines Over Ad-hoc Loops | Accepted | 2026-08-01 |
| [0003](adrs/0003-atomic-commits-per-pass.md) | Atomic Git Commits Per Pass (Not Squashed) | Accepted | 2026-06-01 |
| [0004](adrs/0004-hitl-gate-after-pass-0.md) | HITL Gates After Pass 0 and Pass 2 | Accepted | 2026-06-01 |
| [0005](adrs/0005-context-compaction.md) | Context Compaction — Delete Error Logs on Pass Success | Accepted | 2026-07-01 |
| [0007](adrs/0007-ast-grep-symbol-resolver.md) | `@ast-grep/napi` for In-Process Symbol Resolution | Accepted | 2026-08-08 |
| [0008](adrs/0008-observability-before-security.md) | Swap Pass Order — Observability Before Security | Accepted | 2026-08-01 |
| [0009](adrs/0009-configurable-per-agent-models.md) | Configurable Per-Agent Models via `config.json` | Accepted | 2026-08-17 |
| [0010](adrs/0010-agent-agnostic-sdk-architecture.md) | Agent-Agnostic SDK Architecture | Accepted | 2026-09-04 |
| [0011](adrs/0011-mandatory-indexer-gate.md) | codebase-memory Indexer Is a Mandatory Harness Prerequisite | Accepted | 2026-09-09 |
| [0012](adrs/0012-opencode-sdk-default-backend.md) | opencode SDK Is the Default Agent Backend | Accepted | 2026-09-10 |
| [0013](adrs/0013-context-rule-chaining.md) | Chain Cumulative Context Across Additive Passes | Accepted | 2026-09-12 |

## Key Documents

| Document | Purpose |
|---|---|
| [glossary.md](glossary.md) | Canonical definitions of domain terms |
| [2. High-Level Architecture](user-overview/02-high-level-architecture.md) | C4-style system map (Level 1 for the shipped system) |

## User Overview (Adopter Track)

> [!NOTE]
> Progressive-disclosure entry points for evaluators. All pages are published and grounded in implemented code; minor open items are tracked per page.

| Page | Status |
|---|---|
| [1. Why This Exists — Problem & Philosophy](user-overview/01-why-this-exists.md) | Published (all open items resolved) |
| [2. High-Level Architecture](user-overview/02-high-level-architecture.md) | Published (open items H-1–H-2) |
| [3. The 8-Pass Pipeline](user-overview/03-8-pass-pipeline.md) | Published (pass table, HITL, atomic commits & rollback) |
| [4. The Core Engine](user-overview/04-core-engine.md) | Published (concept: state machines & fit; impl linked to deep-dive) |
| [5. Agent Prompt System & Routing](user-overview/05-agent-prompt-system.md) | Published (overview) |
| [6. Context Engineering — Code Indexing & Token Savings](user-overview/06-context-and-token-savings.md) | Published (overview) |
| [7. Security Model & Sandboxing](user-overview/07-security-model.md) | Published (shipped hygiene vs. planned controls; open items S-4–S-8) |
| [8. Engineering Concepts — Buzzword Map](user-overview/08-engineering-concepts.md) | Published |

## Contributor Deep Dive

> [!NOTE]
> Full implementation detail, grounded in `src/`.

| Page | Status |
|---|---|
| [1. Core Engine Internals — Harness Engineering (XState)](contributor-deep-dive/01-core-engine-internals.md) | Published |
| [2. Prompt Engineering — Agent Files & Guardrails](contributor-deep-dive/02-prompt-engineering.md) | Published |
| [3. Context Engineering — Context Builder & Payload](contributor-deep-dive/03-context-engineering.md) | Published |
| [4. Infrastructure Adapters](contributor-deep-dive/04-infrastructure-adapters.md) | Published (port→adapter map, lifecycle edge cases; open items O-4–O-6) |
| [5. CLI & Dependency Injection Wiring](contributor-deep-dive/05-cli-di-wiring.md) | Published (component map, DI contract, data flow) |
| [6. Observability, Logging, & Operations](contributor-deep-dive/06-observability-operations.md) | Published (pino levels, log persistence, sanitizer, event UI; open items O-3–O-5) |
| [7. Testing Strategy & Mock Patterns](contributor-deep-dive/07-testing-strategy.md) | Published (3-tier pyramid, DI mock inventory, machine & orchestrator patterns; open items T-3–T-5) |
| [8. Developer Guide](contributor-deep-dive/08-developer-guide.md) | Published (prereqs: Pi SDK + pi-mcp-adapter, codebase-memory-mcp, Node ≥ 22.19, `--backend`; opencode.json for the legacy opencode-cli backend only; open items G-1–G-3) |
| [9. ADRs & Roadmap](contributor-deep-dive/09-adrs-roadmap.md) | Published (ADR index/status, roadmap from retired `roadmap.md`, open debates; open items R-2–R-3) |

> [!TIP]
> ADRs are living, current-state documents. Revise an existing ADR **in place**
> when a decision changes and delete it when it becomes irrelevant; assign the
> next number (`highest-ever + 1`, never reused) only for a brand-new decision.
> Add a row to the index table above when an ADR is added, revised, or deleted.
> See [STYLE_GUIDE §7](../STYLE_GUIDE.md#7-architectural-decision-record-adr-lifecycle).
