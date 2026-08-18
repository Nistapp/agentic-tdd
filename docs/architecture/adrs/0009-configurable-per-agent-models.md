# 0009. Configurable Per-Agent Models via `config.json`

* **Status:** Accepted
* **Date:** 2026-08-17
* **Deciders:** @kcramakrishna

---

## Context

Each of the 8 pipeline passes is driven by an opencode sub-agent whose definition is a single Markdown file (`src/agents/pass-*.md`). The model for each pass was pinned **only** in the file's YAML frontmatter (`model:`), which `OpenCodeAgentRunner` never read back to opencode — it relied on opencode honouring the frontmatter itself. That made per-pass model choice:

- **a developer-desk edit** — users had to hand-edit `src/agents/pass-*.md` and re-run `npm run build`, which is not a runtime configuration surface;
- **hard to audit** — the effective model per pass lived in 8 separate files, not one inspectable place;
- **a source of drift** — the docs' recommendation (pro for passes 0–2, flash for 3–7, see `03-8-pass-pipeline.md`) disagreed with the shipped frontmatter (pro for 0–6, flash only for 7).

The project's config-driven-evolution direction was already flagged (discussion #52); this ADR ships it.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **Config file (JSONC) + native `--model`** | **Chosen** — one sectioned, extensible file (`config.json`) merged over a committed template; opencode's own `run --model` applies it, so no file rewriting or templating of agent prompts. |
| **Environment variables (`AGENTIC_TDD_MODEL_<PASS>`)** | Rejected — the project deliberately keeps `process.env` reads out of the engine and a file is more discoverable/diffable. |
| **`opencode.json` / machine-local agent model config** | Rejected — that is opencode's own gitignored, per-machine config, separate from the pipeline's config surface. |
| **Build-time templating of the `.md` frontmatter** | Rejected — would rewrite agent definitions and require a rebuild on every change; contradicts "runtime" configurability. |

---

## Decision

Model choice per agent is resolved at **runtime** from a standard, sectioned `config.json`, and applied by passing opencode's native `--model <provider/model>` flag.

### File layout

- **`config.default.json`** (repo root, committed) — the bundled template and fallback; copied to `dist/config.default.json` by `copy:agents`.
- **`.agentic-tdd/config.json`** (git-ignored) — the user override file. Users are told to copy the template here (`cp config.default.json .agentic-tdd/config.json`) and edit it. `.agentic-tdd/` already holds runtime state/logs and is not version-controlled, so overrides stay local.
- The file is **JSONC** (comments allowed) — a small string-aware `stripJsonComments` helper in `src/cli/model-config.ts` strips comments before `JSON.parse`. No new runtime dependency.
- Sectioned for forward evolution: the current section is **`agents.models`** (per-agent model map). Unknown top-level sections are ignored so future settings (prompts, tools, budgets…) can be added without breaking older versions.

### Schema

```jsonc
{
  "agents": {
    "models": {
      "pass-0-design-agent": "openrouter/deepseek/deepseek-v4-pro",
      // ... all 8 agents, keyed by their AGENT_NAMES value
    }
  }
}
```

Keys are the **full agent/pass names with pass number** — the `AGENT_NAMES` values from `src/core/types.ts` (`PipelinePass` enum + `AGENT_NAMES` map, the single source of truth for the 8 passes). Unknown keys and malformed `provider/model` strings fail fast at startup.

### Precedence (highest first)

1. `--model <provider/model>` — per-run global override for every agent
2. `--config <path>` — explicit alternate config file
3. `.agentic-tdd/config.json` — git-ignored user override (merged per-agent-key over the default)
4. `config.default.json` — bundled committed template
5. agent-file frontmatter `model:` — final fallback (when no `--model` is passed)

### Implementation seams

- `resolveModelConfig` / `defaultModelConfigPath` / `stripJsonComments` in `src/cli/model-config.ts` — pure module, filesystem injected via `IFileSystem`.
- `PipelineConfig` (`src/core/interfaces.ts`) gains optional `models?: Partial<Record<string, string>>`; the runner appends `--model` in `#buildArgs` and logs the effective model + source in `#logPreFlight`.
- No changes to the core state machine or `PipelineContext`; config is assembled in the CLI layer and injected via DI (`ContainerOptions.modelConfig` → `buildPipelineConfig`).

### Shipped defaults (aligned with docs recommendation)

Passes 0–2 (`pass-0-design-agent` … `pass-2-test-generation-agent`) → `openrouter/deepseek/deepseek-v4-pro`; passes 3–7 (implementation … documentation) → `openrouter/deepseek/deepseek-v4-flash`. The agent-file frontmatter fallbacks were aligned to the same values.

---

## Consequences

### Positive

* **Runtime configurability without a rebuild** — `cp config.default.json .agentic-tdd/config.json`, edit, done.
* **One inspectable surface** — all 8 per-agent models in one sectioned file with a pointer to the defining source (`src/core/types.ts`).
* **Per-run override** — `--model` / `--config` flags for CI and one-off experiments.
* **Forward-extensible** — the `agents` section and unknown-top-level-section tolerance anticipate future config settings.
* **Zero new runtime dependencies** — hand-rolled comment stripper; native opencode `--model`.
* **Docs ↔ config agreement** — the shipped default now matches the documented recommendation (pro 0–2, flash 3–7), removing the drift between `03-8-pass-pipeline.md` and the frontmatter.

### Negative / Trade-offs

* **Two sources for a model** (config file + frontmatter fallback) — mitigated by an explicit precedence order and `modelSource` in pre-flight logs.
* **JSONC comments are non-standard JSON** — tolerated only because a string-aware stripper is unit-tested; strict-JSON consumers must strip first.
* **Behavior change vs. today when no config is present** — passes 3–6 move from `pro` to `flash` (config default overrides frontmatter fallback). Intended, per the confirmed docs-recommended split.
* **`dist/` vs source resolution** — the bundled default path is resolved via `import.meta.url` candidates; both modes are covered by tests.

---

## Related

* [5. Agent Prompt System — Routing Strategy § 3](../user-overview/05-agent-prompt-system.md#3-routing-strategy) · [3. The 8-Pass Pipeline — Pass Reference Table](../user-overview/03-8-pass-pipeline.md)
* [`src/cli/model-config.ts`](../../../src/cli/model-config.ts) · [`config.default.json`](../../../config.default.json) · [`src/core/types.ts`](../../../src/core/types.ts)
* [ADR-0001 Pure Core Engine](./0001-pure-core-engine.md) (config stays in the CLI/DI layer) · [ADR-0006 Static Prefix](./0006-context-control-optimisation.md) (P-3 now shipped)

---

> **Update (2026-08-18):** the shipped default provider changed from `deepseek/…` to `openrouter/deepseek/…` (`config.default.json`, agent-file frontmatter fallbacks, and docs aligned). The decision record above — runtime, config-driven model routing via `config.json` with `--model`/`--config` precedence — is unchanged.
