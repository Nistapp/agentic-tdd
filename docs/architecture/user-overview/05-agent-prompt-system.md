# 5. Agent Prompt System & Routing

> **Target Audience:** Users — CTOs, Team Leads, and Architects evaluating agentic-tdd.
> **Key Goal:** Explain how the 8 passes are *driven* — the Markdown agent files that define each sub-agent, the scope guardrails that keep them from trampling each other, and the model-routing strategy — so evaluators can judge safety, customisation, and cost.
> **Status:** Draft — wiki page 5 of the User Overview. Grounded in `src/agents/pass-*.md` and `src/infrastructure/open-code-agent-runner.ts`; deep prompt-engineering detail is in the Contributor Track.

---

## Executive Summary

The pipeline does not ask one model to "write the feature." Instead, each of the 8 passes is run by a **specialised sub-agent whose entire personality is a single Markdown file**. That file is *both*:

1. **Declarative configuration** (YAML frontmatter) — which model runs the pass, and which tools the agent may touch.
2. **The instruction set** (the body) — the agent's role, rules, scope, and output contract, written in strict XML sections so a code comment can never be mistaken for a command (the primary **prompt-injection defence**).

Two properties make this safe enough for enterprise use:

- **Scope guardrails** — every agent is locked to a narrow tool set (`read`/`edit`/`glob`/`grep` only; no `bash`, no network, no sub-agents). A pass physically cannot undo another pass's verified work (**Agent Trampling** prevention).
- **Static, inspectable routing** — each agent pins its own model in the file's frontmatter. Routing is a YAML line you can read, diff, and override — not a hidden runtime algorithm.

> [!TIP]
> The one-line takeaway: **agents are powerful but scoped.** They can read and edit files, but they cannot run arbitrary commands, reach the network, or spawn sub-agents — and each one knows exactly what it is allowed to produce. See the [Engineering Concepts map](08-engineering-concepts.md) for the full vocabulary.

---

## 1. How Agents Are Defined

Each pass maps to one file in [`src/agents/`](../../../src/agents/): `pass-0-design-agent.md` through `pass-7-documentation-agent.md`. The mapping is a constant table, [`AGENT_NAMES`](../../../src/core/types.ts#L26-L35) in `src/core/types.ts`:

| Pass | Agent file |
|---|---|
| 0 Design | `pass-0-design-agent.md` |
| 1 Contracts | `pass-1-contracts-agent.md` |
| 2 Test Generation | `pass-2-test-generation-agent.md` |
| 3 Core Implementation | `pass-3-core-implementation-agent.md` |
| 4 Refactor | `pass-4-refactor-agent.md` |
| 5 Observability | `pass-5-observability-agent.md` |
| 6 Security Hardening | `pass-6-security-agent.md` |
| 7 Documentation | `pass-7-documentation-agent.md` |

At runtime, [`OpenCodeAgentRunner`](../../../src/infrastructure/open-code-agent-runner.ts#L11-L38) reads that table, spawns the [opencode](https://opencode.ai) CLI with `--agent <name>`, attaches the pass's artefacts via `--file` (the Mermaid design, Gherkin spec, and — on self-correction cycles — the failing test log), and hands over the payload prompt ([`#buildArgs`](../../../src/infrastructure/open-code-agent-runner.ts#L42-L69)).

```mermaid
flowchart LR
    subgraph Engine["Core Engine (src/core/)"]
        SM["XState machine<br/>pass N"]
    end
    subgraph Infra["Infrastructure (src/infrastructure/)"]
        R["OpenCodeAgentRunner<br/>--agent pass-N<br/>--file <artefacts>"]
    end
    subgraph Harness["Coding Harness"]
        OC["opencode sub-agent"]
    end
    subgraph Provider["LLM Provider"]
        LLM["Model from frontmatter"]
    end

    SM -->|"invoke pass N"| R
    AF["src/agents/pass-N-*.md"] -->|"agent def + model + permissions"| OC
    R -->|"spawn + prompt payload"| OC
    OC -->|"scoped context"| LLM
    OC -->|"file edits"| FS["Workspace"]
```

> [!NOTE] Harness independence
> The engine reaches the agent only through the `IAgentRunner` / `IOpencodeSpawner` ports ([2. High-Level Architecture §3 — B.5](02-high-level-architecture.md#3-key-architectural-decisions)). Swapping opencode for another CLI agent is an adapter change, not a prompt change — the agent files stay the same. See [1. Why This Exists § 2.6](01-why-this-exists.md#26-harness-independence).

### 1.1 File anatomy — configuration + instruction set

Every agent file has the same skeleton. The two parts are *structurally different on purpose*:

| Part | Contents | Role |
|---|---|---|
| **YAML frontmatter** (`---`) | `description`, `mode`, `model`, `permission` | Routing + tool scope — read by the runner |
| `<agent_persona>` | Role, pass number, phase | Identity |
| `<context_philosophy>` | Reframes the injected payload as a *starting point*; mandates `indexer-first` | Context discipline |
| `<directives>` | Numbered `<rule id=…>` requirements (`assess-first`, `no-test-edit`, …) | The rules |
| `<scope>` | Allowed / forbidden operations | Guardrail (declared intent) |
| `<output_spec>` | Exact expected output shape (Passes 0, 1) | Output contract |
| `<security_checklist>` (Pass 6) | OWASP Top-10 checks | Security checklist |
| `<task>` | End-to-end instruction referencing the payload | The task |

The instruction body is written in **strict XML tags** (`` `<directives>` ``, `` `<task>` ``), not Markdown headers. This is the project's primary **prompt-injection defence**: instructions and payload are *semantically walled off*, so a `#` comment in a source file can never be interpreted as a command. Full anatomy: [9. Prompt Engineering — File Anatomy](../contributor-deep-dive/09-prompt-engineering.md#1-file-anatomy).

---

## 2. Scope Guardrails — the Anti-Trampling Lock

Every shipped agent shares the **same tool-permission profile** in its frontmatter (e.g. [`pass-3-core-implementation-agent.md#L12-L19`](../../../src/agents/pass-3-core-implementation-agent.md#L12-L19)):

| Tool | Setting | What it means |
|---|---|---|
| `read` / `edit` / `glob` / `grep` | **allow** | The agent can read and modify files, and search the project |
| `bash` | **deny** | No arbitrary command execution |
| `webfetch` | **deny** | No network access |
| `task` | **deny** | No delegation / no sub-agents |

Combined with the per-pass write intent declared in `<scope>` (e.g. Pass 2 may write *test files only*, Pass 7 *comments/docstrings only*), this is what prevents **Agent Trampling** — one pass silently undoing another pass's verified work. The guardrail is enforced at the tool level, not by asking politely: an agent that cannot run `bash` cannot `git reset`, and an agent denied `edit` on test files cannot "fix" a failing test to make it pass.

> [!NOTE]
> `permission` blocks in the agent files deny the dangerous tools *by declaration*, and opencode's own permission system enforces them per-session. The deny-list approach — explicit `deny` rather than a silent default-allow — is the safety-critical part. See [7. Security Model & Sandboxing](07-security-model.md) and the [glossary's *Agent Trampling* entry](../glossary.md).

The **separation-of-concerns rules** in each file's `<directives>` reinforce the scope boundary per pass:

| Pass | Key constraint |
|---|---|
| 0 Design | Output only `design.mmd` + `spec.gherkin`; no code |
| 1 Contracts | Stubs only; contracts at top of file; no business logic |
| 2 Tests | Test files only; **never** edit source |
| 3 Core | Make tests pass; Mermaid diagram is the binding contract; no logging/docs |
| 4 Refactor | Behaviour-preserving; no API change |
| 5 Observability | Additive only; structured logs; no `print` |
| 6 Security | OWASP checklist; business logic unchanged |
| 7 Docs | Comments/docstrings only; `@see` links to the design artefact |

Two directives recur in every file and are worth knowing about:

- **`assess-first` (the SKIP protocol)** — each agent first checks whether its pass is already satisfied, and if so emits exactly `SKIP:N:reason` and makes **no changes** ([`src/core/skip-parser.ts`](../../../src/core/skip-parser.ts)). This makes passes idempotent no-ops and saves tokens.
- **`indexer-first`** — the agent MUST prefer the `codebase-memory-mcp` knowledge graph over `read`/`glob`/`grep`, and verify the index is current before relying on it. Agents reason from *structure* (call chains, coupling) rather than text pattern-matching — the key guardrail against hallucinating non-existent APIs or duplicating existing utilities (see [1. § 2.4](01-why-this-exists.md#24-reducing-the-non-determinism-of-genai)).

---

## 3. Routing Strategy

Routing is **static and declarative**: each pass pins its model in the `model:` field of its agent file's frontmatter. There is no hidden runtime router — the `model:` line is read back out of the file at pre-flight time and logged ([`#logPreFlight`](../../../src/infrastructure/open-code-agent-runner.ts#L71-L91)).

### 3.1 Shipped defaults (source of truth)

| Pass | Agent file | Shipped `model:` |
|---|---|---|
| 0 Design | `pass-0-design-agent.md#L8` | `deepseek/deepseek-v4-pro` |
| 1 Contracts | `pass-1-contracts-agent.md#L12` | `deepseek/deepseek-v4-pro` |
| 2 Test Generation | `pass-2-test-generation-agent.md#L9` | `deepseek/deepseek-v4-pro` |
| 3 Core Implementation | `pass-3-core-implementation-agent.md#L10` | `deepseek/deepseek-v4-pro` |
| 4 Refactor | `pass-4-refactor-agent.md#L10` | `deepseek/deepseek-v4-pro` |
| 5 Observability | `pass-5-observability-agent.md#L10` | `deepseek/deepseek-v4-pro` |
| 6 Security Hardening | `pass-6-security-agent.md#L10` | `deepseek/deepseek-v4-pro` |
| 7 Documentation | `pass-7-documentation-agent.md#L11` | `deepseek/deepseek-v4-flash` |

The split is deliberate: the *heavy reasoning* passes (design, contracts, tests, implementation, refactor, observability, security) run a strong reasoning model, while Pass 7 — documentation — runs the lighter, cheaper `flash` tier, which is ample for docstrings and `@see` links.

### 3.2 Overriding the routing

Routing lives in the agent files precisely so it is **user-editable without a rebuild of the engine's logic**. To change a pass's model, edit the `model:` line in the corresponding `src/agents/pass-*.md` and re-run `npm run build` (which copies the prompts to `dist/agents/`).

> [!NOTE] Config-file routing is planned
> Editing agent files directly is a developer-desk workflow. A user-facing **config file** for runtime behaviour (e.g. per-agent models) is the planned next step — tracked in [discussion #52](https://github.com/Nistapp/agentic-tdd/discussions/52). This is the project's config-driven-evolution direction (see [16. ADRs & Roadmap](../contributor-deep-dive/16-adrs-roadmap.md)).

> [!NOTE] Aspirational vs shipped
> The widely-cited "Sonnet for design, DeepSeek for logic, Flash for docs, GPT-4.5 for security" routing is **aspirational**, not what ships. The `model:` fields in the table above are the source of truth (see P-2 on [page 1](01-why-this-exists.md)). We have tested with GLM, DeepSeek, and Gemini; the shipped files currently pin DeepSeek.

---

## 4. What This Means for Evaluators

| Question | Answer |
|---|---|
| **Can an agent go rogue?** | No `bash`, no network, no sub-agents — its only power is scoped file edits (see [7. Security Model](07-security-model.md)). |
| **Can a pass break another pass's work?** | Scope guardrails + separation-of-concerns rules make **Agent Trampling** structurally impossible, not just discouraged. |
| **Can I use different models?** | Yes — routing is a YAML line per pass. No code changes; edit the file, rebuild. |
| **Are the prompts locked to Nistapp?** | The shipped agent files encode Nistapp's internal workflow, but they are plain Markdown designed to be modified for your own conventions, prompts, and models — and the routing is config-driven in the making ([discussion #52](https://github.com/Nistapp/agentic-tdd/discussions/52)). |
| **Is it locked to one vendor?** | No — harness-independent by design (§ 1); model-agnostic via frontmatter. |
| **How much do the prompts cost to maintain?** | They are plain Markdown; `indexer-first` + `assess-first`/SKIP actively avoid wasted tokens (see [6. Context Engineering & Token Savings](06-context-and-token-savings.md)). |

---

## Deep Dive (Contributor Track)

The implementation of everything above lives in the Contributor Track:

| Topic | Where |
|---|---|
| Full file anatomy, the directive catalogue (`assess-first`, `indexer-first`, `target-symbols-priority`, `use-file-changes`), and the permission matrix | [9. Prompt Engineering — Agent Files & Guardrails](../contributor-deep-dive/09-prompt-engineering.md) |
| How the runner spawns opencode, attaches artefacts, and persists logs | [11. Infrastructure Adapters](../contributor-deep-dive/11-infrastructure-adapters.md) · [`open-code-agent-runner.ts`](../../../src/infrastructure/open-code-agent-runner.ts) |
| How SKIP / retries are orchestrated by the machines | [8. Core Engine Internals §6 — Skip Signals](../contributor-deep-dive/08-core-engine-internals.md#6-skip-signals) |
| Adding / modifying a pass end-to-end | [9. Prompt Engineering §5](../contributor-deep-dive/09-prompt-engineering.md#5-adding--modifying-a-pass) · [15. Developer Guide](../contributor-deep-dive/15-developer-guide.md) |

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| R-1 | Config-file routing | `model:` is hardcoded in agent files today; a user-facing config file is planned ([discussion #52](https://github.com/Nistapp/agentic-tdd/discussions/52)). Re-check when shipped. |
| R-2 | Model routing truth | Re-confirm exact current `model:` per pass when agent files change — the table in § 3.1 is a snapshot. |
| R-3 | Security-pass orchestration | A dedicated security orchestrator / swarm of security sub-agents is an open idea ([discussion #28](https://github.com/Nistapp/agentic-tdd/discussions/28)) — planned, not shipped. |

---

## Related Pages

- Previous: [4. The Core Engine](04-core-engine.md)
- Next: [6. Context Engineering — Code Indexing & Token Savings](06-context-and-token-savings.md)
- Deep dives: [9. Prompt Engineering](../contributor-deep-dive/09-prompt-engineering.md) · [10. Context Engineering](../contributor-deep-dive/10-context-engineering.md)
- Related: [3. The 8-Pass Pipeline](03-8-pass-pipeline.md) · [8. Engineering Concepts](08-engineering-concepts.md) · [Glossary](../glossary.md)
