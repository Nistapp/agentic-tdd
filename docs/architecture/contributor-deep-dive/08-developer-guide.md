# 8. Developer Guide

> **Target Audience:** Contributors setting up locally and extending the pipeline.
> **Status:** Published — grounded in `src/cli/*`, `src/infrastructure/*`, `package.json`, and `opencode.json`.
> **Prev:** [7. Testing Strategy & Mock Patterns](07-testing-strategy.md) · **Next:** [9. ADRs & Roadmap](09-adrs-roadmap.md)

---

## Overview

This guide covers how to stand up a working local environment, run and verify the build, and extend the pipeline — either by editing an existing pass's prompt or by adding a new DI port. It assumes you have read [5. CLI & Dependency Injection Wiring](05-cli-di-wiring.md) for the architecture and [7. Testing Strategy & Mock Patterns](07-testing-strategy.md) for how to verify changes.

> [!IMPORTANT]
> Two external tools are **hard prerequisites** — the pipeline cannot run without them and they are not bundled by `npm install`:
>
> 1. **opencode CLI** — every guarded pass spawns `opencode` as a subprocess ([`command-runner.ts#L56-L57`](../../../src/infrastructure/command-runner.ts#L56-L57)). If `opencode` is not on `PATH`, the pipeline fails at the first spawn.
> 2. **codebase-memory-mcp** — every pass agent's prompt mandates an `indexer-first` rule that calls `codebase-memory-mcp` MCP tools before falling back to `read`/`glob`/`grep` (e.g. [`pass-0-design-agent.md#L56-L63`](../../../src/agents/pass-0-design-agent.md#L56-L63), and identically in `pass-1`…`pass-7`). It must be registered in your local `opencode.json` (below).

---

## 1. Prerequisites

| Requirement | Version / Notes | Why it is required |
|---|---|---|
| **Node.js** | ≥ 22 (badge in `README.md`); `package.json` `engines` declares ≥ 18 | Runs the CLI and tests |
| **npm** | bundled with Node.js | Installation and scripts |
| **opencode CLI** | latest from <https://opencode.ai> | Spawned by `CommandRunner.spawn` for every pass |
| **codebase-memory-mcp** | `v0.8+` (binary referenced as `codebase-memory-mcp`) | The knowledge-graph indexer used by all pass agents |
| **API key** | `OPENROUTER_API_KEY` (or other provider config noted in `README.md`) | `index.ts` **hard-fails** at startup if unset ([#L89-L91](../../../src/cli/index.ts#L89-L91)) |
| **git** | initialized working directory | Feature branch creation + atomic commits per pass |

> [!WARNING]
> `opencode.json` is **gitignored** ([`.gitignore#L3`](../../../.gitignore#L3)) because it is machine-local (model names, external-directory allow-lists). It is part of the per-developer setup, not something `npm install` restores. New contributors must create it — see §3.

---

## 2. Local Setup (First Run)

```bash
git clone <repo-url> agentic-tdd
cd agentic-tdd

# 1. Install dependencies
npm install

# 2. Build the TypeScript sources + copy prompt agents to dist/agents
npm run build

# 3. (Optional) expose the CLI on PATH
npm link

# 4. Configure the API key — NEVER commit .env
cp .env.example .env
#   edit .env → OPENROUTER_API_KEY=sk-or-...
```

Then create the machine-local `opencode.json` (see §3) before running.

> [!CAUTION]
> `.env` is gitignored and holds your `OPENROUTER_API_KEY`. Per AGENTS.md §9, the orchestrator never prints `.env` contents; never log, echo, or paste the key into a transcript.

---

## 3. The Local `opencode.json`

Because it is gitignored, create it once per machine. At minimum it must register the MCP server so pass agents can honour the `indexer-first` rule:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "external_directory": { "/absolute/path/to/projects/**": "allow" }
  },
  "agent": {
    "plan":  { "model": "openrouter/<plan-model>" },
    "build": { "model": "openrouter/<build-model>" }
  },
  "mcp": {
    "codebase-memory": {
      "type": "local",
      "command": ["codebase-memory-mcp"],
      "enabled": true
    }
  }
}
```

The `agent.plan` / `agent.build` model routing is a **stack-level override**; each pass agent's YAML frontmatter in `src/agents/pass-*.md` still pins its own model (e.g. `pass-0-design-agent.md` frontmatter). Align them or be deliberate about which wins.

> [!TIP]
> After registering the MCP server, confirm the indexer is up with `codebase-memory` tools (`list_projects` / `index_status`). Pass agents call `detect_changes`/`index_status` and only fall back to `read/glob/grep` when no indexer is available — so a healthy index is what actually unlocks the fast path.

---

## 4. Project Layout (Where Things Live)

| Path | Purpose |
|---|---|
| `src/core/` | **Pure** state machine + DI ports. Zero `src/infrastructure/` or `src/cli/` imports. |
| `src/core/interfaces.ts` | All DI ports (`IGitService`, `IFileSystem`, `ILogger`, …) |
| `src/core/machines/` | XState machines (`pipeline.machine.ts`, `self-correction.machine.ts`) |
| `src/infrastructure/` | Concrete adapters: git, fs, command-runner, open-code-agent-runner, state-store, event-bus, pino-logger, ast-grep |
| `src/agents/pass-*.md` | Prompt files for agents 0–7 (copied to `dist/agents/` on build) |
| `src/cli/` | CLI entry (`index.ts`), `validators`, `session`, `di-container`, `terminal-renderer`, HITL handler |
| `src/utils/` | `logger`, `paths`, `git-sanitize` |
| `test/` | Vitest suite mirroring `src/` (see [7. Testing Strategy](07-testing-strategy.md)) |
| `infra/` | Optional LiteLLM proxy (`docker-compose.yml`, `litellm_config.yaml`) for enterprise routing |

---

## 5. Verification Workflow

| Command | What it does |
|---|---|
| `npm run lint` | `tsc --noEmit` — **strict** type-check. MUST pass with zero errors. |
| `npm test` | `vitest run` — full suite, 100% pass required (never `.skip` a failing test). |
| `npm run build` | `tsc` + `npm run copy:agents` (copies `src/agents/*` → `dist/agents/`). |
| `npm run test:watch` | Vitest watch mode during development. |

> [!IMPORTANT]
> After **any** edit to `src/agents/pass-*.md`, rerun `npm run build`. The pipeline loads agent prompts from `dist/agents/` (resolved via `PACKAGE_AGENTS_DIR` in [`command-runner.ts#L11-L12`](../../../src/infrastructure/command-runner.ts#L11-L12)), so the `copy:agents` step is what makes your prompt edits take effect. Do not edit `dist/` by hand — it is generated.

The full release gate is `npm run prepublishOnly` → `lint && test && build:full`.

---

## 6. Running a Session

```bash
agentic-tdd --feature-desc-file specs/my_feature.md --test-cmd "npm test" --log-level DEBUG
```

| Flag | Behaviour |
|---|---|
| `--feature-desc-file <path>` | **Required** markdown describing the feature (validated in [`validators.ts#L23-L46`](../../../src/cli/validators.ts#L23-L46)) |
| `--test-cmd <cmd>` | **Required** test command run after each guarded pass |
| `--skip-hitl` | Bypass both human gates (Pass 0 and Pass 2) |
| `--base-branch <branch>` | Base branch for the feature branch |
| `--log-level <level>` | `DEBUG | INFO | WARNING | ERROR` (default `INFO`) |
| `--resume` | Resume an active session from its persisted snapshot |
| `--abort` | Rewind git to the baseline SHA and delete the session |
| `--no-context-enrich` | Force files-only context (skip method-level enrichment) |

New sessions, resume, and abort flow through [`session.ts`](../../../src/cli/session.ts); `startNewSession` records the baseline SHA and hands control to `PipelineOrchestrator.run` ([`session.ts#L160-L250`](../../../src/cli/session.ts#L160-L250)). SIGINT once pauses after the current pass; twice force-exits ([`index.ts#L33-L60`](../../../src/cli/index.ts#L33-L60)).

> [!NOTE]
> If no `--feature-desc-file`/`--test-cmd` is given, `validators.ts` prints a boxed usage error and exits — this is the fastest way to confirm your CLI wiring works without invoking agents.

---

## 7. Extending the Pipeline

### 7.1 Modifying an existing pass prompt

The 8 pass agents live in `src/agents/pass-{0-7}-*.md`. Each has YAML frontmatter locking `model`, `permission`, and (implicitly) scope. When editing, follow [2. Prompt Engineering §5](02-prompt-engineering.md#5-adding--modifying-a-pass):

1. Edit the relevant `src/agents/pass-N-*.md`, preserving its YAML frontmatter and keeping scope narrow to that single pass.
2. Rerun `npm run build` to refresh `dist/agents/`.
3. Add/update tests as needed and run `npm run lint && npm test`.

### 7.2 Adding a new pass (or pass number)

1. Create the prompt `src/agents/pass-N-*.md`. Use an existing pass file as the copyable skeleton (G-2).
2. Update the pass enum in `src/core/types.ts` (`PipelinePass`, and `PASS_LABELS` for display).
3. Add the transition/entry points in `src/core/machines/pipeline.machine.ts` (and the self-correction machine if the pass is test-guarded).
4. Wire any context it needs in `src/core/context-builder.ts` `CONTEXT_RULES`.
5. Update the pass table in [3. The 8-Pass Pipeline](../user-overview/03-8-pass-pipeline.md) and [2. Prompt Engineering](02-prompt-engineering.md), then `npm run build` + verify.

### 7.3 Extending DI (new OS capability)

Any new OS-level operation follows the port → adapter → wiring recipe:

1. **Define the port** in `src/core/interfaces.ts` (e.g. an `IDispatcher`), documenting its contract — see existing ports at [`interfaces.ts#L19-L255`](../../../src/core/interfaces.ts#L19-L255).
2. **Implement the concrete adapter** in `src/infrastructure/` (git/fs/spawn/logger concerns only).
3. **Wire it** in `src/cli/di-container.ts` so `createPipelineServices` constructs and injects it, and thread it through the relevant machine input (follow how `contextProvider` is passed).
4. **Never** let `src/core/` reach into `src/infrastructure/` or `src/cli/` — that breaks the [ADR-0001](../adrs/0001-pure-core-engine.md) DI contract.
5. Add ≥1 positive + ≥1 negative test and run `npm run lint && npm test`.

Environ/config reads go through `PipelineConfig` (constructed in `di-container.ts` from `index.ts`) — never `process.env` inside `orchestrator.ts` or the machines.

---

## 8. Contributor Guardrails (from AGENTS.md)

| Rule | Detail |
|---|---|
| Pure core | `src/core/` must have zero imports reaching `src/infrastructure/` or `src/cli/`. |
| Strict TS | `strict`, `noUncheckedIndexedAccess`, `isolatedModules`; `.js` extensions in imports (ESM `NodeNext`). |
| No `any` | Use `unknown` and narrow; no `as any`, no `// @ts-ignore`. |
| No `const enum` | Breaks `isolatedModules` — use regular `enum`. |
| Commits | Human format `<type>(<scope>): <desc>`; agents use `chore(ai): pass-N – <desc>`. Never commit to `main`. |
| Generated files | Never commit `dist/`, `*.tsbuildinfo`, `.env`. |

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| G-1 | End-to-end quickstart walkthrough | A full worked example running the pipeline against a sample `specs/*.md` and showing expected artefacts/commits/output. The `specs/` directory and [9. ADRs & Roadmap §3](../contributor-deep-dive/09-adrs-roadmap.md) remain thin on runnable examples. |
| G-2 | Copyable pass skeleton | There is no template-only pass file; contributors must clone `pass-N-*.md`. Consider extracting a `docs/templates/pass-template.md` (and wiring it into STYLE_GUIDE §4.1). |
| G-3 | MCP/first-run validation | No automated check that `opencode` and `codebase-memory-mcp` are present before the first spawn; the failure surfaces late. A preflight in `index.ts` (like the `OPENROUTER_API_KEY` check) is proposed. |

---

## Related

- [5. CLI & Dependency Injection Wiring](05-cli-di-wiring.md) — DI contract, `di-container.ts`, data flow
- [2. Prompt Engineering §5](02-prompt-engineering.md#5-adding--modifying-a-pass) — pass-addition recipe
- [7. Testing Strategy & Mock Patterns](07-testing-strategy.md) — how changes are verified
- [4. Infrastructure Adapters](04-infrastructure-adapters.md) — the opencode spawn seam and argument contract
- [ADR-0001 — Pure Core Engine](../adrs/0001-pure-core-engine.md) — why `src/core/` stays pure
- [6. Observability & Operations](06-observability-operations.md) — flags, logs, pause/resume controls
