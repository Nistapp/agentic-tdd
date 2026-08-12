# 6. Token Economy & Cost Control

> **Target Audience:** Users — CTOs, Team Leads, and Architects (budget stakeholders).
> **Status:** PLACEHOLDER — not yet drafted.
> **Source of truth for structure:** [wiki-structure.md §6](../../../artefacts/documentation-prep/wiki/wiki-structure.md).

---

## Outline

- **Static Prefix Caching:** contracts/specs placed first to maximise provider-level KV cache hits.
- **Context Compaction:** error logs deleted on success to keep contexts minimal.
- **LiteLLM Gateway:** SSO auth, budget enforcement (402 Payment Required).

---

## Existing material to mine

- ADR [0005 — Context Compaction](../adrs/0005-context-compaction.md).
- ADR [0006 — Static Prefix Ordering](../adrs/0006-context-control-optimisation.md).
- Manifesto [§2.1 LiteLLM + OpenRouter + SSO](../../architecture-manifesto.md).
- `docs/Note-on-context-mgmt.md` and `docs/agent-context-payloads.md`.
- Misc [E.6 — optimise context building for cache-hit](../../../artefacts/documentation-prep/wiki/Misc-stuff-to-include-in-wiki.md).

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| T-1 | Benchmark numbers | No measured token-savings figures for *this* framework yet (manifesto: "needs further benchmarking"). State this explicitly. External evidence to cite: [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp) and [arXiv:2603.27277](https://arxiv.org/abs/2603.27277) claim ~10× fewer tokens vs. file-by-file exploration (see P-1 on [page 1](01-why-this-exists.md)) — present as independent evidence, not a claim about agentic-tdd. |
| T-2 | LiteLLM status | Is the LiteLLM gateway actually shipped (`infra/docker-compose.yml` + `litellm_config.yaml`) or aspirational? Verify and mark accordingly. |
| T-3 | Static Prefix internals | Link to the actual ordering logic in `src/core/context-builder.ts` / `context-provider.ts`. |
