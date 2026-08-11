# Documentation & Wiki Style Guide

Both human contributors and AI coding assistants **MUST** follow these rules when creating or editing `.md` files in this repository.

---

## 1. Core Documentation Invariants

Every piece of documentation written in this repository must uphold these five fundamental invariants:

1. **Single Source of Truth:** `docs/` is the only valid directory for permanent, published documentation. The `artefacts/` directory is strictly for transient workspace items (in-progress plans, research, scratch notes).
2. **Zero Specification Drift:** Code and architecture specs (`.mmd` Mermaid diagrams, `.gherkin` specs) must remain synchronized. When logic changes, documentation and specifications MUST update in the same change set.
3. **Empirical Grounding:** Never document aspirational or planned features as existing facts. If a feature is deferred or planned, it MUST carry an explicit notice banner (e.g., `> [!NOTE] This feature is planned...`).
4. **Symbol & Link Anchoring:** Always link code references directly to source files using explicit line ranges (e.g. `[orchestrator.ts#L37-L61](../src/core/orchestrator.ts#L37-L61)`).
5. **Permanent ADR History:** Architectural Decision Records use immutable sequence numbers (`NNNN-title.md`). Superseded decisions are never deleted; they are converted into tombstone stubs pointing to the replacement ADR.

---

## 2. Writing Tone & Voice Guidelines

Documentation must be written with a distinct tone depending on the intended audience:

### 2.1 Executive & Architecture Tone (For CTOs, Team Leads, & Architects)
- **Voice:** Authoritative, strategic, declarative, and concise.
- **Focus:** Systems context, operational efficiency, financial/token impact, safety guardrails, and architectural trade-offs.
- **Format:** High-level C4 diagrams, summary tables, metric callouts (`> [!NOTE]`), and clear rationale ("The Decision" vs. "The Rationale").
- **Avoid:** Implementation nitpicks, temporary setup quirks, or verbose line-by-line code dumps.

### 2.2 Tactical & Engineering Tone (For Senior Engineers & Contributor Agents)
- **Voice:** Precise, unambiguous, prescriptive, and empirical.
- **Focus:** Concrete API contracts, DI interfaces, line-anchored file maps, state machine transitions, exact shell commands, and error handling.
- **Format:** Step-by-step numbered recipes, typed tables, code blocks with syntax highlighting, and explicit failure criteria.
- **Avoid:** Vague statements ("this module handles errors well"), undocumented side effects, or ungrounded assumptions.

### 2.3 Directives for AI Agents
- Use strict RFC 2119 keywords (**MUST**, **MUST NOT**, **SHOULD**, **REQUIRED**) when documenting rules for AI coding assistants.
- Keep instructions imperative and unambiguous to prevent prompt drift and hallucinated file locations.

---

## 3. Structure & Categorisation (Diátaxis Framework)

All documentation fits into one of four Diátaxis categories:

| Category | Target Directory | Primary Purpose | Tone / Style |
|---|---|---|---|
| **Tutorials** | `docs/tutorials/` | Step-by-step learning for newcomers | Guided, supportive, hands-on |
| **How-To Guides** | `docs/how-to/` | Practical, task-oriented recipes | Direct, prescriptive, step-by-step |
| **Reference** | `docs/api/` | Auto-generated API specs from JSDoc | Neutral, formal, type-accurate |
| **Explanation / Architecture** | `docs/architecture/` | Design rationale, ADRs, manifesto | Strategic, analytical, structural |

---

## 4. Master File Location Mappings

Use this master index to determine exact file paths and naming conventions for all documentation assets:

| Content Type | File Location | Naming Convention | Primary Purpose |
|---|---|---|---|
| **Documentation Style Guide** | `docs/STYLE_GUIDE.md` | `STYLE_GUIDE.md` | Single source of truth for documentation rules |
| **System Architecture Overview** | `docs/architecture/overview.md` | `overview.md` | Top-level system architecture, C4 diagrams |
| **Architectural Decision Records** | `docs/architecture/adrs/` | `NNNN-short-title.md` | Formal decision records (e.g. `0001-pure-core-engine.md`) |
| **Architecture Index & ADR List** | `docs/architecture/README.md` | `README.md` | Table of all ADRs and key design documents |
| **Domain Glossary** | `docs/architecture/glossary.md` | `glossary.md` | Single source of truth for project terminology |
| **Pass Reference Guides** | `docs/how-to/passes/` | `pass-N-name.md` | Detailed specs for pipeline passes 0–7 |
| **Operations & Debugging** | `docs/how-to/` | `debugging.md`, `observability.md` | Tactical guides for logging and troubleshooting |
| **API Reference (Generated)** | `docs/api/` | TypeDoc generated | Auto-generated from source JSDoc comments |
| **Document Templates** | `docs/templates/` | `<type>-template.md` | Reusable Markdown scaffolds for new docs |
| **In-Progress Wiki Prep** | `artefacts/documentation-prep/wiki/` | `wiki-structure.md` | Working drafts and wiki planning |
| **Transient Agent Work** | `artefacts/` | `Imp-Plan-*.md`, `Research-*.md` | Temporary scratch files & sub-agent plans |

### 4.1 Standard Document Templates (`docs/templates/`)

When drafting new documentation, agents and humans **MUST** copy and extend the appropriate template:

| Document Type | Template Path | Purpose |
|---|---|---|
| **Architecture / Component Doc** | [`docs/templates/architecture-doc-template.md`](./templates/architecture-doc-template.md) | High-level component overviews, C4 context, data flow, & code maps |
| **How-To Recipe** | [`docs/templates/how-to-template.md`](./templates/how-to-template.md) | Task-oriented guides with steps, commands, and troubleshooting |
| **Pass Reference** | [`docs/templates/pass-reference-template.md`](./templates/pass-reference-template.md) | Detailed specifications for individual agentic pipeline passes |
| **ADR (Decision Record)** | [`docs/templates/adr-template.md`](./templates/adr-template.md) | Formal architectural decisions & tombstone format |

---

## 5. Formatting & Presentation Rules

### 5.1 Markdown Standards
- Use ATX-style headers (`#`, `##`, `###`). Maximum header depth is **4 levels** (`####`).
- Maintain one blank line before and after headers, code blocks, tables, and alert boxes.
- Use standard GitHub alert blocks for emphasis:
  - `> [!NOTE]` — Background context or helpful explanation
  - `> [!TIP]` — Efficiency suggestions or best practices
  - `> [!IMPORTANT]` — Essential requirements or mandatory rules
  - `> [!WARNING]` — Potential risks or common pitfalls
  - `> [!CAUTION]` — Breaking changes or destructive actions

### 5.2 Diagrams
- All diagrams **MUST** use **Mermaid.js** fenced code blocks (` ```mermaid `).
- Do NOT embed external images or binary image files unless no Mermaid representation is possible.
- Prefer sequence diagrams (`sequenceDiagram`), state diagrams (`stateDiagram-v2`), and flowcharts (`graph TD/LR`).

### 5.3 Code References & Symbol Linking
- Always link to source files with explicit line anchors:
  `[orchestrator.ts#L37-L61](../src/core/orchestrator.ts#L37-L61)`
- Reference symbols using their fully qualified names (e.g. `PipelineOrchestrator.run()`).

---

## 6. Agent-Specific Writing Rules

AI coding assistants (Antigravity, Claude Code, Gemini CLI, etc.) **MUST** adhere to the following workflow when creating or modifying documentation:

### 6.1 Verification First
1. Query `codebase-memory-mcp` (`search_graph`, `get_code_snippet`) before writing to verify symbol signatures and file locations against the current codebase state.
2. Check existing files in `docs/` to update rather than duplicate documentation.
3. Check `docs/architecture/adrs/` for the next available sequence number before drafting a new ADR.

### 6.2 Accuracy & Status Tagging
- Never state aspirational or planned capabilities as working code.
- If a feature is planned, tag it with `> [!NOTE] Planned feature. See docs/roadmap.md`.

### 6.3 Doc Maintenance Trigger
When code changes occur:
1. Run `detect_changes` on `codebase-memory-mcp`.
2. Update all affected documentation pages and code link line anchors.
3. Update the ADR index in `docs/architecture/README.md` whenever ADR statuses change.

---

## 7. Architectural Decision Record (ADR) Lifecycle

New ADRs are created in `docs/architecture/adrs/` using [`docs/templates/adr-template.md`](./templates/adr-template.md).

```markdown
# NNNN. Short Title

* **Status:** Proposed | Accepted | Deprecated | Superseded by [NNNN](./NNNN-title.md)
* **Date:** YYYY-MM-DD
* **Deciders:** [@github-handle]

## Context
[Technical context, problem statement, and alternatives considered.]

## Decision
[Chosen architecture, pattern, or dependency, with links to source interfaces.]

## Consequences
### Positive
* [Benefit 1]

### Negative / Trade-offs
* [Trade-off 1]
```

### 7.1 Tombstone Policy for Superseded ADRs
Sequence numbers are permanent. When an ADR is superseded:
1. Create the new ADR file (e.g. `0009-new-approach.md`).
2. Replace the body of the older ADR with a **tombstone stub** pointing to the new ADR and git history:

```markdown
# NNNN. [SUPERSEDED] Old Title

* **Status:** Superseded by [ADR-XXXX](./XXXX-new-approach.md)
* **Reason:** [1-sentence rationale for the change]

> [!NOTE]
> This record is kept as a permanent tombstone for navigation stability.
> Full history: `git log --follow docs/architecture/adrs/NNNN-old-title.md`
```

---

## 8. Glossary & Domain Terminology

Project domain terms MUST be capitalized consistently according to [`docs/architecture/glossary.md`](./architecture/glossary.md):

| Term | Canonical Form | Usage Rule |
|---|---|---|
| Human-in-the-Loop | **HITL** | Use abbreviation after first mention |
| Static Prefix | **Static Prefix** | Always capitalized |
| Context Compaction | **Context Compaction** | Always capitalized |
| Agent Trampling | **Agent Trampling** | Always capitalized |
| pass | **pass** / **Pass N** | Lowercase when generic ("each pass"), capitalized when specific ("Pass 3") |
| pipeline | **pipeline** | Always lowercase |

---

## 9. Content Boundaries (What Does NOT Belong in Docs)

| ❌ Forbidden in `docs/` | ✅ Proper Location |
|---|---|
| In-progress agent plans & research drafts | `artefacts/` |
| Scratch notes & wiki preparation drafts | `artefacts/documentation-prep/` |
| Per-run execution logs & debug output | `.agentic-tdd/logs/` |
| Manually edited API signatures | `docs/api/` (auto-generated via TypeDoc) |
| Hardcoded environment secrets or API keys | `.env` (never committed) |
