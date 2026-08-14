# 0001. Pure Core Engine — No Infrastructure Imports in `src/core/`

* **Status:** Accepted
* **Date:** 2026-06-01 (estimated)
* **Deciders:** <!-- @github-handle -->

---

## Context

The pipeline engine is the brain of `agentic-tdd`: it drives eight guarded passes
(Design → Contracts → Tests → Implementation → Refactor → Observability → Security →
Documentation), each ending in an atomic git commit. The original implementation
mixed orchestration logic directly with operating-system side effects — spawning
processes, reading/writing files, invoking git, and emitting logs — from within the
same code that reasoned about pipeline state.

That coupling produced several concrete problems:

* **Untestable state transitions.** Testing the engine required a real filesystem,
  a real git binary, and a real `opencode` sub-process. Fast, deterministic unit
  tests of "what happens when Pass 3 fails" were impossible.
* **No portability.** The engine could not be embedded in another host (e.g. a
  VS Code extension) because every OS interaction was hard-wired to the CLI
  implementation.
* **Hidden side effects.** Business logic and I/O were interleaved, so reasoning
  about the state machine's guarantees required tracing through concrete OS calls.

## Decision

The **Core Engine** (`src/core/`) is a pure state machine with **zero** knowledge of
filesystems, Git, or shell commands. The dependency rule is strict and one-directional:

* **`src/core/` MUST import only** `src/core/interfaces.ts`, core-internal helpers,
  and `xstate` — **MUST NOT** import from `src/infrastructure/` or `src/cli/`.
* **All OS operations are declared as abstract contracts** in
  [`src/core/interfaces.ts`](../../../src/core/interfaces.ts#L1-L11): `IGitService`
  (git, [`interfaces.ts#L19`](../../../src/core/interfaces.ts#L19)), `IFileSystem`
  (fs, [`interfaces.ts#L91`](../../../src/core/interfaces.ts#L91)), `ICommandRunner`,
  `IAgentRunner`, `IEventBus`, `IStateStore`, `ISymbolResolver`, `IContextProvider`,
  and `PipelineConfig`.
* **Concrete adapters live in `src/infrastructure/`** and are the *only* place that
  touches `child_process`, `fs`, git, or `pino` (e.g.
  [`file-system.ts`](../../../src/infrastructure/file-system.ts#L1),
  [`git-service.ts`](../../../src/infrastructure/git-service.ts#L2),
  [`pino-logger.ts`](../../../src/infrastructure/pino-logger.ts#L2)).
* **The engine consumes these contracts via constructor injection.**
  [`PipelineOrchestrator`](../../../src/core/orchestrator.ts#L22-L61) receives every
  dependency (`git`, `fs`, `cmd`, `agentRunner`, `events`, `logger`, `config`,
  `contextProvider`, `symbolResolver`, `stateStore`, `onHitl`) through its
  constructor; its imports reach only `./interfaces.js` and the machine modules
  ([`orchestrator.ts#L4`](../../../src/core/orchestrator.ts#L4)).

This is a **Ports & Adapters** (hexagonal) arrangement: the state machine defines the
ports (interfaces), and the infrastructure adapters implement them, all wired together
in the composition root under `src/cli/`.

## Consequences

### Positive

* **Deterministic, fast unit tests.** The full DI surface can be satisfied with
  typed stubs/mocks — no real I/O, git, or `opencode` in tests. See the mock
  inventory in the [Testing Strategy](../contributor-deep-dive/07-testing-strategy.md).
* **Reusable engine.** The same pure core can be embedded in alternative hosts
  (VS Code extension, CI plugin) by supplying new adapters — no engine changes.
* **Clear seams for auditing.** Every OS boundary is an explicit interface, so
  security reviews and sandboxing decisions can be reasoned about at the port level.
* **Onion-like testability of state transitions.** Machine behaviour is assertable
  without side effects, which is a prerequisite for the XState decision (ADR
  [0002](./0002-xstate-machines.md)).

### Negative / Trade-offs

* **Indirection.** Every OS call travels through an interface plus an adapter, which
  adds boilerplate versus calling `fs`/`child_process` directly.
* **Effort to add a new capability.** A new OS-side feature requires defining an
  interface in `src/core/interfaces.ts`, a matching adapter in `src/infrastructure/`,
  and DI wiring — three coordinated edits, imposing mild friction on velocity.
* **Interface drift risk.** Contracts must stay in sync with every implementation;
  the AGENTS.md coding standards require `npm run lint` to pass, which catches
  signature drift at compile time.
