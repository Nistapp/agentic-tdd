# 0011. codebase-memory Indexer Is a Mandatory Harness Prerequisite

* **Status:** Accepted
* **Date:** 2026-09-09
* **Supersedes:** the "optional accelerator" stance of `artefacts/Prompt-Ensuring-code-reuse.md` (Layer 1, H1–H3)

---

## Context

`codebase-memory-mcp` was treated as an *optional accelerator*: `resolveMcpBinary`
fell back to a hardcoded path even when the binary was not installed, nothing
guaranteed the target repo was indexed before Pass 0 dispatched, and — critically —
the Pi SDK runner's explicit `tools` allowlist silently dropped every indexer tool
in every pipeline session. Agents either wasted turns probing a dead indexer or
never saw the indexer at all.

Two further findings shaped this ADR:

* The pipeline's design philosophy (AGENTS.md §1) is that **the harness, not the
  agent, owns environment truth**. The indexer therefore had to move from an
  optional accelerator to a hard prerequisite verified deterministically once per
  session.
* The installed `pi-mcp-adapter` (v2.32.1) **does not register its MCP tools inside
  an embedded headless pi SDK session** — the exact session shape `PiSdkRunner`
  creates per pass. It only surfaces tools in the interactive/print pi host.
  Verified empirically (project `.mcp.json` present/absent, `directTools: true`,
  wait-for-init, `bindExtensions('rpc')`): a real SDK session exposes only the six
  built-ins. So the harness must **own** indexer tool registration in-session.

## Decision

The `codebase-memory` indexer is a **mandatory harness prerequisite**. At each
session entry point (start, resume-paused, resume-fast-forward) and **before any
pass dispatches**, the harness runs a gate (`ensureIndexerAccess`, wired in
`src/cli/session.ts`, composed in `src/infrastructure/indexer-gate.ts`):

1. **G1 — backend gate:** only `--backend pi` is supported. `opencode-cli` is a
   fatal exit until a checker exists for it.
   > **Superseded by [ADR-0012](./0012-opencode-sdk-default-backend.md):** the
   > default backend is now `opencode` (SDK server) and the gate owns its server;
   > `pi` is the backup. `opencode-cli` remains a fatal exit.
2. **G2 — static checks** (`src/infrastructure/indexer-probe.ts`): resolve the
   binary via `which`/`where` with **no hardcoded fallback** (missing binary is a
   fatal with install instructions); verify it is executable; verify the
   `pi-mcp-adapter` extension is declared in pi's agent `settings.json`; verify the
   merged MCP config carries a `codebase-memory` server entry with
   `"directTools": true`. These remain environment prerequisites (the adapter is
   the canonical path for interactive pi); the pipeline's in-session path does not
   depend on the adapter actually registering tools in embedded sessions.
3. **G3 — live probe — dynamic discovery with minimum-viable verification:** create
   a throwaway in-memory pi SDK session **shaped exactly like a per-pass session**
   (same `DefaultResourceLoader`, same tools allowlist, same indexer bridge
   `customTools`) and assert the **core** indexer tools are present
   (`search_graph`, `get_code_snippet`, `index_repository`, namespaced
   `mcp__codebase-memory__*`). Any **additional/newer** tools are tolerated — there
   is no rigid exact-set match against a hardcoded 15-name list. The probe then
   invokes `list_projects` through the binary's one-shot CLI to prove it responds.
   **No LLM prompt is sent → no API cost.**
4. **G6 — mandatory index bootstrap** (`src/infrastructure/indexer-client.ts`):
   locate the project by root path, compare `index_status` `head_sha` against the
   repo's current HEAD, and run `index_repository` when absent or stale.
   Bootstrap failure or timeout is a **fatal exit** (the old "run continues with
   `indexed: false`" fallback is removed). Mid-run staleness remains tolerable
   because the MCP server auto-refreshes watched projects.

**In-session indexer bridge (closes Gap C deterministically):** the harness
registers the canonical indexer tools as pi SDK `customTools`
(`src/infrastructure/agent-runners/indexer-bridge.ts`), each executing the indexer
binary's one-shot CLI mode (`cli <tool> <json-args>`). Both `PiSdkRunner.execute()`
and the live probe pass these `customTools` to `createAgentSession`, so every
per-pass agent deterministically sees `mcp__codebase-memory__*` tools regardless of
pi-mcp-adapter host mode. Per-call cost is one short-lived CLI spawn (the binary
keeps a warm on-disk index). Tool parameter schemas use the `typebox` schema
package (a declared dependency of `pi-coding-agent`). This revisits the original
plan's decision 5 (pi-mcp-adapter as the sole canonical pipeline path): the adapter
remains canonical for interactive pi, but the **pipeline path** is the in-session
bridge.

**Allowlist semantics:** the agent files' `permission:` blocks govern **built-in**
tools only (`read`, `edit`, `write`, `grep`, `find`, `ls`). Indexer tools (anything
under the `mcp__codebase-memory__` prefix) are harness-guaranteed by the gate and
always enabled (`src/infrastructure/agent-runners/pi-sdk-runner.ts`).

**Boundaries preserved:** all OS work lives in `src/infrastructure/` behind
injected seams (`IFileSystem`, process runners); `src/core/` is untouched.

## Consequences

### Positive

* **No dead indexer registrations:** a missing binary is caught and reported with
  install instructions before any agent session spawns.
* **No wasted agent turns probing the environment:** reachability is proven once
  per session by the harness.
* **Deterministic startup state:** every pass starts against an indexed, fresh
  repo (or the run never starts).
* **Gap C closed:** per-pass agents always see the indexer tools because the
  harness registers them in-session; this no longer depends on pi-mcp-adapter
  registering tools inside an embedded SDK session.
* **Version-skew tolerant:** the live probe requires only core tools and tolerates
  newer/additional indexer tools.

### Negative / Trade-offs

* **A session now requires the indexer + adapter + model resolvable** for the
  probe session; operators must install all three. Failure messages carry the
  remedy.
* **Startup cost:** one extra probe session and a possible full `index_repository`
  per session start when the index is stale.
* **Per-call CLI spawn latency** for in-session indexer tools (a fresh binary
  process per tool call) rather than a persistent MCP server. The plan's preferred
  persistent-server path remains available for interactive pi; a future adapter
  generation that registers tools in embedded sessions could replace the bridge.
* **`opencode-cli` backend is temporarily unsupported** while the gate is
  mandatory (G1 fatal), until a checker exists for it.
