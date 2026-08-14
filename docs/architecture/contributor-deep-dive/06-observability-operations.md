# 13. Observability, Logging, & Operations

> **Target Audience:** Contributors debugging passes or extending logging.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline

- **Logging Architecture:** pino structured JSON, child loggers scoped per pass (`logger.child({ passId })`).
- **Pass Log Persistence:** per-pass opencode output logs; error logs injected into retries, deleted on success.
- **Log Sanitizer:** `src/core/log-sanitizer.ts` — strips C0 control chars, truncates strings at info level.
- **Event Bus:** `IEventBus` pub/sub driving the terminal UI.

---

## Existing material to mine

- [`src/core/log-sanitizer.ts`](../../../src/core/log-sanitizer.ts)
- [`src/infrastructure/pino-logger.ts`](../../../src/infrastructure/pino-logger.ts)
- [`src/infrastructure/event-bus.ts`](../../../src/infrastructure/event-bus.ts)
- Event catalogue: [1. Core Engine Internals §1.3](01-core-engine-internals.md#13-events)

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| O-1 | Log level semantics | INFO/DEBUG/WARNING/ERROR across orchestrator, runner, machine. |
| O-2 | Sanitizer limits | What is stripped/truncated and why. |
