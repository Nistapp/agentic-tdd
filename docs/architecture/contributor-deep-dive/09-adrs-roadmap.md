# 9. ADRs & Roadmap

> **Target Audience:** Contributors and evaluators interested in the project's trajectory.
> **Status:** Published — ADR index grounded in `docs/architecture/adrs/`; roadmap consolidated from the retired `docs/roadmap.md`.
> **Prev:** [8. Developer Guide](08-developer-guide.md)

---

## Overview

This page is the single destination for two kinds of project memory:

1. **Architecture Decision Records (ADRs)** — the immutable decision log, numbered sequentially in `docs/architecture/adrs/`. Statuses are mirrored in the [architecture index](../README.md).
2. **Roadmap** — the consolidated backlog for the *shipped* framework, formerly kept in `docs/roadmap.md` (retired during the documentation restructure). Anything below marked `planned` is **aspirational**, not shipped — see [8. Engineering Concepts §Planned](../user-overview/08-engineering-concepts.md#concepts-that-are-planned-not-shipped).

---

## 1. ADR Index & Status

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](../adrs/0001-pure-core-engine.md) | Pure Core Engine — no infrastructure imports in `src/core/` | Accepted | 2026-06-01 |
| [0002](../adrs/0002-xstate-machines.md) | XState machines over ad-hoc loops | Accepted | 2026-08-01 |
| [0003](../adrs/0003-atomic-commits-per-pass.md) | Atomic git commits per pass (not squashed) | Accepted | 2026-06-01 |
| [0004](../adrs/0004-hitl-gate-after-pass-0.md) | HITL gate after Pass 0 only | Accepted | 2026-06-01 |
| [0005](../adrs/0005-context-compaction.md) | Context Compaction — delete error logs on pass success | Accepted | 2026-07-01 |
| [0006](../adrs/0006-context-control-optimisation.md) | Static Prefix ordering for prompt cache hits | **Deprecated** ([discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53)) | 2026-07-01 |
| [0007](../adrs/0007-ast-grep-symbol-resolver.md) | `@ast-grep/napi` for in-process symbol resolution | Accepted | 2026-08-08 |
| [0008](../adrs/0008-observability-before-security.md) | Swap pass order — Observability (5) before Security (6) | Accepted | 2026-08-01 |

> [!IMPORTANT]
> All ADR bodies are fully drafted (Context / Decision / Consequences). Deprecation note: **0006** (Static Prefix) is tombstoned in place with its deprecation notice (per STYLE_GUIDE §7.1 — never delete, only supersede).

---

## 2. How ADRs Are Maintained

- **Creation:** copy `docs/templates/adr-template.md`, assign the next sequence number, add a row to [the index](../README.md), and record the decision with `codebase-memory` `manage_adr`.
- **Supersession / tombstoning:** sequence numbers are permanent. When a decision is reversed, the old ADR is **not deleted** — it becomes a tombstone stub pointing at the replacement and `git log --follow` (STYLE_GUIDE §7.1).
- **Acceptance status** lives in the ADR frontmatter; keep the index rows in sync in the same change set (STYLE_GUIDE §6.3).

---

## 3. Roadmap — Planned Work

> [!NOTE]
> These are **planned**, not shipped. Do not cite them as existing capability. Items without an owner/ADR/issue are candidates awaiting a decision. This page supersedes the retired `docs/roadmap.md`.

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
| **Static Prefix value** | Whether prefix-cache ordering still helps now that each pass has its own LLM | Deprecated pending research ([discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53)) |

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| R-1 | ADR bodies | **Resolved** — all ADR bodies (0001–0008) are fully drafted; only minor open items remain in their per-ADR Placeholders tables. |
| R-2 | Manifesto salvage | The retired `architecture-manifesto.md` carried the enterprise vision (SSO, gateways, guardrails). Its shipped-vs-planned split now lives across the user-overview pages and this roadmap, but no single replacement "manifesto" page exists — decide whether to add one or keep it distributed. |
| R-3 | Deprecation log | Onboarding a lightweight "deprecated / retired docs" index so removed files (e.g. `roadmap.md`, `architecture-manifesto.md`) keep navigable tombstones. |

---

## Related

- [Architecture index & ADR list](../README.md) — canonical ADR status table
- [8. Engineering Concepts — planned list](../user-overview/08-engineering-concepts.md#concepts-that-are-planned-not-shipped) — concept-level roadmap cross-check
- [7. Security Model & Sandboxing](../user-overview/07-security-model.md) — shipped vs. planned security controls
- [1. Why This Exists — FAQ](../user-overview/01-why-this-exists.md) — "why no TSDocs / larger goal" (P-4, resolved via §3.2)
- [STYLE_GUIDE §7 — ADR lifecycle](../../STYLE_GUIDE.md#7-architectural-decision-record-adr-lifecycle)