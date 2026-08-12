# 5. Agent Prompt System & Routing

> **Target Audience:** Users — CTOs, Team Leads, and Architects.
> **Status:** DRAFT — overview; full prompt-engineering detail in the Contributor Track.

---

## How Agents Are Defined

Each of the 8 passes is driven by a **Markdown agent file** in `src/agents/pass-{0..7}-*.md`. A file has two jobs:

1. **Declarative configuration** (YAML frontmatter): which model runs the pass, and which tools the agent may use.
2. **The instruction set** (the body): the agent's role, rules, scope, and output contract — written in strict XML sections so the model never confuses a code comment for an instruction (prompt-injection defence).

## Scope Guardrails

Every agent's frontmatter **denies** `bash`, `webfetch`, and `task`, and only permits `read`/`edit`/`glob`/`grep`. Combined with per-pass write scope, this prevents **Agent Trampling** — one pass silently undoing another pass's verified work.

> [!TIP]
> The user-overview takeaway: agents are **powerful but scoped**. They can read and edit files, but they cannot run arbitrary commands, reach the network, or spawn sub-agents. See the [Engineering Concepts map](08-engineering-concepts.md) for the full vocabulary.

## Routing Strategy

Routing is **static** in the shipped agent files: Passes 0–6 run `deepseek/deepseek-v4-pro`; Pass 7 (documentation) runs `deepseek/deepseek-v4-flash`. Users can override per-pass models by editing `src/agents/pass-*.md`; a user-facing **config file** is planned.

> [!NOTE] Aspirational vs shipped
> The widely-cited "Sonnet for design, DeepSeek for logic, Flash for docs, GPT-4.5 for security" routing is **aspirational**, not what ships. The shipped `model:` fields above are the source of truth (see P-2 on [page 1](01-why-this-exists.md)).

---

## Deep Dive

For the full prompt-engineering detail — file anatomy, the directive catalogue (`assess-first`, `indexer-first`, `target-symbols-priority`, `use-file-changes`), per-pass separation-of-concerns rules, and the `SKIP:` protocol — see **[9. Prompt Engineering (Contributor)](../contributor-deep-dive/09-prompt-engineering.md)**.

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| R-2 | Model routing truth | Re-confirm exact current `model:` per pass when agent files change. |
