# 2. Prompt Engineering — Agent Files & Guardrails

> **Target Audience:** Contributors designing or modifying pass prompts.
> **Status:** Published — grounded in `src/agents/pass-*.md`.
> **Prev:** [1. Core Engine Internals](01-core-engine-internals.md) · **Next:** [3. Context Engineering](03-context-engineering.md)

---

## Overview

Each of the 8 passes is defined by a **Markdown agent file** in `src/agents/pass-{0..7}-*.md`. The file is a **declarative contract** for model routing and tool permissions plus the instruction set the agent executes. The runner is **agent-agnostic** ([ADR-0010](../adrs/0010-agent-agnostic-sdk-architecture.md)): the **Pi backend** (`PiSdkRunner`, default) reads the file with Pi's `parseFrontmatter` — `model` feeds model resolution and `permission` is mapped onto a hard `tools` allowlist; the **opencode-cli backend** (`OpenCodeCliRunner`, legacy) reads the frontmatter for pre-flight logging and relies on opencode honouring the `permission:` block.

> [!IMPORTANT]
> Prompt files are copied verbatim to `dist/agents/` by `npm run build`. After editing any `src/agents/*.md`, rebuild so the shipped prompts match.

---

## 1. File Anatomy

Every agent file has the same skeleton:

| Section | Purpose |
|---|---|
| `---` YAML frontmatter | `description`, `mode`, `model`, `permission` — routing + tool scope |
| `<agent_persona>` | Declared role, pass number, phase |
| `<context_philosophy>` | Reframes the injected JSON payload as a **starting point**, not the whole picture; mandates `indexer-first` |
| `<directives>` | Numbered `<rule id=…>` requirements |
| `<scope>` | Allowed / forbidden operations |
| `<output_spec>` (0, 1) | Exact expected output shape |
| `<security_checklist>` (6) | OWASP Top-10 checks for the security pass |
| `<task>` | End-to-end instruction referencing the JSON payload fields |

### Why XML sections, not Markdown headers

Strict XML tags create **semantic walls**: everything inside `<directives>` is pipeline instruction; file contents are payloads, never commands. This is the primary **prompt-injection defence** — the model cannot confuse a code comment for an instruction because the instruction language is structurally distinct.

---

## 2. YAML Frontmatter — Routing & Permissions

```yaml
mode: all
model: openrouter/deepseek/deepseek-v4-pro
permission:
  read: allow
  edit: allow
  glob: allow
  grep: allow
  bash: deny
  webfetch: deny
  task: deny
```

### 2.1 Model routing

| Pass | Agent file | Shipped `model:` |
|---|---|---|
| 0 | `pass-0-design-agent.md` | `openrouter/deepseek/deepseek-v4-pro` |
| 1 | `pass-1-contracts-agent.md` | `openrouter/deepseek/deepseek-v4-pro` |
| 2 | `pass-2-test-generation-agent.md` | `openrouter/deepseek/deepseek-v4-pro` |
| 3 | `pass-3-core-implementation-agent.md` | `openrouter/deepseek/deepseek-v4-flash` |
| 4 | `pass-4-refactor-agent.md` | `openrouter/deepseek/deepseek-v4-flash` |
| 5 | `pass-5-observability-agent.md` | `openrouter/deepseek/deepseek-v4-flash` |
| 6 | `pass-6-security-agent.md` | `openrouter/deepseek/deepseek-v4-flash` |
| 7 | `pass-7-documentation-agent.md` | `openrouter/deepseek/deepseek-v4-flash` |

> [!NOTE] Config-driven routing
> The table above is the agent-file fallback. The **effective** model is resolved at runtime from `config.default.json` (committed) merged with `.agentic-tdd/config.json` (git-ignored user override). The Pi backend appends a per-pass thinking level and resolves via `resolveCliModel` ([ADR-0010 §5](../adrs/0010-agent-agnostic-sdk-architecture.md)); the opencode-cli backend passes the model as `--model`; `--model`/`--config` CLI flags override per-run. See [`resolveModelConfig`](../../../src/cli/model-config.ts) and [ADR-0009](../adrs/0009-configurable-per-agent-models.md).

### 2.2 Permission matrix

All shipped agents share the same tool scope:

| Tool | Setting | Rationale |
|---|---|---|
| `read` / `edit` / `glob` / `grep` | allow | Core file operations |
| `bash` | deny | No arbitrary command execution |
| `webfetch` | deny | No network |
| `task` | deny | No delegation / sub-agents |

This is the **scope guardrail** that prevents **Agent Trampling** — an agent physically cannot write to files outside its pass's declared write set because `bash` and `task` are unavailable. Enforcement is **backend-dependent**: the Pi backend maps the block onto a hard `tools` allowlist (shell tools simply absent), while the opencode-cli backend bounds `edit` via opencode's own permission system.

---

## 3. The Directive Catalogue (cross-pass patterns)

### 3.1 `assess-first` — the SKIP protocol

Every pass opens with `assess-first` ([src/core/skip-parser.ts](../../../src/core/skip-parser.ts)):

> Before making any file changes, assess the existing codebase against your pass mandate. If the existing code already fully satisfies the requirements, output exactly: `SKIP:{pass_number}:{reason}` … Do NOT use exploration tools to invent new out-of-scope work if the primary mandate is met.

This makes passes **idempotent no-ops** when work isn't needed, saving tokens and avoiding churn. The machine detects `SKIP:` and records `status: 'skipped'` (see [1. Core Engine Internals §6](01-core-engine-internals.md#6-skip-signals)).

### 3.2 `indexer-first` and the reuse directives

> The harness provisions and verifies the codebase indexer for this run; the payload's `meta.indexer` field reports its status (`available`, `indexed`, `project`). Rely on that field — do NOT probe your environment for MCP tools. Use the indexer tools (`search_graph`, `search_code`, `get_code_snippet`, `trace_path`, `get_architecture`) as your primary discovery mechanism before reading files directly.

The knowledge graph (`codebase-memory-mcp`) outranks read/grep so agents reason from **structure** (call chains, imports, coupling) rather than pattern-matching text — reducing hallucination and duplicate utilities. Because the indexer gate is mandatory ([ADR-0011](../adrs/0011-mandatory-indexer-gate.md)), the rule no longer hedges with a `read`/`glob`/`grep` fallback: `meta.indexer` is authoritative and always available on a successful run. Present in all 8 files.

Each pass additionally carries a **reuse directive** — `reuse-first` (P0), `reuse-contracts` (P1), `reuse-test-helpers` (P2), `prefer-existing-utilities` + `no-duplicate-local-helpers` (P3), the global `dry` check + `canonical-patterns` (P4), `reuse-observability-patterns` (P5), `reuse-security-utils` (P6), `reuse-doc-patterns` (P7) — plus a single **batched discovery step** at pass start. Discovery is skipped when `meta.attemptNumber > 1` (the error log is then the focus and prior results are already in context), keeping indexer round-trips to one batch per pass — consistent with the token-cost invariant.

### 3.3 `target-symbols-priority` — strong-advisory scoping

Passes 3–6 receive a `targetSymbols` map (which functions upstream passes changed). The rule is **advisory, not a hard ban**:

> You MUST prioritize your edits to the functions listed in this map. You may edit outside this map ONLY if it is critical to completing the pass mandate. If you make out-of-scope changes, add an inline comment: `// OUT-OF-SCOPE: {pass}-agent — {reason}`.

This reconciles tight scoping with the `indexer-first` exploration mandate — see [3. Context Engineering §7](03-context-engineering.md#7-how-agents-consume-it) for the analysis that led here.

### 3.4 `use-file-changes` — drift-resistant navigation

Passes 3–6 are told to navigate via the `fileChanges` change descriptors (per-hunk ranges, enclosing symbol names, anchor snippets, commit SHA) and to treat absolute line numbers as best-effort hints that drift across passes. Anchor on the **enclosing symbol + snippet**, and use `git show <sha>:<file>` for the exact state.

### 3.5 Separation-of-concerns rules (per-pass)

| Pass | Key constraints |
|---|---|
| 0 Design | Output only `design.mmd` + `spec.gherkin`; no code; Gherkin ≥ 3 scenarios; `DESIGN-NOTE:` on blockers |
| 1 Contracts | Stubs only (`NotImplementedError`); contracts at TOP of file; no business logic; no test/artefact edits |
| 2 Tests | Tests only; **never** edit source; map each test to a Gherkin Scenario; `append-not-overwrite` |
| 3 Core | Make tests pass; Mermaid diagram is the **binding architectural constraint**; honour Pass-1 contracts; no logging/docs; `IMPL-NOTE:` on diagram discrepancies |
| 4 Refactor | Behaviour-preserving; no API change; apply PEP8/Prettier; `flag-deep-changes` |
| 5 Observability | **Additive only**; structured logs (`logger.info`…); no `print`; custom exception classes; no hot-loop logs |
| 6 Security | OWASP `security_checklist`; business logic must not change; `SEC: {check_id} — reason` per change; `SECURITY-NOTE:` for non-security flaws |
| 7 Docs | Comments/docstrings only; every public function gets `@see` link to the design artefact (digital twin); `describe-not-fix` |

### 3.6 `no-*` invariants shared broadly

- `no-test-edit` (all passes) — the test suite is the correctness contract; never change tests to fit code.
- `no-artefact-edit` (1, 2) — Mermaid/Gherkin are immutable once HITL-approved.
- `no-logging` (3) / `no-docs` (3) — ownership deferred to later passes.

---

## 4. Output Contracts

- **Pass 0 `<output_spec>`**: exactly two files — Mermaid (annotated state/sequence/flow) and Gherkin (Feature + ≥ 3 Scenarios with concrete values). Validated by `runPass0` (content length ≥ 30).
- **Pass 1 `<output_spec>`**: a delimited `# ── Contracts (pass-1-contracts-agent) ──` block at the top of each source file.
- **Pass 6 `<security_checklist>`**: named checks `A01…A10` with explicit actions (e.g. "use parameterised queries — never f-string SQL construction").

---

## 5. Adding / Modifying a Pass

1. Copy the nearest existing agent file as a template.
2. Set `model` (routing) and `permission` (scope).
3. Write `<directives>` with `assess-first` + `indexer-first` + the pass's reuse directive + any `no-*` invariants, and add the batched discovery step to `<task>`.
4. Add the pass to the pipeline machine (`pass_N_*` state), `SELF_CORRECTION_PASSES` / `GIT_COMMIT_PASSES` in `src/core/types.ts`, and `CONTEXT_RULES` in `src/core/context-builder.ts`.
5. Rebuild: `npm run build`.

See [8. Developer Guide](08-developer-guide.md) for the end-to-end recipe.

---

## Related

- [5. Agent Prompt System & Routing (User view)](../user-overview/05-agent-prompt-system.md)
- [3. Context Engineering](03-context-engineering.md) — why context is advisory, not restrictive
- [1. Core Engine Internals](01-core-engine-internals.md) — how SKIP / retries are orchestrated
