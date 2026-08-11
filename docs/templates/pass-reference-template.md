# Pass Reference: Pass [N] — [Pass Name]

> **Agent Persona:** [e.g., The Architect / The SRE / The Red Team]  
> **Default Model:** [e.g., Claude 3.7 Sonnet / DeepSeek v4 / Gemini Flash]

---

## 1. Pass Purpose & Scope

- **Objective:** [What does this pass produce or modify?]
- **Guard Type:** [Guarded (has automated test gate) | Unguarded]
- **Atomic Commit Format:** `chore(ai): pass-[N] – [short summary]`

---

## 2. Context Ingestion & Visibility

The agent executing Pass [N] receives the base payload plus the following context files:

| Context Category | Visibility Rule | Purpose |
|---|---|---|
| **Contracts** | [Included / Excluded] | Interfaces and types |
| **Tests** | [Included / Excluded] | Test suites from Pass 2 |
| **Implementation** | [Included / Excluded] | Code from previous passes |

---

## 3. Allowed & Forbidden Operations

### Allowed Writes
- [ ] `[file/glob pattern 1]`
- [ ] `[file/glob pattern 2]`

### Forbidden Actions
- ❌ Do NOT modify existing algorithmic logic (if non-core pass).
- ❌ Do NOT alter files outside declared permission scopes.

---

## 4. Verification Gate & Self-Correction

- **Test Gate Command:** `[e.g., npm test]`
- **Success Criteria:** [e.g., 0 failing unit tests]
- **Self-Correction Behavior:** Max 2 retries. Error log injected via `paths.errorLog`.
