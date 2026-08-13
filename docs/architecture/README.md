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
| [0006](adrs/0006-context-control-optimisation.md) | Static Prefix Ordering for Prompt Cache Hits | Accepted | 2026-07-01 |
| [0007](adrs/0007-ast-grep-symbol-resolver.md) | `@ast-grep/napi` for In-Process Symbol Resolution | Accepted | 2026-08-08 |
| [0008](adrs/0008-observability-before-security.md) | Swap Pass Order — Observability Before Security | Accepted | 2026-08-01 |

## Key Documents

| Document | Purpose |
|---|---|
| [glossary.md](glossary.md) | Canonical definitions of domain terms |
| [overview.md](overview.md) | C4-style system map (TODO: create — C4 Level 1 & 2) |

## User Overview (Adopter Track)

> [!NOTE]
> Progressive-disclosure entry points for evaluators. Drafted pages are grounded in implemented code; the rest are placeholders.

| Page | Status |
|---|---|
| [1. Why This Exists — Problem & Philosophy](user-overview/01-why-this-exists.md) | Drafted (1 open item: FAQ placeholder) |
| [2. High-Level Architecture](user-overview/02-high-level-architecture.md) | Drafted (C4 L1 + at-a-glance flow; open items H-1–H-3) |
| [3. The 8-Pass Pipeline](user-overview/03-8-pass-pipeline.md) | Placeholder |
| [4. The Core Engine](user-overview/04-core-engine.md) | Drafted (overview) |
| [5. Agent Prompt System & Routing](user-overview/05-agent-prompt-system.md) | Drafted (overview) |
| [6. Token Economy & Cost Control](user-overview/06-token-economy.md) | Drafted (overview) |
| [7. Security Model & Sandboxing](user-overview/07-security-model.md) | Placeholder |
| [8. Engineering Concepts — Buzzword Map](user-overview/08-engineering-concepts.md) | Drafted |

## Contributor Deep Dive

> [!NOTE]
> Full implementation detail, grounded in `src/`. Pages 11, 13–15 are placeholders.

| Page | Status |
|---|---|
| [8. Core Engine Internals — Harness Engineering (XState)](contributor-deep-dive/08-core-engine-internals.md) | Drafted |
| [9. Prompt Engineering — Agent Files & Guardrails](contributor-deep-dive/09-prompt-engineering.md) | Drafted |
| [10. Context Engineering — Context Builder & Payload](contributor-deep-dive/10-context-engineering.md) | Drafted |
| [11. Infrastructure Adapters](contributor-deep-dive/11-infrastructure-adapters.md) | Placeholder |
| [12. CLI & Dependency Injection Wiring](contributor-deep-dive/12-cli-di-wiring.md) | Drafted (component map, DI contract, data flow) |
| [13. Observability, Logging, & Operations](contributor-deep-dive/13-observability-operations.md) | Placeholder |
| [14. Testing Strategy & Mock Patterns](contributor-deep-dive/14-testing-strategy.md) | Placeholder |
| [15. Developer Guide](contributor-deep-dive/15-developer-guide.md) | Placeholder |
| [16. ADRs & Roadmap](contributor-deep-dive/16-adrs-roadmap.md) | Placeholder |

> [!TIP]
> When adding a new ADR, assign the next sequence number and add a row to
> the index table above before merging.
