# Agent Context Payloads

This document outlines the full details of what is passed to each individual agent at each stage of the 8-pass agentic TDD pipeline. It serves as a reference for ongoing optimisations, token context management, and future debugging.

Every agent receives a **base payload** containing the fundamental knowledge required for the context, plus a **dynamically constructed list of files (`contextFiles`)** that grows and shrinks based on the needs of the current pass.

## 1. The Base Payload (Passed to ALL Agents)
Regardless of the pass, every agent receives the following JSON payload, constructed in `src/core/runners/shared.ts` by the `getAgentContextPayload` function:

```json
{
  "featureName": "Name of the issue or feature",
  "featureDescription": "Raw text of the feature specification",
  "pipelineVersion": "Pipeline orchestrator version string",
  "paths": {
    "designMmd": "/absolute/path/to/design.mmd",
    "specGherkin": "/absolute/path/to/spec.gherkin",
    "errorLog": "/absolute/path/to/error.log"
  },
  "contextFiles": {
    "contracts": [],
    "tests": [],
    "implementation": []
  },
  "targetSymbols": {},
  "fileChanges": {},
  "meta": {}
}
```

### Key Elements:
*   **`featureName`**: The name of the feature or issue.
*   **`featureDescription`**: The raw text of the feature specification.
*   **`pipelineVersion`**: The pipeline orchestrator version.
*   **`paths`**: Hard paths to key specification artifacts so the agent knows where to read/write:
    *   `designMmd`: Path for the design Mermaid diagram.
    *   `specGherkin`: Path for the Gherkin specifications.
    *   `errorLog`: Path to the error log (read by agents during self-correction).
*   **`targetSymbols`**: A map of `filePath → [qualified method/symbol names]` changed by upstream passes. Tells the agent *which* symbols were touched.
*   **`fileChanges`**: A per-file map of precise change descriptors for edits to **existing** files/symbols. Each entry records:
    *   `commitHash` — the SHA of the pass commit that introduced the change (use `git show <sha>:<file>` for the exact state).
    *   `kind` — `new-file` or `edited-file`.
    *   `hunks` — one entry per changed region with:
        *   `range` — 1-based line range in the new file.
        *   `kind` — `added` / `modified` / `deleted`.
        *   `addedLines` / `removedLines` — line counts.
        *   `symbols` — enclosing symbol names (incl. test-style names like `describe('Foo') › it('edge case')`).
        *   `anchor` — a short snippet of the added lines, drift-resistant for locating the edit after later passes shift line numbers.
*   **`meta`**: Empty by default, but if the pass fails and falls back to the self-correction state machine, this will contain `{ "attemptNumber": <number> }` so the agent knows it is retrying a failed task.

---

## 2. Context Files by Pass (`contextFiles`)
To minimize token costs (Context Compaction), the orchestrator strategically determines which files an agent actually needs to see based on the `CONTEXT_RULES` mapped in `src/core/context-builder.ts`. 

Here is exactly what files are passed into the `contextFiles` array for each pass:

### **Pass 0 (Design)**
*   `contracts`: `[]`
*   `tests`: `[]`
*   `implementation`: `[]`
> **Note**: Agent only relies on the `featureDescription` to generate the initial MMD/Gherkin designs.

### **Pass 1 (Contracts)**
*   `contracts`: `[]`
*   `tests`: `[]`
*   `implementation`: `[]`
> **Note**: Agent creates the initial TS interfaces based on the design artifacts.

### **Pass 2 (Test Generation)**
*   `contracts`: Files generated/touched in **Pass 1**
*   `tests`: `[]`
*   `implementation`: `[]`
> **Note**: Agent needs the interfaces/contracts to write the Vitest suites, but no implementation exists yet.

### **Pass 3 (Core Implementation)**
*   `contracts`: Files generated/touched in **Pass 1**
*   `tests`: Files generated/touched in **Pass 2**
*   `implementation`: `[]`
> **Note**: Agent needs both the interfaces and the failing tests to implement the core logic.

### **Pass 4 (Refactor)**
*   `contracts`: `[]`
*   `tests`: Files generated/touched in **Pass 2**
*   `implementation`: Files generated/touched in **Pass 3**
> **Note**: Agent needs the tests to ensure refactoring doesn't break anything, and the core implementation files to actually refactor.

### **Pass 5 (Observability)**
*   `contracts`: `[]`
*   `tests`: Files generated/touched in **Pass 2**
*   `implementation`: Files generated/touched in **Pass 3** and **Pass 4**
> **Note**: Agent needs the tests and all implementation files (including refactored ones) to instrument logging and metrics.

### **Pass 6 (Security)**
*   `contracts`: `[]`
*   `tests`: Files generated/touched in **Pass 2**
*   `implementation`: Files generated/touched in **Pass 3** and **Pass 4**
> **Note**: Agent needs the tests and all implementation files (including refactored ones) to audit and apply security constraints.

### **Pass 7 (Documentation)**
*   `contracts`: `[]`
*   `tests`: `[]`
*   `implementation`: Files generated/touched in **Pass 3, Pass 4, Pass 5, and Pass 6**
> **Note**: Agent reads the sum total of all the implementation files produced across the previous implementation/refactoring/security/observability passes to generate accurate JSDocs and architectural manifestos. Tests and contracts are dropped to save tokens.
