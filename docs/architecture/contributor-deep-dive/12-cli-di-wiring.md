# 12. CLI & Dependency Injection Wiring

> **Target Audience:** Contributors touching entry points or DI.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline

- **DI Container:** `src/cli/di-container.ts` — `createPipelineServices` wiring all concrete adapters into the core.
- **Session Lifecycle:** `src/cli/session.ts` — start, resume, abort (`--abort` → `originalBaseSha` rewind), state file locking.
- **Terminal Event Listener / Renderer:** progress rendering from `IEventBus` emissions.
- **HITL Handler:** `src/cli/hitl-handler.ts` — approve / rewind / reject prompts.
- **Validators:** `src/cli/validators.ts` — CLI option resolution.

---

## Existing material to mine

- Entry point: `src/cli/index.ts`.
- DI contracts: [`src/core/interfaces.ts`](../../../src/core/interfaces.ts).
- [8. Core Engine Internals](08-core-engine-internals.md) — how the orchestrator consumes injected services.

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| D-1 | Wiring diagram | Mermaid diagram: CLI → DI container → core machines → adapters. |
| D-2 | Flag → config mapping | `--feature-desc-file`, `--test-cmd`, `--skip-hitl`, `--resume`, `--abort`, `--log-level`. |
