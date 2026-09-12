# 0010. Agent-Agnostic SDK Architecture (Pi Default)

* **Status:** Accepted
* **Date:** 2026-09-04
* **Last updated:** 2026-09-05 (post-spike verification; amended after v3 design review — per-pass thinking map, MCP copy-or-merge template, environment decision, platform hardening)
* **Deciders:** @kcramakrishna

> **Default-backend note:** [ADR-0012](./0012-opencode-sdk-default-backend.md)
> supersedes only the *default backend* decision below. The adapter architecture,
> `IAgentRunner` contract, per-pass session isolation and prompt handling are
> retained; `PiSdkRunner` remains as the backup backend.

---

## Context

The v1 8-pass pipeline relied on spawning the `opencode` CLI via `execa` for every pass (`CommandRunner.spawn()`). This approach suffered from several limitations:
1. **Per-Pass Process Startup:** Forking an OS process, booting a Go runtime, reconnecting to MCP servers, and negotiating LLM handshakes on every invocation — repeating this 8× per pipeline run.
2. **Lack of Structured Output:** The engine relied on parsing raw `stdout`/`stderr` strings, lacking typed event streams for observability.
3. **Fragile Process Management:** Required manual `setInterval` watchdogs and SIGKILL hard timeouts to manage the CLI process lifecycle.
4. **Vendor Lock-in:** The pipeline was tightly coupled to the `opencode` binary lifecycle, making it difficult to experiment with newer SDK-first agents like Pi.

While `opencode` offers an SDK (`@opencode-ai/sdk`), it requires managing a separate persistent server process (`opencode serve`), which adds deployment complexity and breaks the "zero-config" local execution model.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **Stay with `opencode` CLI** | Rejected — the startup overhead and lack of structured data are limiting pipeline evolution. |
| **Migrate to `@opencode-ai/sdk`** | Rejected — requires users or the orchestrator to manage an `opencode serve` daemon, adding operational complexity. |
| **Migrate to Goose SDK (`ai-sdk-provider-goose`)** | Rejected — requires a local Goose daemon installation, similar to opencode's server burden. |
| **Migrate to Pi SDK (`@earendil-works/pi-coding-agent`)** | **Chosen** — runs fully in-process (Node.js), provides typed event streams, allows tool allowlisting, and requires zero external daemon management. |

---

## Spike Verification (2026-09-05)

The Pi SDK (`@earendil-works/pi-coding-agent` v0.85.0) was verified in a headless configuration:

| Test | Result |
|---|---|
| Model resolution via `resolveCliModel({ cliModel: "openrouter/deepseek/deepseek-v4-pro:medium" })` | ✅ Resolved correctly |
| Session creation with `systemPromptOverride`, `tools: ["read","edit","write","grep","find","ls"]`, `SessionManager.inMemory()` | ✅ Created, bash excluded |
| `session.prompt()` → event capture → `message_update.text_delta` → `turn_end` | ✅ 2047ms, skip-signal `SKIP:0:ready` captured |
| `createMcpAdapter({ config })` factory import | ✅ Function accessible; TS-in-node_modules restriction → use file-based `.mcp.json` config |
| API key resolution: `OPENROUTER_API_KEY` env var honored by `ModelRuntime` | ✅ Transparent |

---

## Decision

We will refactor the agent runner architecture to be **agent-agnostic** via the SDK Adapter pattern, and make **Pi (`@earendil-works/pi-coding-agent`) the default backend**.

### 1. Adapter Architecture
The existing `IAgentRunner` interface remains the universal contract. A `createAgentRunner(backend, deps)` factory instantiates the correct runner adapter based on the `--backend` CLI flag.

```typescript
// src/core/interfaces.ts — UNCHANGED
export interface IAgentRunner {
  execute(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

Adapters in `src/infrastructure/agent-runners/`:
- **`PiSdkRunner`**: The new default, using the in-process Pi SDK.
- **`OpenCodeCliRunner`**: Renamed from the current `OpenCodeAgentRunner`, kept for legacy fallback via `--backend opencode-cli`.
- `OpenCodeSdkRunner` / `GooseSdkRunner`: (Future, deferred).

### 2. Pi as the Default Backend
Pi is the hardcoded default. An optional `--backend <pi|opencode-cli>` CLI flag provides the fallback. Backend selection lives in the CLI/DI layer (consistent with ADR-0001), flowing through `ContainerOptions` → `createPipelineServices` → `createAgentRunner`. **No changes** to `model-config.ts`, `config.default.json`, or `PipelineConfig`.

### 3. Session Strategy: Per-Pass Isolation
We retain the current **session-per-pass** isolation model: each `execute()` call creates a fresh `SessionManager.inMemory()` session. This ensures context boundaries remain strict, prevents token pollution across passes, and maintains the current architectural guarantees of the 8-pass pipeline.

### 4. Zero-Refactoring for Agent Prompts
The existing agent prompt files (`src/agents/pass-*.md`) are **not refactored**. The Pi adapter uses `stripFrontmatter()` (exported by Pi itself) to extract the agent-agnostic Markdown body, which becomes the system prompt via `DefaultResourceLoader({ systemPromptOverride })`. The opencode YAML `permission:` block is discarded; the Pi adapter maps the declared intents into a `tools` allowlist that **tightens enforcement** relative to today (see §6).

### 5. Universal Model String Format & Per-Pass Thinking Levels
The model configuration (ADR-0009) uses the canonical `provider/model` format across all backends. The Pi adapter appends a **hardcoded per-pass thinking level** (v3 review decision) and resolves via `resolveCliModel()`:

```
"openrouter/deepseek/deepseek-v4-pro" + pass 0/2  →  "openrouter/deepseek/deepseek-v4-pro:high"
"openrouter/deepseek/deepseek-v4-flash" + pass 1, 3–7  →  "openrouter/deepseek/deepseek-v4-flash:off"
```

The static `PASS_THINKING` map lives inside `PiSdkRunner` (infrastructure layer): **`high` for
passes 0 (Design) and 2 (Test Generation); `off` for passes 1 and 3–7.** Rationale: design
and test generation are the deep-reasoning passes; the rest execute against precise payloads
needing fidelity, not exploration. `resolveCliModel()` clamps the requested level to each
model's supported range, so `:high` degrades safely on models without it. No config file
changes; a config-driven `agents.thinking` map is a recorded fast-follow.

Verified: `deepseek-v4-pro`, `deepseek-v4-flash`, and their `-0813`/`-0713` variants all resolve correctly.

### 6. Permission Mapping: Tightened Enforcement
Today, `--dangerously-skip-permissions` bypasses the YAML `permission:` block entirely; the model follows `<scope>`/`<directives>` by convention. The Pi adapter enforces the declared intents programmatically via the `tools` allowlist:

| Intent | Pi `tools` entry |
|---|---|
| `read`, `glob`, `grep` | `"read"`, `"find"`, `"ls"`, `"grep"` |
| `edit` | `"edit"`, `"write"` |
| `bash: deny` | Omit `"bash"`, `"powershell"` |
| `webfetch: deny` | No fetch tool registered |
| `task: deny` | No task tool registered |

Default tool set per pass: `["read", "edit", "write", "grep", "find", "ls"]`

> **Platform note (v3 review):** `find`, `ls`, and `grep` in this table are **Pi's built-in
> tool names** — in-process Node.js implementations inside `@earendil-works/pi-coding-agent`,
> **not Unix binaries**. Pi's built-ins (`read`, `edit`, `write`, `grep`, `find`, `ls`,
> `bash`, and `powershell` for Windows) behave identically across Windows / Linux / macOS.
> The only OS-coupled tools are the shells, and **both** are omitted for `bash: deny`.
> The mapping table is therefore platform-safe as written; actual platform gaps live in the
> harness (paths, npm scripts, CI matrix) and are addressed by the platform-hardening phase
> (see implementation plan v3, Phase 6).

### 7. Skip-Signal: Preserve String Contract (Option A)
The Pi adapter synthesizes `AgentRunResult.output` from joined `message_update.text_delta` strings. This ensures the existing `parseSkipSignal()` (regex `SKIP:n:reason`) works with **zero core-machine changes**. Lifting to a typed field is deferred.

### 8. MCP via Package-Shipped Template (Copy-or-Merge)
A static `mcp.template.json` ships **inside the npm package** (copied to `dist/` by the existing build script, alongside `config.default.json` and the agent prompts). At pipeline start, the harness materializes `.mcp.json` in the project cwd:

* If `.mcp.json` is **absent** → copy the template verbatim (recorded as harness-created).
* If a user `.mcp.json` **exists** → deep-merge the single `codebase-memory` server entry **only if the key is absent**; every user key (other servers, `settings`, imports) is left untouched. The harness **never overwrites** a user-authored entry.
* **Teardown:** a harness-created file is deleted only if its content is still unchanged; merged or user-edited files are always kept.

The `command` for `codebase-memory-mcp` is **resolved per-platform at write time** (PATH/PATHEXT lookup; Linux falls back to `/usr/bin/codebase-memory-mcp`), replacing the previous hardcoded Unix absolute path. Pi's `DefaultResourceLoader` discovers the file and activates `pi-mcp-adapter` (installed as a Pi extension at `~/.pi/agent/` — see §10), which registers the MCP proxy tools. The adapter's default `lifecycle: "lazy"` (spawn on first tool call, cached metadata, idle disconnect) is accepted; per-session MCP spawn overhead was reviewed and closed as acceptable. This avoids the TS-in-node_modules restriction found in the spike while keeping MCP configuration inspectable, human-editable, and non-destructive to user config.

### 9. Runtime Requirement
Node ≥ 22.19.0 — inherited from `@earendil-works/pi-coding-agent` v0.85.0. This is a **new minimum** (repo was previously ≥ 18.0.0).

### 10. Environment: Reuse the User's Pi Config Home
The harness does **not** set `PI_CODING_AGENT_DIR`. Pi's config home (`~/.pi/agent` by default) holds `auth.json` (stored credentials — used by key-resolution priority 2), `settings.json`, `models.json`, and installed extensions **including `pi-mcp-adapter`**, on which § 8 depends. Sharing the user's config home is the zero-install path for both credentials and the adapter; consequently `pi install npm:pi-mcp-adapter` is a one-time per-machine prerequisite (documented in setup docs). Accepted, documented behavior: any extension the user installed for interactive Pi is also discovered by harness SDK sessions. There is no interaction with the harness's own `src/agents/` directory (agent prompt files) — unrelated concepts. (`PI_CODING_AGENT=true` / `AI_AGENT=pi` are set only by Pi's CLI/RPC entry points for child-shell detection; irrelevant here since `bash` is denied.)

### 11. Platform Support
Target: platform-agnostic (Windows, Linux, macOS). Pi itself supports Windows (see pi's `docs/windows.md`), and the tool allowlist (§ 6) is platform-safe because its entries are Pi in-process tools. The v3 plan adds a dedicated platform-hardening phase: per-platform MCP binary resolution (§ 8), `os.homedir()` replacing `HOME`/`USERPROFILE` string handling in `command-runner.ts` and `utils/paths.ts`, a `SIGKILL` portability audit (prefer execa force-kill), `shx` replacing Unix-only npm scripts, and a `windows-latest` + `macos-latest` CI matrix alongside `ubuntu-latest`.

---

## Consequences

### Positive
* **In-Process Execution:** The `PiSdkRunner` eliminates per-pass OS process fork+exec, moving agent invocation into the same Node process. No external servers or daemons.
* **Tool Enforcement:** Permissions declared in agent prompts (`bash: deny`, `webfetch: deny`) are programmatically enforced via Pi's `tools` allowlist, closing the gap left by opencode's `--dangerously-skip-permissions`.
* **Structured Observability:** Pi's event stream (`message_update`, `tool_execution_start/end`, `turn_end`) provides typed, inspectable tool calls and thinking steps, replacing raw stdout parsing.
* **Architectural Flexibility:** The adapter pattern (`IAgentRunner` + factory) means swapping backends requires no changes to the core state machine, orchestrator, or prompt files.
* **Non-Destructive MCP Setup:** The copy-or-merge template (§ 8) never clobbers a user's existing `.mcp.json`, unlike a naive runtime-generated write.
* **Platform Reach:** The permission mapping uses Pi's in-process tools, and the hardening phase + CI matrix make Windows/macOS first-class targets (§ 11).

### Negative / Trade-offs
* **Node Version Bump:** Requires Node ≥ 22.19.0 (from ≥ 18.0.0). Impacts CI, development environments, and downstream consumers of the library.
* **MCP File Side Effect:** Materializing `.mcp.json` in the project cwd remains a side effect; mitigated by copy-or-merge semantics and guarded teardown (deleted only if harness-created and unchanged). Requires a one-time per-machine `pi install npm:pi-mcp-adapter` prerequisite (§ 10).
* **New Error Convention:** `AgentRunError` is the repository's first custom `Error` subclass (all existing code throws bare `Error`). Additive and backward-compatible — core machines catch generic `Error` — but a new convention implementers must follow.
* **CI Matrix Cost:** Adding `windows-latest` and `macos-latest` runners increases CI runtime/maintenance (§ 11).
* **Legacy Code Retention:** The `OpenCodeCliRunner` and `IOpencodeSpawner`/`CommandRunner.spawn()` remain until the CLI backend is fully retired.

---

## Related

* [ADR-0009 Configurable Per-Agent Models](./0009-configurable-per-agent-models.md)
* [ADR-0001 Pure Core Engine](./0001-pure-core-engine.md) (config stays in CLI/DI layer)
* `src/infrastructure/agent-runners/` (New directory)
* `@earendil-works/pi-coding-agent` v0.85.0 (npm)
* `pi-mcp-adapter` v2.32.1 (Pi extension, installed via `pi install npm:pi-mcp-adapter`)