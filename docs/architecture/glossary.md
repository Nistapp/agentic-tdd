# Glossary

Canonical definitions of domain terms used in `agentic-tdd`.
Both humans and AI agents should use these terms consistently.

---

| Term | Definition |
|---|---|
| **Pass** | One phase of the 8-pass pipeline, handled by a dedicated agent. Referred to as "Pass N" (e.g., Pass 3) when specific, "pass" (lowercase) when generic. |
| **Pipeline** | The full sequence of 8 passes orchestrated by `PipelineOrchestrator`. Always lowercase. |
| **HITL** | Human-in-the-Loop. The approval gate after Pass 0 where a developer reviews and approves `.mmd` and `.gherkin` artifacts before code generation begins. |
| **Static Prefix** | The practice of placing stable files (contracts, specs) first in every agent context payload to maximise LLM provider-level KV cache hits. Always capitalised. |
| **Context Compaction** | Deleting per-pass error logs after a successful pass, preventing stale failure noise from polluting future context windows. Always capitalised. |
| **Agent Trampling** | When one agent unintentionally overwrites verified work from a previous pass by exceeding its declared scope. Prevented via file-glob permission locks in agent frontmatter. |
| **targetSymbols** | A map of `filePath → [qualified symbol names]` passed to each agent, identifying exactly which methods/classes were modified by upstream passes. Populated by `AstGrepSymbolResolver`. |
| **Context Compaction** | See above. |
| **Self-Correction Loop** | The retry mechanism (max 2 attempts) within a guarded pass. If the agent's output fails the test gate, the error log is fed back and the agent retries. Implemented in `createSelfCorrectionMachine`. |
| **Guarded Pass** | A pass that has an automated test gate (Passes 3–6). Failure triggers the Self-Correction Loop. |
| **Artifact-Driven Development** | The practice where `.mmd` (Mermaid diagrams) and `.gherkin` (BDD specs) are the primary source of truth; code is generated to satisfy them, not the reverse. |
| **DI (Dependency Injection)** | All infrastructure dependencies are injected into the core engine via interfaces. `src/core/` never imports from `src/infrastructure/`. |
| **Spec Drift** | When code diverges from its architectural diagrams or Gherkin specs. The pipeline's Pass 7 and HITL gate are the primary defences against spec drift. |
| **originalBaseSha** | The git SHA of the commit that existed before a pipeline run started. Stored in the session state file. Used by `--abort` to revert all AI-generated commits. |
| **OpenCode** | The AI coding agent CLI (`opencode`) that each pass sub-agent runs inside. Managed by `OpenCodeAgentRunner`. |
| **LiteLLM** | Self-hosted AI gateway proxy used for SSO auth, budget enforcement, DLP masking, and model routing. Runs in `infra/`. |
| **Context Payload** | The JSON object passed to each agent containing `featureName`, `paths`, `contextFiles`, `targetSymbols`, `fileChanges`, and `meta`. Constructed by `getAgentContextPayload`. |
