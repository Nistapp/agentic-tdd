# 5. Agent Prompt System & Routing

> **Target Audience:** Users — CTOs, Team Leads, and Architects.
> **Status:** PLACEHOLDER — not yet drafted.
> **Source of truth for structure:** [wiki-structure.md §5](../../../artefacts/documentation-prep/wiki/wiki-structure.md).

---

## Outline

- **Architecture:** Markdown files with YAML frontmatter dictating tools and scope.
- **Scope Guardrails:** file-glob permissions prevent "Agent Trampling".
- **Routing Strategy:** Static per-pass model in the shipped agent files; user-overridable by editing `src/agents/pass-*.md`; a user-facing config file is planned. The manifesto's "Sonnet for design, DeepSeek for logic, Flash for docs, GPT-4.5 for security" is aspirational (see P-2 on [page 1](01-why-this-exists.md)).

---

## Existing material to mine

- Agent files: `src/agents/pass-*.md` (YAML frontmatter: `model`, `permission`, `description`).
- Guardrail design: [architecture-manifesto.md §4](../../architecture-manifesto.md).
- Harness-independence & delegation: [Misc-stuff §A.1](../../../artefacts/documentation-prep/wiki/Misc-stuff-to-include-in-wiki.md), [Misc-stuff §B.5](../../../artefacts/documentation-prep/wiki/Misc-stuff-to-include-in-wiki.md).

> [!NOTE] Resolution (P-2 on page 1)
> Routing is **static** in the shipped `src/agents/pass-*.md` files, currently pinning `deepseek-v4-pro` (docs → `deepseek-v4-flash`). Users override per-pass models by editing those files; a **config file** for easier configuration is planned for a future version. Present the shipped config as the source of truth and mark the manifesto routing as aspirational.

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| R-1 | Permission model | Document the exact `permission:` blocks per pass (read/edit/glob/grep, bash/webfetch/task deny). |
| R-2 | Model routing truth | Confirm the exact current `model:` value per pass and the override-by-editing workflow. |
