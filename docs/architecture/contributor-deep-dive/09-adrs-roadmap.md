# 9. ADRs & Roadmap

> **Target Audience:** Contributors and evaluators interested in the project's trajectory.
> **Status:** Published — ADR index grounded in `docs/architecture/adrs/`; roadmap consolidated from the retired `docs/roadmap.md`.
> **Prev:** [8. Developer Guide](08-developer-guide.md)

---

## Overview

This page is the single destination for two kinds of project memory:

1. **Architecture Decision Records (ADRs)** — the current-state decision log, numbered sequentially in `docs/architecture/adrs/`. Entries are mirrored in the [architecture index](../README.md).
2. **Roadmap** — the consolidated backlog for the *shipped* framework, formerly kept in `docs/roadmap.md` (retired during the documentation restructure). Anything below marked `planned` is **aspirational**, not shipped — see [8. Engineering Concepts §Planned](../user-overview/08-engineering-concepts.md#concepts-that-are-planned-not-shipped).

---

## 1. ADR Index & Status

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](../adrs/0001-pure-core-engine.md) | Pure Core Engine — no infrastructure imports in `src/core/` | Accepted | 2026-06-01 |
| [0002](../adrs/0002-xstate-machines.md) | XState machines over ad-hoc loops | Accepted | 2026-08-01 |
| [0003](../adrs/0003-atomic-commits-per-pass.md) | Atomic git commits per pass (not squashed) | Accepted | 2026-06-01 |
| [0004](../adrs/0004-hitl-gate-after-pass-0.md) | HITL gates after Pass 0 and Pass 2 | Accepted | 2026-06-01 |
| [0005](../adrs/0005-context-compaction.md) | Context Compaction — delete error logs on pass success | Accepted | 2026-07-01 |
| [0007](../adrs/0007-ast-grep-symbol-resolver.md) | `@ast-grep/napi` for in-process symbol resolution | Accepted | 2026-08-08 |
| [0008](../adrs/0008-observability-before-security.md) | Swap pass order — Observability (5) before Security (6) | Accepted | 2026-08-01 |
| [0009](../adrs/0009-configurable-per-agent-models.md) | Configurable per-agent models via `config.json` | Accepted | 2026-08-17 |
| [0010](../adrs/0010-agent-agnostic-sdk-architecture.md) | Agent-agnostic SDK architecture | Accepted | 2026-09-04 |
| [0011](../adrs/0011-mandatory-indexer-gate.md) | codebase-memory indexer is a mandatory harness prerequisite | Accepted | 2026-09-09 |
| [0012](../adrs/0012-opencode-sdk-default-backend.md) | opencode SDK is the default agent backend | Accepted | 2026-09-10 |
| [0013](../adrs/0013-context-rule-chaining.md) | Chain cumulative context across additive passes | Accepted | 2026-09-12 |

> [!IMPORTANT]
> All ADR bodies are fully drafted (Context / Decision / Consequences). Every ADR describes the current shipped codebase — there are no superseded, deprecated, or tombstone stubs (see [STYLE_GUIDE §7.1](../../STYLE_GUIDE.md#71-revision-deletion--numbering)).

---

## 2. How ADRs Are Maintained

ADRs are **living, current-state documents**; the numbered files in `docs/architecture/adrs/` are the single source of truth. Agents query them as ordinary markdown via `search_code`, `search_graph`, or `read` — the codebase-memory `manage_adr` blob is a separate project-memory store, not the ADR system.

- **Creation:** copy `docs/templates/adr-template.md` and assign the next number (`highest-ever + 1`; a deleted number is retired forever). Use a new number only for a decision unrelated to any existing ADR.
- **Revision:** when a decision changes, overwrite the existing ADR body in place — keep the file and its number — folding the reversal into its own *Alternatives considered* table. Never create a "superseding" ADR or a tombstone stub.
- **Deletion:** delete an ADR that no longer describes the shipped codebase, and update every inbound reference plus both index tables in the same change set (STYLE_GUIDE §7.1).
- **Keep the index in sync** with the ADR set in the same change set (STYLE_GUIDE §6.3).

---

## 3. Roadmap — Planned Work

> [!NOTE]
> These are **planned**, not shipped. Do not cite them as existing capability. Items without an owner/ADR/issue are candidates awaiting a decision. This page consolidates the retired `docs/roadmap.md`.

### 3.1 Verification & quality gates

- Semgrep (or equivalent) as a **hard-fail gate between passes** — see [7. Security Model §Planned](../user-overview/07-security-model.md)
- Unit-test maker/checker with **different models** (the generated tests themselves may be wrong and need independent review)
- Formal held-out benchmark / acceptance metric (no pass/fail threshold exists today)

### 3.2 Detailed, world-class TSDoc documentation for agentic-tdd itself

- **agentic-documentation**- We will use agentic-tdd to build a harness to generate indepth documentation for legacy/brownfiled code bases: https://github.com/Nistapp/agentic-tdd/discussions/37
- agentic-tdd will be the first project where we will test it i.e., use agentic-documentation to document agentic-tdd. Dogfooding our harnesses !! We hope to get this done by September 2026.

### 3.3 Guardrails & tooling

- **Security Orchestrator** pattern: Pass 6 delegates to specialist sub-agents (payload specialist, data sanitizer, frontend/backend context expert)
- **LiteLLM gateway beyond routing** — SSO identity, per-developer budgets (HTTP 402), prompt-side PII stripping. Today `infra/` is routing-only and `LITELLM_DISABLE_AUTH` defaults to `True` ([7. Security §2](../user-overview/07-security-model.md))
- DevContainer / Nix flake for deterministic agent sandboxing; improved security agent (zip bombs, size limits, per-framework rules)
- GitHub Action invocation from a ticket/issue; dry-run / dev-mode split

### 3.4 Orchestration & developer experience

- **Run individual passes / a deployable pass index** — aids agent reuse and independent orchestration patterns
- VS Code extension / cleaner HITL flow for reviewing `.mmd` + `.gherkin` during the Pass 0 gate
- Run a full pipeline against a real-world feature and publish results (validates the whole harness end-to-end)

---

## 4. Open Debates

| Topic | Question | Status / notes |
|---|---|---|
| **Security Orchestrator** | One massive Pass 6 prompt vs. an orchestrator that reads `design.mmd` and delegates to specialist sub-agents | Proposed in roadmap §3.3; preferred direction but undecided |
| **Temporal vs XState** | Keep XState, or adopt Temporal for complex workflows when sub-agents + maker/checker arrive | Under discussion; XState ships today ([ADR-0002](../adrs/0002-xstate-machines.md)) |
| **Maker/checker per pass** | Independent reviewer model per pass to catch generation errors and scope creep | Directional preference; model for it is open |
| **Per-pass restart** | Re-run a single failed pass via atomic-commit rollback | Feasible given [ADR-0003](../adrs/0003-atomic-commits-per-pass.md) but not exposed as a CLI flag yet |
| **Static Prefix value** | Whether provider prefix-cache ordering still helps now that each pass has its own LLM | Open question ([discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53)); deterministic `CONTEXT_RULES` ordering ships, but cache-hit engineering is not a design goal |

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| R-1 | ADR bodies | **Resolved** — all ADR bodies (0001–0013) are fully drafted; only minor open items remain in their per-ADR Placeholders tables. |
| R-2 | Manifesto salvage | The retired `architecture-manifesto.md` carried the enterprise vision (SSO, gateways, guardrails). Its shipped-vs-planned split now lives across the user-overview pages and this roadmap, but no single replacement "manifesto" page exists — decide whether to add one or keep it distributed. |

---

## Related

- [Architecture index & ADR list](../README.md) — canonical ADR index
- [8. Engineering Concepts — planned list](../user-overview/08-engineering-concepts.md#concepts-that-are-planned-not-shipped) — concept-level roadmap cross-check
- [7. Security Model & Sandboxing](../user-overview/07-security-model.md) — shipped vs. planned security controls
- [1. Why This Exists — FAQ](../user-overview/01-why-this-exists.md) — "why no TSDocs / larger goal" (P-4, resolved via §3.2)
- [STYLE_GUIDE §7 — ADR lifecycle](../../STYLE_GUIDE.md#7-architectural-decision-record-adr-lifecycle)