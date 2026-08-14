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
| [0006](adrs/0006-context-control-optimisation.md) | Static Prefix Ordering for Prompt Cache Hits | Deprecated (low priority — [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53)) | 2026-07-01 |
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
| [2. High-Level Architecture](user-overview/02-high-level-architecture.md) | Drafted (C4 L1 + at-a-glance flow; open items H-1–H-2) |
| [3. The 8-Pass Pipeline](user-overview/03-8-pass-pipeline.md) | Drafted (pass table, HITL, atomic commits & rollback) |
| [4. The Core Engine](user-overview/04-core-engine.md) | Drafted (concept: state machines & fit; impl linked to deep-dive) |
| [5. Agent Prompt System & Routing](user-overview/05-agent-prompt-system.md) | Drafted (overview) |
| [6. Context Engineering — Code Indexing & Token Savings](user-overview/06-context-and-token-savings.md) | Drafted (overview) |
| [7. Security Model & Sandboxing](user-overview/07-security-model.md) | Drafted (shipped hygiene vs. planned controls; open items S-4–S-8) |
| [8. Engineering Concepts — Buzzword Map](user-overview/08-engineering-concepts.md) | Drafted |

## Contributor Deep Dive

> [!NOTE]
> Full implementation detail, grounded in `src/`. Pages 7–9 are placeholders.

| Page | Status |
|---|---|
| [1. Core Engine Internals — Harness Engineering (XState)](contributor-deep-dive/01-core-engine-internals.md) | Drafted |
| [2. Prompt Engineering — Agent Files & Guardrails](contributor-deep-dive/02-prompt-engineering.md) | Drafted |
| [3. Context Engineering — Context Builder & Payload](contributor-deep-dive/03-context-engineering.md) | Drafted |
| [4. Infrastructure Adapters](contributor-deep-dive/04-infrastructure-adapters.md) | Drafted (port→adapter map, lifecycle edge cases; open items O-4–O-6) |
| [5. CLI & Dependency Injection Wiring](contributor-deep-dive/05-cli-di-wiring.md) | Drafted (component map, DI contract, data flow) |
| [6. Observability, Logging, & Operations](contributor-deep-dive/06-observability-operations.md) | Drafted (pino levels, log persistence, sanitizer, event UI; open items O-3–O-5) |
| [7. Testing Strategy & Mock Patterns](contributor-deep-dive/07-testing-strategy.md) | Placeholder |
| [8. Developer Guide](contributor-deep-dive/08-developer-guide.md) | Placeholder |
| [9. ADRs & Roadmap](contributor-deep-dive/09-adrs-roadmap.md) | Placeholder |

> [!TIP]
> When adding a new ADR, assign the next sequence number and add a row to
> the index table above before merging.
