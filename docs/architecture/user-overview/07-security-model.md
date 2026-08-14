# 7. Security Model & Sandboxing

> **Target Audience:** Users — CTOs, Security Leads, and Architects.
> **Key Goal:** Give evaluators an honest picture of what agentic-tdd protects today (basic hygiene), what it plans to protect (enterprise controls), and the threat model it is designed around.
> **Status:** Draft — wiki page 7 of the User Overview. Grounded in `src/infrastructure/git-service.ts`, `src/agents/pass-6-security-agent.md`, `src/core/log-sanitizer.ts`, and `src/infrastructure/open-code-agent-runner.ts`. This is the most aspirational page in the wiki; every planned item carries an explicit banner and nothing planned is described as shipped.

> [!IMPORTANT] Read this banner first
> **Most of what a security-conscious evaluator will ask for — Semgrep hard-fail gates, DevContainer/Nix sandboxing, gateway-level PII/DLP masking, per-pass write-locks — is planned, not shipped.** We intend to close these gaps within this year, but today the shipped surface is deliberately minimal: *basic git hygiene, tool-level agent permissions, prompt-injection walling, log sanitization, and an OWASP-focused security-hardening agent pass.* See [§ 3](#3-planned-controls-the-honest-roadmap) for the roadmap.

---

## 1. The Threat Model — What "Security" Means Here

agentic-tdd is **not** a server-side SaaS that holds customer data. It is a CLI harness that runs **locally on the developer's machine, against a codebase the developer presumably trusts** (their own, or their org's). That changes the security question: the primary risk is not an external attacker — it is *what the AI agent can see, change, and execute while working on that machine*.

We are still researching the full security posture for this "trusted-local" context. What follows is the current understanding:

| Asset | Threat | Shipped control | Planned |
|---|---|---|---|
| **Repository source** (code, tests, specs) | Agent overwrites verified work from an earlier pass ("Agent Trampling") | Tool `deny`-lists + per-pass `<scope>` rules + git branch isolation | Per-pass file-glob write-locks |
| **Agent tool execution** | Agent runs arbitrary shell commands, exfiltrates data, or spawns sub-agents | `bash`, `webfetch`, `task` denied in every agent file | DevContainer/Nix sandbox |
| **Secrets & API keys** | Leak into logs, prompts, or committed code | `.env` gitignored; opencode denies `.env` reads by default; log sanitizer truncates; Pass 6 `no-secrets` rule | Gateway DLP/PII masking |
| **Prompt injection** (from files in the repo) | Hostile content in a source file steers the agent into malicious action | XML-walling of instructions vs. payload | — (hardening under research) |
| **Generated code quality** | Shipped feature ships with OWASP-class flaws (injection, auth bypass) | Pass 6 security-hardening agent + self-correction loop | Semgrep hard-fail gates |
| **LLM-bound data** | Data leaves the developer's machine to a third-party provider | — (agent files declare no network tools) | LiteLLM gateway: SSO, budgets, DLP |

> [!NOTE] Philosophy that drives this
> Our working assumption is that unconstrained genAI is **not yet production-grade** — it is dangerous to let it loose on a codebase without guardrails (see [1. § 1.5](01-why-this-exists.md#15-the-underlying-belief-genai-is-not-production-grade)). The controls below are the harness's answer to that: *scope it, isolate it, verify it deterministically, and keep its blast radius small.*

---

## 2. Shipped Controls — Basic Hygiene Today

### 2.1 Git isolation: one feature branch per run

Every run starts by creating (or checking out) a **feature branch** derived from the issue ref, with several hard refusal conditions ([`git-service.ts#L220-L269`](../../../src/infrastructure/git-service.ts#L220-L269)):

| Guard | Behaviour |
|---|---|
| Dirty working tree | Refuses to start — returns `abort_dirty` |
| Branching from `main`/`master` | Refuses unless an explicit `--base-branch` override is given — returns `abort_main` |
| Branch already exists | Human-in-the-loop prompt before checking it out (unless `--skip-hitl`) |
| Branch name | Sanitised from the issue ref before any `git checkout -b` |

The baseline SHA is recorded (`originalBaseSha`) and `--abort` rewinds the tree to it ([`session.ts#L46-L49`](../../../src/cli/session.ts#L46-L49)). Combined with **atomic git commits per pass** — each pass is a revertible commit, so rollback is `git revert` ([3. The 8-Pass Pipeline § 4](03-8-pass-pipeline.md#4-one-atomic-commit-per-pass--rollback-pause-resume-abort)) — this is the harness's core safety net: *every AI-generated change is isolated on its own branch and individually reversible.*

> [!NOTE] Honest limit
> This is hygiene, not a sandbox. It constrains *where* writes land and *how they are rolled back*; it does not constrain *what* an agent could write to files on that branch.

### 2.2 Agent tool sandbox: deny the dangerous tools by declaration

Every one of the 8 pass agents ships the **same tool-permission profile** in its YAML frontmatter ([`pass-6-security-agent.md#L12-L19`](../../../src/agents/pass-6-security-agent.md#L12-L19), identical across `src/agents/pass-*.md`):

| Tool | Setting | Effect |
|---|---|---|
| `read` / `edit` / `glob` / `grep` | **allow** | File access and project search |
| `bash` | **deny** | No arbitrary command execution (an agent that cannot run `bash` cannot `git reset`) |
| `webfetch` | **deny** | No network access |
| `task` | **deny** | No delegation / no sub-agents |

Each file's `<scope>` block reinforces this in natural language — e.g. Pass 6 may read/edit implementation files but must not modify tests, design artefacts, or function signatures. Together these form the **anti-Trampling lock** (see the [glossary's *Agent Trampling* entry](../glossary.md) and [5. § 2](05-agent-prompt-system.md#2-scope-guardrails--the-anti-trampling-lock)).

> [!WARNING] Enforcement relies on the declared scope
> The runner invokes opencode in non-interactive mode and passes `--dangerously-skip-permissions` ([`open-code-agent-runner.ts#L67`](../../../src/infrastructure/open-code-agent-runner.ts#L67)), so there is **no per-call approval prompt** — enforcement rests on the agent file's declared `permission:` scope, not on a human clicking "approve". We must verify against the pinned opencode version that `deny` rules are still honoured when that flag is present (see [S-4](#placeholders--open-questions)).

### 2.3 Prompt-injection walling

Instructions and payload are *semantically separated*: the instruction body uses strict XML tags (`<directives>`, `<task>`) rather than Markdown headers, so a `#` comment in a source file can never be parsed as a command ([5. § 1](05-agent-prompt-system.md#1-how-agents-are-defined)). This is the project's primary defence against hostile repo content steering an agent.

### 2.4 Log sanitizer

Before any agent *prompt* is written to the event log, it passes through [`sanitizeLogPayload`](../../../src/core/log-sanitizer.ts#L25-L28) ([`log-sanitizer.ts#L1-L28`](../../../src/core/log-sanitizer.ts#L1-L28)):

| Transformation | Details |
|---|---|
| C0 control-character strip | Removes `\x00–\x08`, `\x0B`, `\x0C`, `\x0E–\x1F` |
| Length truncation | Strings longer than 400 chars are cut and annotated `[Truncated: N characters total]` at `info` level (full content kept only at `debug`/`trace`) |
| Recursion | Applied through nested arrays and plain objects |

It is wired into the pass launch and self-correction paths ([`pipeline.machine.ts#L771`](../../../src/core/machines/pipeline.machine.ts#L771), [`self-correction.machine.ts#L368`](../../../src/core/machines/self-correction.machine.ts#L368)). Separately, the runner logs only *whether* an API key is set (`apiKeySet: boolean`), never the key itself ([`open-code-agent-runner.ts#L86-L90`](../../../src/infrastructure/open-code-agent-runner.ts#L86-L90)).

> [!CAUTION] What the sanitizer is **not**
> It is a **log-blast-radius limiter**, not a DLP engine. It does not detect PII or secret *patterns* and does not redact by key name — a token-shaped string inside a 200-char log line would pass through intact. This is an accepted gap until gateway-level DLP ships ([S-8](#placeholders--open-questions)).

### 2.5 Pass 6 — the security-hardening agent (the in-pipeline security layer)

The pipeline's last guarded pass is a dedicated **Security Hardening agent** ([`pass-6-security-agent.md`](../../../src/agents/pass-6-security-agent.md)):

- Runs a **red-team analysis against an OWASP Top-10 checklist** (A01–A10: access control, crypto failures, injection, insecure design, misconfiguration, integrity failures, logging/monitoring failures, SSRF) ([`pass-6-security-agent.md#L100-L153`](../../../src/agents/pass-6-security-agent.md#L100-L153)).
- Hard directives: `no-secrets` (no hardcoded credentials/tokens), `fail-fast` (validate at the function boundary), `no-swallow` (no silent exception swallowing), `no-logic-change` (business logic must not change).
- Tags every hardening change with an auditable `# SEC: {check} — {reason}` comment, and flags suspected non-security bugs with `# SECURITY-NOTE:` for human review.
- Runs **after Pass 5 Observability** ([ADR-0008](../adrs/0008-observability-before-security.md)) so it can review the log statements Pass 5 wrote and **mask PII at the code level** — rewiring `logger.error(...)` calls that leak raw values. This is in-pipeline PII handling and is distinct from (and complementary to) gateway-level DLP.

It is a *guarded* pass: its output must pass the deterministic test gate or the self-correction loop feeds failures back (see [3. The 8-Pass Pipeline](03-8-pass-pipeline.md)).

---

## 3. Planned Controls — the Roadmap

Each of these is referenced in [`docs/roadmap.md`](../../../roadmap.md) and the [architecture manifesto](../../../architecture-manifesto.md). **None is implemented today.**

### 3.1 Hard-fail static-analysis gates (Semgrep)

> [!NOTE] Planned — see roadmap · [architecture manifesto § 4.3](../../../architecture-manifesto.md)
> Semgrep (or similar) would run as a deterministic **hard-fail gate between guarded passes**: if the implementation pass ships a hardcoded secret or an injection flaw, the gate intercepts it and feeds the error trace back to the agent for self-correction — before any human sees the code. Today the equivalent review is done *by the Pass 6 agent* (a model), not by a deterministic tool.

### 3.2 Deterministic environments (DevContainer / Nix sandbox)

> [!NOTE] Planned — see roadmap · [architecture manifesto § 2.3](../../../architecture-manifesto.md)
> Today tests and passes run directly on the developer's machine. The plan is to bind agent execution to a **containerized environment** (DevContainer or Nix flake): reproducible builds, isolation of the host from rogue agent scripts, and elimination of the "wrong Node version → agent rewrites good code to fix a non-problem" failure mode.

### 3.3 Gateway security: SSO, budgets, and DLP/PII masking (LiteLLM)

> [!NOTE] Planned / aspirational — verified against `infra/`
> The `infra/` configs exist ([`docker-compose.yml`](../../../infra/docker-compose.yml), [`litellm_config.yaml`](../../../infra/litellm_config.yaml)) but are **routing-only today**: they multiplex to OpenRouter, and `LITELLM_DISABLE_AUTH` **defaults to `True`** — authentication is off unless an operator explicitly enables it. No SSO, no budget quotas, no DLP/PII-stripping middleware is configured. The full gateway story from [architecture manifesto § 2.1](../../../architecture-manifesto.md) — SSO identity, per-developer budgets (HTTP 402), and prompt-side PII stripping before data leaves the network — is **aspirational**.

### 3.4 Finer-grained sandboxing (the gap list)

> [!NOTE] Planned — see [architecture manifesto § 4.2](../../../architecture-manifesto.md)
> The manifesto's design goal is **per-phase write-locks** (e.g. "Pass 2 may only write `*.spec.ts`", "Pass 7 may only edit comments/docstrings"). Shipped today is the coarser *tool-level* deny profile; the file-glob write-locks are not yet enforced.

### 3.5 Specialist security agents & governance patterns

> [!NOTE] Planned — see roadmap & [discussion #28](https://github.com/Nistapp/agentic-tdd/discussions/28)
> The roadmap also targets: a **Security Orchestrator** that reads `design.mmd` and delegates to specialist sub-agents (payload specialist for zip-bombs/XXE, data sanitizer for injection, context expert for frontend-vs-backend threats); a strict **dependency-resolution hierarchy** (prefer existing patterns → existing libraries → framework natives → only then a new dependency); and a **maker-checker** pattern for critical artefacts such as specs and diagrams.

---

## 4. What This Means for Evaluators

| Question | Honest answer |
|---|---|
| **Is it safe to run against my repo?** | It runs locally against your code with basic hygiene shipped: isolated feature branch, per-pass atomic commits, and tool-level permissions that deny `bash`/`webfetch`/`task` to every agent. |
| **Can the agent execute arbitrary commands?** | Not by design — `bash` is denied in every agent file. But verify the flag interplay noted in [S-4](#placeholders--open-questions). |
| **Is my PII / secret data protected?** | Partially. `.env` is gitignored, opencode denies `.env` reads by default, logged prompts are control-char-stripped and truncated, and Pass 6 masks PII in log statements at code level. There is **no gateway-level DLP today** — that ships with the LiteLLM hardening (§ 3.3). |
| **Can an agent trample my code?** | The anti-Trampling lock (tool denies + `<scope>` rules + git isolation) is shipped; per-pass write-locks are planned (§ 3.4). |
| **Is generated code audited for OWASP flaws?** | Yes, by the Pass 6 agent with `# SEC:` annotations — a model-based review. A deterministic Semgrep hard-fail gate is planned (§ 3.1). |
| **What is the biggest gap?** | Environment isolation (sandboxing) and gateway-level data protection. Both are on the roadmap for this year. |

---

## Deep Dive (Contributor Track)

| Topic | Where |
|---|---|
| Permission matrix, agent file anatomy, directive catalogue | [9. Prompt Engineering — Agent Files & Guardrails](../contributor-deep-dive/09-prompt-engineering.md) |
| Log sanitizer & logging architecture | [13. Observability, Logging, & Operations](../contributor-deep-dive/13-observability-operations.md) (placeholder) |
| Runner invocation & `--dangerously-skip-permissions` | [12. CLI & DI Wiring](../contributor-deep-dive/12-cli-di-wiring.md) |
| Pass 6 prompt, checklist, directives | [`src/agents/pass-6-security-agent.md`](../../../src/agents/pass-6-security-agent.md) |
| Why Security runs after Observability | [ADR-0008](../adrs/0008-observability-before-security.md) |
| Git service guards & rollback | [`src/infrastructure/git-service.ts`](../../../src/infrastructure/git-service.ts) · [3. § 4](03-8-pass-pipeline.md#4-one-atomic-commit-per-pass--rollback-pause-resume-abort) |

> [!NOTE] Contributor-track gap
> There is no dedicated Contributor Deep Dive page for the security model yet; the observability/logging page ([13](../contributor-deep-dive/13-observability-operations.md)) is also still a placeholder. Once one is drafted, this section should link to it rather than to `src/` files directly.

---

## Placeholders / Open Questions

| # | Topic | Status / What is missing |
|---|---|---|
| S-1 | Current shipped surface | **Answered on this page** (§ 2): git branch isolation, tool-level permissions, prompt-injection walling, log sanitizer, Pass 6 agent. |
| S-2 | DLP / PII masking via LiteLLM | **Verified aspirational.** `infra/` configs are routing-only; `LITELLM_DISABLE_AUTH` defaults to `True`; no SSO/budget/DLP middleware configured. |
| S-3 | Log sanitizer coverage | **Answered** (§ 2.4): strips C0 control chars + truncates >400-char strings at `info`; no key- or pattern-based secret redaction. |
| S-4 | `--dangerously-skip-permissions` semantics | Verify against the pinned opencode version whether frontmatter `deny` rules are still enforced when the runner passes this flag ([`open-code-agent-runner.ts#L67`](../../../src/infrastructure/open-code-agent-runner.ts#L67)). |
| S-5 | `.env` default denial vs `read: allow` | Confirm opencode's built-in `*.env: deny` default still holds when an agent declares `read: allow` in its frontmatter. |
| S-6 | Threat model for trusted-local context | Research what "security" means when the harness runs locally on a trusted codebase (skeleton TODO). |
| S-7 | Per-pass file-glob write-locks | Planned design ([manifesto § 4.2](../../../architecture-manifesto.md)); not yet implemented — no agreed enforcement mechanism. |
| S-8 | PII detection in log sanitizer | Not implemented; decide whether to add key/pattern-based redaction ahead of gateway DLP. |

---

## Related Pages

- Previous: [6. Context Engineering — Code Indexing & Token Savings](06-context-and-token-savings.md)
- Next: [8. Engineering Concepts — Buzzword Map](08-engineering-concepts.md)
- Deep dives: [9. Prompt Engineering](../contributor-deep-dive/09-prompt-engineering.md) · [13. Observability, Logging, & Operations](../contributor-deep-dive/13-observability-operations.md)
- ADRs: [0008 Observability Before Security](../adrs/0008-observability-before-security.md)
- Related: [5. Agent Prompt System & Routing](05-agent-prompt-system.md) · [3. The 8-Pass Pipeline](03-8-pass-pipeline.md) · [1. Why This Exists](01-why-this-exists.md) · [glossary: *Agent Trampling* / *LiteLLM*](../glossary.md)
