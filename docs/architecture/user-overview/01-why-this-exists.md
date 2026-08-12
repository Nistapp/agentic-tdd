# 1. Why This Exists — Problem & Philosophy

> **Target Audience:** Users — CTOs, Team Leads, and Architects evaluating agentic-tdd.
> **Key Goal:** Explain the problems that motivated agentic-tdd and the design philosophy that governs every architectural decision, so users can judge whether the trade-offs fit their organisation.
> **Status:** Draft — wiki page 1 of the User Track. See [wiki-structure.md](../../../artefacts/documentation-prep/wiki/wiki-structure.md).

---

## Executive Summary

`agentic-tdd` is an **8-pass agentic TDD pipeline** for enterprise software development. It stops asking an AI model to "write code" in one shot, and instead **orchestrates AI to build software** as a deterministic, assembly-line process: Design → Contracts → Tests → Implementation → Refactor → Observability → Security → Documentation, each pass run by a specialised, scope-locked sub-agent and each producing an **atomic git commit**.

The core belief: **genAI is not yet production-grade.** Left unsupervised, AI-generated code accumulates small errors into large ones, drifts away from the architecture, and becomes a legacy codebase on day one. `agentic-tdd` is an attempt to **engineer away that non-determinism** using classic reliability-engineering techniques — formal specs, deterministic verification, frequent drift correction, and human checkpoints — rather than hoping models get better.

> [!NOTE]
> This document is the *philosophy* page of the User Track. For the mechanical "what happens when" details, see [The 8-Pass Pipeline](03-8-pass-pipeline.md). For the concrete system layout, see [High-Level Architecture](02-high-level-architecture.md).

---

## 1. The Problem

### 1.1 Context Bloat

Dumping entire codebases into a single agent window burns millions of tokens and causes "lost in the middle" attention drift: the model literally forgets constraints it was given at the top of a long prompt. The result is high cost *and* low accuracy.

### 1.2 Spaghetti Edits (Attention Degradation)

Asking one model to simultaneously write core logic, enforce security, handle error paths, and format logging produces **attention degradation** — the model will "lazy code" at least one constraint. A generalist agent trying to secure and implement at the same time performs measurably worse than a security specialist reviewing a pre-written file. ([architecture-manifesto.md §1.1](../../architecture-manifesto.md))

### 1.3 Specification Drift

The agentic model changes the code, but the architectural documentation and requirements are left untouched — creating **spec drift** and a legacy codebase on day one. In traditional development the docs lag the code; in agentic coding the *architecture itself* silently diverges unless the pipeline enforces a sync.

### 1.4 FOMO-Driven Tool Sprawl

Teams adopt the latest agentic tool without an engineering harness around it. There are many celebrated `AGENTS.md` files, but they govern the **agents**, not the **engineering around the agents** — context construction, verification gates, rollback, budget, and observability. This unstructured approach fails at enterprise scale.

### 1.5 The Underlying Belief: genAI Is Not Production-Grade

It is not an exaggeration to say it is dangerous to let genAI loose on your code. Public, well-documented failure modes include hallucinated APIs, duplicate utilities, overwritten business logic, and unverifiable "it works on my machine" claims. These are not bugs to be waited out; they are the default behaviour to be engineered around.

> [!NOTE] Source
> Problem framing adapted from [README.md#the-problem](../../../README.md), [architecture-manifesto.md §1](../../architecture-manifesto.md), and [wiki-structure.md §1](../../../artefacts/documentation-prep/wiki/wiki-structure.md).

---

## 2. The Design Philosophy

The philosophy is deliberately built from **classic, time-tested reliability engineering and CS concepts** — not from hype. Six principles follow.

### 2.1 Deterministic Verification of Non-Deterministic Generation

There is no magic bullet for deterministic output. Small errors accumulate along a chain to produce large errors — the engineering answer is to **negate drift after every pass**, "zeroing" errors before the next pass begins.

The two-pronged approach:

1. **Formal, unambiguous specs** via Gherkin and diagrams.
   - Gherkin (Given/When/Then) is strictly better than plain-English requirements for machine-readability.
   - Diagrams convey intent and boundaries far more efficiently than prose.
   - Mermaid was chosen **purely for Markdown compatibility**; future versions may adopt PlantUML for more expressiveness.
2. **Deterministic verification** — TDD.

**TDD is the key philosophical pillar**: a deterministic test suite verifies an agent's non-deterministic generation. Tests are:

- **Deterministic** — they eliminate drift after every pass by encoding expected behaviour as executable constraints.
- **Token-free** — verification leverages effectively-free local compute; we do **not** use genAI to verify genAI, which removes both ambiguity and cost.

The pipeline therefore mandates **formal specs paired with frequent, iterative, exhaustive tests** (SDD/BDD + TDD), rather than choosing between them.

### 2.2 Artifact-Driven Development

In an AI-native pipeline, **the artifacts are the source of truth and the code is a byproduct.** Two artifacts drive everything:

- `.mmd` (Mermaid diagrams) — the architectural constraint.
- `.gherkin` (BDD specs) — the executable requirements.

No agent is allowed to write core logic until a Mermaid diagram and a Gherkin specification have been generated, updated, **and approved by a human** ([ADR-0004 — HITL Gate after Pass 0](../adrs/0004-hitl-gate-after-pass-0.md)). Forcing the AI to map a state machine *first* enforces an architectural chain-of-thought, and the diagram becomes the strict mathematical constraint the code must satisfy.

> **The Digital Twin:** treating diagrams and specs as version-controlled, executable code creates a *digital twin* of the software. `@see` links let a developer trace any AI-generated method back to the exact state transition that dictated it — spec drift becomes impossible because the spec and code are locked in a feedback loop.

### 2.3 Zero Specification Drift

Architectural diagrams and Gherkin specs are version-controlled, executable code. The pipeline enforces a mandatory **artifact sync rule**: agents MUST update `.mmd`/`.gherkin` and gain human approval before touching core logic, and the final Documentation pass verifies specs still match the final code. See [architecture-manifesto.md §1.3](../../architecture-manifesto.md).

### 2.4 Reducing the Non-Determinism of genAI

Deterministic verification is necessary but not sufficient. `agentic-tdd` layers several guardrails and optimisations that each provide a non-trivial improvement and, *together* with unit tests, yield deterministic software output that:

- adheres to existing code conventions,
- does not over-write existing code,
- minimises blast radius / prevents unintended impact,
- uses existing functionality instead of duplicating it,
- does not hallucinate non-existent code.

The mechanisms (each detailed on its own wiki page):

| Mechanism | Wiki Page | Summary |
|---|---|---|
| Code indexing (`codebase-memory-mcp`) | [2. High-Level Architecture](02-high-level-architecture.md) | Semantic/AST index so agents get the right context and stop hallucinating existing APIs. |
| Controlled context building | [6. Token Economy & Cost Control](06-token-economy.md) | Static Prefix ordering + Context Compaction keep context minimal and cacheable. |
| Agent guardrails | [5. Agent Prompt System & Routing](05-agent-prompt-system.md) | Scope-locked agents; file-glob permissions prevent Agent Trampling. |
| Multi-pass with self-correction | [3. The 8-Pass Pipeline](03-8-pass-pipeline.md) | Narrow per-pass scope; failing tests feed the error back for up to 2 retries. |

### 2.5 Harness Independence

The harness is built **independent of any particular coding harness**. Agents are not embedded inside opencode; instead any CLI agent (ClaudeCode, agy, `pi`, etc.) can be integrated.

- No dependency on the direction of any single harness vendor.
- `pi` looks the most lightweight and is the probable default harness in future versions (planned).

> [!NOTE] Planned
> Harness-independence is a design principle; the default harness today is [opencode](https://opencode.ai) (see [ADR/index](../README.md)). Support for additional harnesses is future work — see the placeholder in [14. ADRs & Roadmap](../contributor-deep-dive/14-adrs-roadmap.md).

### 2.6 Build on Standard, Time-Tested Libraries

Rather than reinvent infrastructure, the project builds on mature, battle-tested components: TypeScript/Node.js, XState (state machines), Vitest (tests), execa (process execution), pino (logging), and `@ast-grep/napi` (AST parsing). This maximises robustness and minimises the "own-surface" the project must maintain — see [Misc-stuff §B](../../../artefacts/documentation-prep/wiki/Misc-stuff-to-include-in-wiki.md).

---

## 3. The Solution at a Glance: AI as an Assembly Line

The philosophical principles are embodied in one pattern: **AI as an assembly line**. Instead of a single zero-shot prompt, development is broken into a strict sequential pipeline of eight specialised sub-agents:

```
Pass 0  Design & Architecture  →  design.mmd + spec.gherkin   [HITL gate]
Pass 1  Contracts & Types      →  type stubs in source files
Pass 2  TDD Test Generation    →  test file                   [Red phase]
Pass 3  Core Implementation    →  logic                       [Green phase]
Pass 4  Refactor & Optimise    →  complexity / DRY
Pass 5  Observability & Logs   →  error classes + logging
Pass 6  Security Hardening     →  OWASP + sanitisation
Pass 7  Documentation          →  docstrings + @see links + spec sync
```

Each pass's output is the **next pass's read-only context**, and each guarded pass runs the local test suite with self-correction before advancing. Every pass commits atomically, so rollback is a deterministic `git revert` of exactly one step ([ADR-0003 — Atomic Commits per Pass](../adrs/0003-atomic-commits-per-pass.md)).

> [!NOTE] Full state-machine diagram
> See the pipeline state diagram in [The 8-Pass Pipeline](03-8-pass-pipeline.md) or [README.md#architecture-at-a-glance](../../../README.md).

---

## 4. What This Is (and Is Not)

| agentic-tdd **is** | agentic-tdd **is not** |
|---|---|
| An orchestrator / state machine that drives scoped sub-agents | A code indexer (that role is delegated to `codebase-memory-mcp`) |
| A TDD-enforcing pipeline with deterministic verification gates | A general-purpose autocomplete or pair-programming tool |
| A harness that *delegates* to a CLI agent | A replacement for a coding harness (opencode, etc.) |
| An artifact-first workflow (`.mmd`/`.gherkin` as source of truth) | A "generate-everything-in-one-prompt" tool |

> [!NOTE] Planned / Aspirational (do not assume available)
> The enterprise manifesto also describes LiteLLM SSO/budget gateways, Semgrep hard-fail gates, Bloop cross-repo indexing, and DevContainer sandboxing. Where these exist in `infra/` or the roadmap — and where they are only planned — is flagged explicitly on the relevant pages. **Treat anything not explicitly implemented in `src/` or `infra/` as a placeholder.**

---

## 5. Placeholders & Open Questions

Topics that surfaced during drafting. Most are now resolved; those still open are marked `OPEN` and must be completed before this page is published:

| # | Topic | Status / resolution | Where it will live |
|---|---|---|---|
| P-1 | **Token-cost savings benchmarks** | Not yet benchmarked for *this* framework. Independent studies claim ~10× reduction in token consumption for code-graph-based exploration vs. file-by-file: the [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp) and the paper [*Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP*](https://arxiv.org/abs/2603.27277) (31 real repos, 10× fewer tokens, 2.1× fewer tool calls). Treat as external evidence, not a claim about agentic-tdd. | [6. Token Economy](06-token-economy.md) |
| P-2 | **Model routing strategy** | Routing is **static** in the shipped `src/agents/pass-*.md` files (`deepseek-v4-pro`, docs → `deepseek-v4-flash`). Users can override per-pass models by editing those agent files. A **config file** for easy user configuration is planned for a future version. | [5. Agent Prompt System](05-agent-prompt-system.md) |
| P-3 | **Repo/URL canonicalisation** | There is **no** `agentic-tdd-node` repo. The canonical home is `github.com/Nistapp/agentic-tdd`; community discussions live at [`Nistapp/agentic-tdd/discussions`](https://github.com/Nistapp/agentic-tdd/discussions). `package.json`'s `repository` field is stale and should be corrected. | Wiki footer / Home |
| P-4 | **FAQ (why no TSDocs? larger goal?)** | **OPEN** — preserved as placeholder; expand later in [14. ADRs & Roadmap](../contributor-deep-dive/14-adrs-roadmap.md). | [14. ADRs & Roadmap](../contributor-deep-dive/14-adrs-roadmap.md) |
| P-5 | **Nistapp-internal provenance** | Leave as-is — already covered by [§ 6. Is This For You?](#6-is-this-for-you). No further action. | — |
| P-6 | **License** | The project is **AGPL-3.0** (as in `LICENSE` and the README badge). `package.json`'s `ISC` field is a metadata inconsistency to fix; it does not change the license. | Wiki footer / this page |

---

## 6. Is This For You?

- `agentic-tdd` targets **enterprise teams** that already invest in tests and want a disciplined, auditable, per-commit agentic workflow — not solo experimenters looking for a chat-based code generator.
- It is **extensible by design**: the workflow, agent definitions, and prompts are Nistapp-internal today, but are intended to be modified for your internal workflows, and to evolve for frontend/backend/middleware nuances (see [Misc-stuff §F](../../../artefacts/documentation-prep/wiki/Misc-stuff-to-include-in-wiki.md)).
- It **presupposes a test suite**: the pipeline's verification gates are meaningless without a runnable test command (`--test-cmd`).

> [!IMPORTANT]
> This is a draft. Open item **P-4** (FAQ) must be resolved or marked "unknown / out of scope" before promotion to `docs/`.

---

## Related Pages

- Previous: [Home](../../../artefacts/documentation-prep/wiki/wiki-structure.md)
- Next: [2. High-Level Architecture](02-high-level-architecture.md)
- Deep-dives: [Architecture Manifesto](../../architecture-manifesto.md) · [Glossary](../glossary.md) · [ADR Index](../README.md)
