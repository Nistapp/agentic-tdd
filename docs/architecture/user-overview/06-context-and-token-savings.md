# 6. Context Engineering — Code Indexing First, Token Savings as a Side-Effect

> **Target Audience:** Users — CTOs, Team Leads, and Architects (budget & quality stakeholders).
> **Key Goal:** Explain how agentic-tdd builds *accurate* context for each pass — via code indexing and curated change descriptors, not by letting the LLM search files by itself — and why that accuracy is the primary goal, with significant token savings as a deliberate side-effect.
> **Status:** Draft — wiki page 6 of the User Overview. Grounded in `src/core/context-builder.ts`, `src/core/runners/shared.ts`, `src/infrastructure/ast-grep-symbol-resolver.ts`, and the `indexer-first` directive in `src/agents/pass-*.md`; deep context-engineering detail is in the Contributor Track.

---

## Executive Summary

GenAI performance is a function of **context quality**. Too little context and the LLM cannot reason; too much, and it "loses the plot", hallucinates, and burns money.

The naive approach — hand the model the whole repo and let it `grep`/`read` its way around — is both *inaccurate* and *expensive*. The model drifts, invents non-existent APIs, and spends hundreds of tool calls just finding files. agentic-tdd inverts this: **the harness builds the context, and the model consumes it.**

Instead of the LLM searching files itself, the pipeline gives each pass:

1. **An index-first mandate** — the agent MUST prefer the `codebase-memory-mcp` knowledge graph (semantic/AST index of the whole repo) over text-pattern searching. It reasons from *structure* — call chains, coupling, existing symbols — not from grep matches.
2. **A curated, per-pass payload** — `CONTEXT_RULES` selects exactly which upstream files the pass sees, plus `targetSymbols`/`fileChanges`: *precisely what changed, where, and how*, with drift-resistant anchors — so the agent starts at the exact code that matters and never rescans the repo.

> [!IMPORTANT]
> The thesis of this page: **accurate context → accurate output.** The token savings — fewer file reads, fewer reasoning iterations, fewer self-correction retries — are a *consequence* of accuracy, not the design goal itself. We optimise for the right context; the cost reduction follows.

---

## 1. The Problem: Letting the LLM Search Files by Itself

When an agent is pointed at a large repo and told to "find what's relevant", three failure modes compound:

| Failure mode | Mechanism | Consequence |
|---|---|---|
| **Context bloat** | Dumps whole files / entire codebases into the window | "Lost in the middle" attention drift; high token cost |
| **Hallucinated structure** | Grep text matches don't reveal call chains or coupling | Agent invents non-existent APIs, duplicates existing utilities, misjudges blast radius |
| **Speculative iteration** | Wrong starting point → wrong code → failing tests → retry | Multiple LLM reasoning cycles burned on a fixable *context* problem |

The classic symptom of a context-poor agent loop: it *reads a lot*, *reasons a lot*, and *still misses*. The root cause is rarely the model — it is that the model was asked to be its own indexer.

> [!NOTE] Known limits of file-searching agents
> Independent studies on code-graph-based exploration ([codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp), [arXiv:2603.27277](https://arxiv.org/abs/2603.27277)) report ~10× fewer tokens and ~2.1× fewer tool calls vs. file-by-file exploration across 31 real repos. Treat these as external evidence, not a claim about agentic-tdd (see [1. § P-1](01-why-this-exists.md)).

---

## 2. The Answer: Index-First Context Building

agentic-tdd solves this with two complementary mechanisms — a **knowledge graph** (the index) and a **curated payload** (what each pass is told to look at).

### 2.1 The knowledge graph: `codebase-memory-mcp`

The pipeline delegates code indexing to `codebase-memory-mcp` ([opencode.json#L16-L21](../../../opencode.json#L16-L21)) — a semantic/AST index of the entire repository. This was a deliberate architecture decision (see [2. § B.4](02-high-level-architecture.md#3-key-architectural-decisions)):

- **Why not opencode's inbuilt indexer?** Independence from any single harness — this critical piece must not couple us to opencode.
- **Why it matters:** the index answers *structural* questions — who calls this function, what is coupled to it, does this symbol already exist — without a single `grep`.

Every pass prompt carries the **`indexer-first`** directive ([`pass-0-design-agent.md#L56`](../../../src/agents/pass-0-design-agent.md#L56)):

> If an indexer, knowledge graph, or MCP server is referenced, verify its index is current (`detect_changes` / `index_status`) and re-index if needed before relying on it. Also check for available MCP tools … Fall back to read/glob/grep only when no indexer is available.

So the agent's *first* move is to query the graph, and file-searching is the fallback — not the other way around. This is the accuracy lever: the agent starts from verified structure instead of guessing.

### 2.2 The curated payload: `CONTEXT_RULES`

The orchestrator also tells each pass *exactly which files matter*, via a declarative per-pass table ([`src/core/context-builder.ts#L10-L83`](../../../src/core/context-builder.ts#L10-L83)). This enforces the pipeline invariant **"N's output is N+1's read-only context"**:

| Pass | Context it receives |
|---|---|
| 2 Test Generation | Pass 1 contracts |
| 3 Core Implementation | Pass 1 contracts + Pass 2 tests |
| 4 Refactor | Pass 2 tests + Pass 3 implementation |
| 5 Observability | Pass 4 implementation |
| 6 Security | Pass 4 implementation |
| 7 Documentation | Pass 3,4,5,6 implementation |

The result is **surgical context instead of context stuffing**: each agent sees only the upstream artefacts it is directly responsible for honouring. See [10. Context Engineering § 1 (Contributor)](../contributor-deep-dive/10-context-engineering.md#1-context_rules--the-per-pass-selection-table) for the full table.

---

## 3. Precision Change Descriptors — Where, Not What

Knowing *which files* changed is not enough; the agent also needs to know *what exactly* changed in them. After each pass commits, the engine resolves the diff into **anchored, symbol-level change descriptors** ([`src/infrastructure/ast-grep-symbol-resolver.ts#L231`](../../../src/infrastructure/ast-grep-symbol-resolver.ts#L231)):

| Field | Meaning |
|---|---|
| `targetSymbols` | `filePath → [qualified symbol names]` that upstream passes changed |
| `fileChanges` | Per-file map of hunks: line range, `added`/`modified`/`deleted`, enclosing symbol name, an anchor snippet, and the introducing commit SHA |

These travel in the JSON payload built by [`getAgentContextPayload`](../../../src/core/runners/shared.ts#L5-L29) and are attached as `--file` artefacts by [`buildArtefacts`](../../../src/core/runners/shared.ts#L31-L68).

The `use-file-changes` directive tells the agent to navigate by these **anchors** — the enclosing symbol + snippet — rather than absolute line numbers, because later passes can shift lines. The agent lands directly on the changed function, with the exact commit state available via `git show <sha>:<file>`. No blind rescanning, no "where do I even start?"

> [!NOTE] Anchors are drift-resistant
> Absolute line numbers are treated as best-effort hints; the **anchor snippet** survives later edits. This is what lets pass 6 review *exactly* what pass 5 added to a file that passes 3 and 4 also touched.

### 3.1 Worked example — a real session state file

The [`fileChanges` example state file](../examples/example-state-file.json) is a verbatim record from a real pipeline run (`featureName: "Prompt-4"`, a Tkinter GUI view). It shows exactly what `history[pass].fileChanges` contains as the passes progress — and why the next pass never needs to re-scan the repo.

Take Pass 6 (Security Hardening). The agent was told to review *only what Pass 5 changed* in `src/tictactoe/gui.py`. The state file gave it these precise, anchored change descriptors:

```json
"src/tictactoe/gui.py": {
  "commitHash": "3263565cfb5215d9e5467c785d006d0a5c695ae1",
  "kind": "edited-file",
  "hunks": [
    {
      "range": { "start": 222, "end": 226 },
      "kind": "added",
      "addedLines": 5,
      "removedLines": 0,
      "anchor": "        # SEC: A04 — reject None presenter at function boundary\n        if presenter is None:\n            _security_logger.warning(\"Rejected set_presenter with None presenter\")\n            raise TypeError(\"presenter must not be None\")"
    },
    {
      "range": { "start": 376, "end": 408 },
      "kind": "added",
      "addedLines": 33,
      "removedLines": 0,
      "anchor": "        # SEC: A04 — validate inputs at function boundary (fail-fast)\n        if not isinstance(row, int):\n            _security_logger.warning(...)"
    }
  ]
}
```

Notice three things:

1. **It's scoped, not exhaustive.** The entry describes a handful of hunks (line ranges + `added`/`modified` counts) — not the whole 500-line file. The agent knows *exactly which lines* to re-audit.
2. **The anchor is a snippet, not a line number.** `range.start: 222` is a hint; the anchor text is what survives edits. Compare Pass 5's own record (line 40–473, with `_module_logger.info(...)` anchors) to Pass 6's — the line numbers shifted, but the anchors still point at the same code.
3. **It carries provenance.** The `commitHash` means the agent can retrieve the exact state via `git show 3263565c:src/tictactoe/gui.py` — no guessing about which version it is auditing.

The full file walks all 7 passes (specs → contracts → tests → implementation → refactor → observability → security), and you can see the descriptor *chase the changes* from pass to pass — the pipeline equivalent of handing each reviewer a marked-up diff instead of the whole codebase. This is why the agent reasons fewer times, reads less, and corrects itself less.

> [!TIP]
> Read the whole file — it is short and annotated by the pipeline itself: [`docs/architecture/examples/example-state-file.json`](../examples/example-state-file.json).

---

## 4. Token Savings as a Side-Effect

When context is accurate, costs fall *mechanically*:

| Side-effect | Mechanism | Why it happens |
|---|---|---|
| **Fewer file reads** | Agent queries the graph and reads only the payload-listed files | It already knows where the change is |
| **Fewer reasoning iterations** | Starts from verified structure, not guesswork | No speculative "find it yourself" loops |
| **Fewer self-correction retries** | Right context → right code → tests pass first time | Retries (up to 3) are for real failures, not context misses |
| **Context Compaction** | Per-pass error logs deleted on success | See [ADR-0005](../adrs/0005-context-compaction.md) & [10. § 5](../contributor-deep-dive/10-context-engineering.md#5-context-compaction-adr-0005) |
| **SKIP protocol** | `assess-first` lets a pass declare a no-op (`SKIP:N:reason`) | No wasted tokens on already-satisfied passes ([`src/core/skip-parser.ts`](../../../src/core/skip-parser.ts)) |

> [!NOTE] Static Prefix caching is deprecated
> An earlier cost lever — **Static Prefix** (ordering stable files first to maximise provider KV-cache hits, [ADR-0006](../adrs/0006-context-control-optimisation.md)) — is **deprecated / low priority**. Each pass can now be configured with its own LLM, and whether prefix engineering still helps is under research — see [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53). The savings above do **not** depend on it.

Each of these individually saves tokens; together, with accuracy as the driver, they compound. But note the framing: **we never optimised for tokens first** — we optimised for the agent seeing exactly what it needs, and the waste simply disappeared.

> [!TIP]
> This is also why verification is **token-free**: the test gate runs on your local machine, not through an LLM ([1. § 2.1](01-why-this-exists.md#21-deterministic-verification-of-non-deterministic-generation)). We do not pay model tokens to check the model's work.

---

## 5. The LiteLLM Gateway (Cost Enforcement, Optional)

For enterprise budget control, an optional LiteLLM proxy (`infra/docker-compose.yml`, `infra/litellm_config.yaml`) can enforce SSO auth and hard budget caps (HTTP 402). This is **orthogonal** to the accuracy story above — it caps spend at the gateway; context engineering reduces the spend in the first place.

> [!NOTE] LiteLLM status
> The `infra/` configs exist; verify whether the SSO/budget features are exercised anywhere (see [2. § H-1](02-high-level-architecture.md) and [16. ADRs & Roadmap](../contributor-deep-dive/16-adrs-roadmap.md)).

---

## 6. What This Means for Evaluators

| Question | Answer |
|---|---|
| **Why should I trust the output?** | Because the agent starts from a verified knowledge graph + precise change descriptors, not from guessing which files matter. Structure-first context reduces hallucination and duplicate utilities at the source. |
| **Is the model "smarter"?** | No — the *context* is better. Same model, less searching, more accurate edits. |
| **Is the token saving real?** | Mechanically yes: fewer reads, fewer iterations, fewer retries, token-free verification. We have no own benchmarks yet — see [Placeholders](#placeholders--open-questions). |
| **Do I lose control?** | No — the payload is a *starting point*; the `indexer-first` rule actively encourages the agent to supplement it with its own structural exploration (see [docs/Note-on-context-mgmt.md](../../../docs/Note-on-context-mgmt.md)). |

---

## Deep Dive (Contributor Track)

| Topic | Where |
|---|---|
| `CONTEXT_RULES`, `StateContextProvider`, payload & artefact construction | [10. Context Engineering](../contributor-deep-dive/10-context-engineering.md) |
| Context Compaction (ADR-0005) | [10. § 5](../contributor-deep-dive/10-context-engineering.md#5-context-compaction-adr-0005) · [ADR-0005](../adrs/0005-context-compaction.md) |
| AST-grep symbol resolution & anchored change descriptors | [10. § 6](../contributor-deep-dive/10-context-engineering.md#6-context-enrichment--anchored-change-descriptors) · [ADR-0007](../adrs/0007-ast-grep-symbol-resolver.md) |
| How agents consume context (`indexer-first`, `use-file-changes`) | [9. Prompt Engineering § 3](../contributor-deep-dive/09-prompt-engineering.md#3-the-directive-catalogue-cross-pass-patterns) |

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| C-1 | Benchmark numbers | Own token-savings figures for agentic-tdd; today we cite external studies only. |
| C-2 | LiteLLM status | Verify whether `infra/docker-compose.yml` + `litellm_config.yaml` SSO/budget features are shipped or aspirational. |
| C-3 | Static Prefix caching (deprecated) | Whether prefix engineering still helps given per-pass LLM config is under research — [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53). Re-evaluate before investing. |

---

## Related Pages

- Previous: [5. Agent Prompt System & Routing](05-agent-prompt-system.md)
- Next: [7. Security Model & Sandboxing](07-security-model.md)
- Deep dives: [10. Context Engineering](../contributor-deep-dive/10-context-engineering.md) · [9. Prompt Engineering](../contributor-deep-dive/09-prompt-engineering.md)
- ADRs: [0005 Context Compaction](../adrs/0005-context-compaction.md) · [0007 AST-Grep Resolver](../adrs/0007-ast-grep-symbol-resolver.md) · [0006 Static Prefix (deprecated)](../adrs/0006-context-control-optimisation.md)
- Related: [1. Why This Exists § 2.4](01-why-this-exists.md#24-reducing-the-non-determinism-of-genai) · [8. Engineering Concepts](08-engineering-concepts.md)
