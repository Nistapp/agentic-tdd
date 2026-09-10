# Glossary

Canonical definitions of domain terms used in `agentic-tdd`.
Both humans and AI agents should use these terms consistently.

---

| Term | Definition |
|---|---|
| **Pass** | One phase of the 8-pass pipeline, handled by a dedicated agent. Referred to as "Pass N" (e.g., Pass 3) when specific, "pass" (lowercase) when generic. |
| **Pipeline** | The full sequence of 8 passes orchestrated by `PipelineOrchestrator`. Always lowercase. |
| **HITL** | Human-in-the-Loop. The approval gate after Pass 0 where a developer reviews and approves `.mmd` and `.gherkin` artifacts before code generation begins. |
| **Static Prefix** | The practice of placing stable files (contracts, specs) first in every agent context payload to maximise LLM provider-level KV cache hits. Always capitalised. **Deprecated / low priority** — with per-pass LLM configuration, its value is unclear; under research in [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53). |
| **Context Compaction** | Deleting per-pass error logs after a successful pass, preventing stale failure noise from polluting future context windows. Always capitalised. |
| **Agent Trampling** | When one agent unintentionally overwrites verified work from a previous pass by exceeding its declared scope. Prevented via file-glob permission locks in agent frontmatter. |
| **targetSymbols** | A map of `filePath → [qualified symbol names]` passed to each agent, identifying exactly which methods/classes were modified by upstream passes. Populated by `AstGrepSymbolResolver`. |
| **Context Compaction** | See above. |
| **Self-Correction Loop** | The retry mechanism (up to 3 retries — `DEFAULT_MAX_CORRECTION_RETRIES = 3`) within a guarded pass. If the agent's output fails the test gate, the error log is fed back and the agent retries. Implemented in `createSelfCorrectionMachine`. |
| **Guarded Pass** | A pass that has an automated test gate (Passes 3–6). Failure triggers the Self-Correction Loop. |
| **Artifact-Driven Development** | The practice where `.mmd` (Mermaid diagrams) and `.gherkin` (BDD specs) are the primary source of truth; code is generated to satisfy them, not the reverse. |
| **DI (Dependency Injection)** | All infrastructure dependencies are injected into the core engine via interfaces. `src/core/` never imports from `src/infrastructure/`. |
| **Spec Drift** | When code diverges from its architectural diagrams or Gherkin specs. The pipeline's Pass 7 and HITL gate are the primary defences against spec drift. |
| **originalBaseSha** | The git SHA of the commit that existed before a pipeline run started. Stored in the session state file. Used by `--abort` to revert all AI-generated commits. |
| **opencode** | The AI coding agent CLI (`opencode`) and its SDK (`@opencode-ai/sdk`). The **default** backend boots one `opencode serve` child per session entry via `OpencodeSdkRunner`, with real MCP. The legacy **opencode-cli** backend (`OpenCodeCliRunner`) shells out per pass. |
| **Pi** | The in-process coding-agent SDK (`@earendil-works/pi-coding-agent`) used by the backup **Pi** agent backend (`--backend pi`). Managed by `PiSdkRunner` (see `Agent Runner`). |
| **Agent Runner** | The `IAgentRunner` adapter that executes one pipeline pass's agent. Backend-agnostic via a factory (`createAgentRunner`); **opencode** (`OpencodeSdkRunner`, SDK server, default), **pi** (`PiSdkRunner`, in-process SDK, backup) and **opencode-cli** (`OpenCodeCliRunner`, shell-out, legacy) — [ADR-0012](adrs/0012-opencode-sdk-default-backend.md). |
| **Agent Server Handle** | The narrow, SDK-typed-free `IAgentServerHandle` (`baseUrl`, `isAlive()`, `close()`) owned by the indexer gate and handed to the pipeline; its `close()` is idempotent and tears down the run-scoped config directory — [ADR-0012](adrs/0012-opencode-sdk-default-backend.md). |
| **LiteLLM** | Self-hosted AI gateway proxy used for SSO auth, budget enforcement, DLP masking, and model routing. Runs in `infra/`. |
| **Context Payload** | The JSON object passed to each agent containing `featureName`, `paths`, `contextFiles`, `targetSymbols`, `fileChanges`, and `meta`. Constructed by `getAgentContextPayload`. |
| **Indexer Status** | The harness-owned `IndexerStatus` (`available`, `indexed`, `project`) recorded on `PipelineContext` after the mandatory indexer gate passes and injected into every payload as `meta.indexer`. Optional on the context for backward compatibility with older snapshots — [ADR-0011](adrs/0011-mandatory-indexer-gate.md). |
