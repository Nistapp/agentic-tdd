# 0012. opencode SDK Is the Default Agent Backend

* **Status:** Accepted
* **Date:** 2026-09-10
* **Deciders:** @kcramakrishna
* **Supersedes:** the "Pi is the default backend" decision of [ADR-0010](./0010-agent-agnostic-sdk-architecture.md) (the adapter architecture itself is retained; only the default backend changes)
* **Amends:** [ADR-0011](./0011-mandatory-indexer-gate.md) — its G1 "only `pi` is supported" statement is superseded

---

## Context

ADR-0010 made the in-process Pi SDK (`@earendil-works/pi-coding-agent`) the default
agent backend because it eliminated the per-pass `opencode` process fork. That
decision, and the mandatory indexer gate of ADR-0011, rest on a structural
limitation discovered afterwards:

* **Pi has no MCP support by design.** `pi-mcp-adapter` registers its MCP tools
  only in the interactive/print Pi host — never inside an embedded headless SDK
  session, the exact shape `PiSdkRunner` and the live probe create. ADR-0011
  closed the resulting gap with a bespoke in-session bridge
  (`indexer-bridge.ts`) that turns every indexer tool call into a one-shot
  `codebase-memory-mcp cli` spawn. That bridge works, but it is harness-owned
  glue standing in for a protocol the agent runtime does not speak.

A completed spike (`artefacts/spike-opencode-sdk/FINDINGS.md`) proved that the
**opencode SDK** (`@opencode-ai/sdk`) provides, headless and in-process:

1. per-agent targeting (`session.create({ agent })`) and per-agent model
   resolution;
2. per-agent permission enforcement (`deny` removes the tool; `ask` is unsafe
   headless because it blocks forever);
3. **real MCP** — the `codebase-memory` server registers and its tools are
   callable under `<serverName>_<toolName>`;
4. capture parity (text deltas, tool start/end, token usage) via the SSE stream;
5. an **LLM-free** gate probe (config/status/direct-MCP round-trip);
6. exactly one child process (`opencode serve`), cleanly killed by
   `server.close()`.

The only failed criterion was raw startup economics: opencode costs **~0.9 s
more per pipeline run** than Pi (964 ms vs 45 ms, fixed overhead). Against
multi-minute passes this is immaterial, and it is far below the per-pass fork
cost of the legacy `opencode-cli` backend.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| Keep Pi default + `customTools` CLI bridge | Rejected — the bridge is a permanent workaround for a protocol Pi does not speak; every tool call forks a process and no real MCP session exists. |
| Make `opencode-cli` the default | Rejected — one OS process fork + runtime boot **per pass**, raw stdout parsing, no structured capture. |
| Adopt the opencode SDK but start a server per pass | Rejected — multiplies the ~0.9 s boot by 8 and abandons session reuse. |
| **Adopt the opencode SDK, one server per session entry** | **Chosen** — real MCP, structured capture, one child process, fixed ~0.9 s per-run cost. |

---

## Decision

### 1. opencode SDK is the default backend; Pi is demoted to backup

`AgentBackend` becomes `'opencode' | 'pi' | 'opencode-cli'`, and `--backend`
defaults to `opencode`. `OpencodeSdkRunner` (new,
`src/infrastructure/agent-runners/opencode-sdk-runner.ts`) implements the
unchanged `IAgentRunner` contract. Pi and `opencode-cli` remain fully
constructible backup/legacy backends; no Pi machinery is deleted.

### 2. The indexer gate owns the opencode server (one server per session)

`ensureIndexerAccess()` becomes backend-aware and, for the default backend,
**starts the server once per session entry** and hands the handle to the
pipeline via a narrow, SDK-typed-free DI port:

```typescript
// src/core/interfaces.ts
export interface IAgentServerHandle {
  readonly baseUrl: string;
  isAlive(): Promise<boolean>;   // raw HTTP health probe, never session.get()
  close(): Promise<void>;        // idempotent: server + run-scoped config dir
}
```

Gate sequence for `opencode`:

* **G2 static** — resolve/execute-check `codebase-memory-mcp`; resolve the
  `opencode` binary and record its version.
* **G3 server start** — materialise `.agentic-tdd/opencode-run-<id>/opencode/opencode.json`,
  choose a free port, `createOpencode({ port, timeout, config })` inside a
  POSIX `XDG_CONFIG_HOME` scope. Boot failure is a typed
  `opencode_boot_failed` with remedy text.
* **G4 MCP allowlist** — `config.get()` merged `mcp` keys; `mcp.disconnect()`
  every non-allowlisted server (cross-platform leak control); `mcp.status()`
  must report the canonical server `connected` (`mcp_not_connected` /
  `mcp_leak` otherwise).
* **G5 LLM-free round-trip** — a direct MCP stdio exchange
  (`@modelcontextprotocol/sdk`: `initialize` → `tools/list` → `tools/call
  list_projects`) against the same binary. No LLM prompt, no API cost.
  *Divergence from the prompt:* the raw MCP protocol exposes **bare** tool names
  (`search_graph`), so G5 asserts the bare core suffixes; the
  `<serverName>_<tool>` prefix is added by the opencode client at the model
  layer (proved by the spike's model-turn capture), not by the MCP server.
* **G6 index bootstrap** — unchanged: the existing one-shot CLI bootstrap
  (`ensureIndexed`, `IndexerCli`) deliberately stays on the CLI path until
  MCP-native bootstrap is proven.

The `pi` path keeps today's static checks (pi-mcp-adapter, `.mcp.json` +
`directTools`), live probe and G6, and returns `{ ok: true }` with **no**
server. `.mcp.json` setup/teardown is now reached only on `--backend pi`.

### 3. Run-scoped isolated config and tool/permission mapping

`opencode-config.ts` is a pure generator and the **single source of truth** for
the canonical MCP server name (`codebase-memory`) and every derived tool name
(`codebase-memory_<tool>`, single underscore). It builds one local MCP entry,
8 `primary` agents from the pass frontmatter + body, and two provider entries
whose keys are `{env:OPENROUTER_API_KEY}` / `{env:DEEPSEEK_API_KEY}`.

Frontmatter `permission` maps to opencode `permission` with **`allow`/`deny`
only**: `read`→`read`, `edit`→`edit`, `glob`→`glob`+`list`, `grep`→`grep`;
explicit `deny` entries are preserved; `ask` is **never** emitted. MCP tools
are never denied — the gate guarantees the indexer. Frontmatter parsing reuses
the Pi SDK's exported `parseFrontmatter` (already a declared dependency) rather
than introducing a third YAML parser, keeping the new-dependency surface to the
two permitted packages.

### 4. Guaranteed teardown

All three session entry points (`startNewSession`, paused `resumeSession`,
fast-forward `resumeSession`) run the orchestrator inside `runWithServer()`
(`src/cli/run-with-server.ts`), which registers the active handle, always
closes it in `finally`, and is reachable from the CLI's SIGINT (both presses),
`uncaughtException`, `unhandledRejection`, and `--abort` paths. `close()` is
idempotent, closes the server, and removes the run-scoped config directory
**only** when the harness created it and its contents are unchanged
(create/keep semantics mirroring `mcp-config.ts`).

### 5. Version pin

`@opencode-ai/sdk` **1.18.30** ↔ installed `opencode` binary **1.18.29**;
`codebase-memory-mcp` **0.10.8**. These are the tested pair from the spike.

---

## Consequences

### Positive

* **Real MCP, no bridge:** the default path speaks MCP natively; the Pi
  `customTools` CLI shim is reached only on `--backend pi`.
* **One server, one child:** the server is started once per session entry and
  reused by every pass via a fresh session; no per-pass server boot.
* **Structured capture:** deltas, tool calls (args + result + error) and token
  usage come from the event stream with `session.messages()` as fallback.
* **Deterministic, LLM-free gate:** config isolation, allowlist enforcement and
  a direct MCP round-trip prove the indexer is healthy before Pass 0, at zero
  API cost.
* **Clean lifecycle:** guaranteed teardown on success, failure, pause and
  crash; no orphaned `opencode serve` child or config directory.

### Negative / Trade-offs

* **~0.9 s fixed boot penalty per run** (964 ms vs 45 ms). Accepted; immaterial
  against multi-minute passes and far cheaper than per-pass `opencode-cli`
  forks.
* **`XDG_CONFIG_HOME` isolation is POSIX-only.** On Windows the global config
  is not XDG-based; the platform-neutral control is the mandatory
  `mcp.disconnect` allowlist. A Windows CI run is still required.
* **Tool-name mapping is a maintenance point.** MCP tool names cannot be
  enumerated LLM-free through the SDK; the `<server>_<tool>` names are derived
  from the canonical constant, and a one-cheap-turn name check per release is
  recommended (see Open items).
* **v1/v2 API drift risk.** The runner follows the spike's proven **v2**
  client (`@opencode-ai/sdk/v2`) for `session.create({ agent })`; the prompt's
  M3 wording referenced the v1 top-level `client.session`, whose `create` does
  not accept `agent` in SDK 1.18.30. The v2 surface is pinned and asserted by
  tests; any future major must re-verify the field shapes.
* **`process.env` mutation for the XDG scope.** `createOpencode()` has no
  per-child env parameter, so the XDG override is applied by scoping
  `process.env` around the boot call and restoring it in `finally`
  (`opencode-server.ts`). This is the one new `process.env` write outside
  `src/cli/index.ts`; it is contained, testable via an injected `envScope`
  seam, and documented here.
* **`permission: ask` is a footgun.** A stray `ask` blocks headless forever;
  the runner detects `permission.asked`, aborts the turn and fails with an
  actionable `agent_failed`, and the config generator never emits `ask`.

---

## Open items (recorded, not silently resolved)

* **Per-pass thinking level.** Pi's `PiSdkRunner` used `PASS_THINKING`
  (`high` for Design/TestGeneration). opencode's `AgentConfig` exposes an
  `options` pass-through but no verified reasoning-effort key for
  `openrouter/deepseek/*`; the generated agents therefore omit it and inherit
  the model default. Revisit if/when a provider-level option is verified.
* **Child-process handle for an `exit`-hook SIGTERM.** The SDK's returned
  `server` exposes `url`/`close()` only; the raw child is not exposed. The
  best-effort safety net is therefore `close()` on every path (including
  signal/crash handlers) rather than a `process.on('exit')` `SIGTERM`.
* **Windows global-config isolation** (see above) needs a Windows CI run.
* **Tool-name enum validation in CI.** Names are not observable LLM-free;
  validate the `<server>_<tool>` mapping once per release with one cheap
  flash-tier turn.
* **MCP-native index bootstrap.** G6 intentionally remains on the one-shot CLI
  path; migrating it to MCP is a follow-up once proven.

---

## Related

* [ADR-0010 Agent-Agnostic SDK Architecture](./0010-agent-agnostic-sdk-architecture.md) — adapter architecture retained; default backend superseded by this ADR
* [ADR-0011 Mandatory Indexer Gate](./0011-mandatory-indexer-gate.md) — G1 "only `pi`" superseded; gate now owns the opencode server
* [ADR-0009 Configurable Per-Agent Models](./0009-configurable-per-agent-models.md)
* [ADR-0001 Pure Core Engine](./0001-pure-core-engine.md) — all server/OS work stays in infrastructure behind DI
* `artefacts/spike-opencode-sdk/FINDINGS.md` — the authoritative spike evidence
* `@opencode-ai/sdk` 1.18.30, `opencode` 1.18.29, `codebase-memory-mcp` 0.10.8
