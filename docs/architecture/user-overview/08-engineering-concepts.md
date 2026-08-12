# 8. Engineering Concepts — What agentic-tdd Implements

> **Target Audience:** Users and contributors who want a shared vocabulary for *how* agentic-tdd works.
> **Status:** DRAFT — every concept is grounded in implemented code (source of truth), not aspirational plans.
> **Prev:** [7. Security Model & Sandboxing](07-security-model.md) · **Next:** [Contributor Track](../contributor-deep-dive/08-core-engine-internals.md)

---

## Purpose

"Agentic TDD" is a crowded space full of buzzwords. This page is a **concept → implementation** map: each term, what it means here, which file implements it, and where the full explanation lives. It is deliberately terse; follow the links for depth.

> [!NOTE] What this page is not
> It is not a marketing pitch. Terms that appear in the enterprise manifesto but are **not yet shipped** are marked `planned` and excluded from the "implements" claim.

---

## The Map

| Concept | What it means here | Implementation | Deep dive |
|---|---|---|---|
| **AI as an assembly line** | Development decomposed into 8 sequential, scope-locked passes instead of one zero-shot prompt | `createPipelineMachine` — `src/core/machines/pipeline.machine.ts` | [3. The 8-Pass Pipeline](03-8-pass-pipeline.md) · [8. Core Engine Internals](../contributor-deep-dive/08-core-engine-internals.md) |
| **Deterministic verification of non-deterministic generation** | Agent output is gated by a deterministic test suite (TDD), not by another model | `createSelfCorrectionMachine` — `src/core/machines/self-correction.machine.ts` | [8. Core Engine Internals §2](../contributor-deep-dive/08-core-engine-internals.md#2-the-self-correction-machine) |
| **Drift correction** | Errors are "zeroed" after every pass so they don't accumulate down the chain | Per-pass commit + test gate | [1. Why This Exists §2.1](01-why-this-exists.md#21-deterministic-verification-of-non-deterministic-generation) |
| **Artifact-driven development** | `.mmd` (Mermaid) + `.gherkin` are the source of truth; code is the byproduct | Pass 0 `runPass0`; `designMmd`/`specGherkin` paths | [1. Why This Exists §2.2](01-why-this-exists.md#22-artifact-driven-development) |
| **Digital twin / traceability** | Code links back to its design via `@see` + `@see`/`SEC:` anchors | Pass 7 `see-link` rule; `targetSymbols`/`fileChanges` anchors | [9. Prompt Engineering §3.5](../contributor-deep-dive/09-prompt-engineering.md#35-separation-of-concerns-rules-per-pass) |
| **Red-Green-Refactor** | Tests written first (red), implementation makes them green, then refactor | Passes 2 → 3 → 4 | [3. The 8-Pass Pipeline](03-8-pass-pipeline.md) |
| **HITL gates** | Human approval of design artefacts (Pass 0) and tests (Pass 2) | `HITL_REQUIRED` event; `src/cli/hitl-handler.ts` | [8. Core Engine Internals §1.2](../contributor-deep-dive/08-core-engine-internals.md#12-states--actors) · [ADR-0004](../adrs/0004-hitl-gate-after-pass-0.md) |
| **Self-correction loop** | Guarded passes retry (up to 3) with the failing test log fed back | `createSelfCorrectionMachine` | [8. Core Engine Internals §2](../contributor-deep-dive/08-core-engine-internals.md#2-the-self-correction-machine) |
| **Atomic commits & deterministic rollback** | One commit per pass; `git revert` a single step; `--abort` rewinds via `originalBaseSha` | `doAtomicCommit`; `abortToSha` | [ADR-0003](../adrs/0003-atomic-commits-per-pass.md) |
| **Skip signals** | Agents declare a pass a no-op with `SKIP:N:reason` | `parseSkipSignal` — `src/core/skip-parser.ts` | [8. Core Engine Internals §6](../contributor-deep-dive/08-core-engine-internals.md#6-skip-signals) |
| **Static Prefix** | Stable files (contracts/specs) ordered first for KV-cache hits | `CONTEXT_RULES` ordering | [10. Context Engineering §4](../contributor-deep-dive/10-context-engineering.md#4-static-prefix-adr-0006) · [ADR-0006](../adrs/0006-context-control-optimisation.md) |
| **Context Compaction** | Per-pass error logs deleted on success | `cleanupAfterSuccess` | [10. Context Engineering §5](../contributor-deep-dive/10-context-engineering.md#5-context-compaction-adr-0005) · [ADR-0005](../adrs/0005-context-compaction.md) |
| **Context enrichment** | Git-diff hunks mapped to AST symbols + drift-resistant anchors | `AstGrepSymbolResolver`; `extractAnchor` | [10. Context Engineering §6](../contributor-deep-dive/10-context-engineering.md#6-context-enrichment--anchored-change-descriptors) · [ADR-0007](../adrs/0007-ast-grep-symbol-resolver.md) |
| **Prompt-injection defence** | XML semantic walls separate instructions from payload | `<directives>` / `<task>` XML sections | [9. Prompt Engineering §1](../contributor-deep-dive/09-prompt-engineering.md#1-file-anatomy) |
| **Scope guardrails / anti-Trampling** | Tool deny-lists + per-pass write scope prevent one pass undoing another | YAML `permission` block | [9. Prompt Engineering §2.2](../contributor-deep-dive/09-prompt-engineering.md#22-permission-matrix) |
| **Harness independence** | Agents not embedded in a specific harness; opencode today, others later | `IAgentRunner` / `IOpencodeSpawner` ports | [1. Why This Exists §2.6](01-why-this-exists.md#26-harness-independence) |
| **Model routing** | Per-pass model via agent-file frontmatter (static, user-overridable) | `model:` in `src/agents/pass-*.md` | [9. Prompt Engineering §2.1](../contributor-deep-dive/09-prompt-engineering.md#21-model-routing) |
| **Event-bus pub/sub** | Decoupled UI/telemetry via typed events | `IEventBus`; event catalogue | [8. Core Engine Internals §1.3](../contributor-deep-dive/08-core-engine-internals.md#13-events) |
| **Structured logging + sanitisation** | pino child loggers; control chars stripped, strings truncated | `log-sanitizer.ts`; `pino-logger.ts` | [13. Observability & Operations](../contributor-deep-dive/13-observability-operations.md) |
| **Session persistence / snapshot resume** | XState snapshot persisted; `--resume` replays it | `stateStore`; `actor.getPersistedSnapshot()` | [8. Core Engine Internals §5](../contributor-deep-dive/08-core-engine-internals.md#5-pause--resume) |

---

## Concepts that are *planned*, not shipped

These appear in the enterprise manifesto but are **not implemented in `src/`/`infra/`** — treat as roadmap, not capability:

- Semgrep hard-fail gates between passes
- LiteLLM SSO / budget enforcement (402) — `infra/` config exists, verify status
- Bloop cross-repo semantic indexing
- DevContainer / Nix deterministic sandboxing
- Config-file model routing
- True spec parity (see [1. Why This Exists §2.3](01-why-this-exists.md#23-minimising-specification-drift))

---

## Related

- [Glossary](../glossary.md) — canonical term definitions
- Contributor deep dives: [8. Harness Engineering](../contributor-deep-dive/08-core-engine-internals.md) · [9. Prompt Engineering](../contributor-deep-dive/09-prompt-engineering.md) · [10. Context Engineering](../contributor-deep-dive/10-context-engineering.md)
- [16. ADRs & Roadmap](../contributor-deep-dive/16-adrs-roadmap.md)
