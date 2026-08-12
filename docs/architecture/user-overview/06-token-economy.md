# 6. Token Economy & Cost Control

> **Target Audience:** Users — CTOs, Team Leads, and Architects (budget stakeholders).
> **Status:** DRAFT — overview; deep context-engineering detail in the Contributor Track.

---

## The Cost Problem

Every agent invocation burns tokens for two things: the **context window** (what the agent is shown) and the **conversation** (what the agent does with it). Uncontrolled agentic workflows waste tokens by stuffing huge context windows and repeating failed attempts. agentic-tdd attacks both.

## Static Prefix Caching

Contracts and specs are placed **first** in every context payload so that provider-level **KV cache hits** are maximised across passes — the same stable prefix is reused run to run, and only the (small) variable tail differs. See [ADR-0006 — Static Prefix Ordering](../adrs/0006-context-control-optimisation.md).

## Context Compaction

Per-pass error logs are **deleted on pass success** — so a retry of a later pass never inherits stale failure noise, and the context stays minimal. See [ADR-0005 — Context Compaction](../adrs/0005-context-compaction.md).

## Context Engineering (the deeper lever)

Beyond caching, the harness does **not** dump files into the window. Each pass receives a curated `BuiltContext` — which upstream files to read, which symbols changed, and precise anchored change descriptors — selected by `CONTEXT_RULES`. This is the real token saver: **surgical context instead of context stuffing**.

> [!TIP]
> See **[10. Context Engineering (Contributor)](../contributor-deep-dive/10-context-engineering.md)** for how `context-builder.ts` selects per-pass files and symbols.

## LiteLLM Gateway

An optional LiteLLM proxy (`infra/docker-compose.yml`) can enforce SSO auth and hard budget caps (402 Payment Required) for enterprise deployments.

> [!NOTE] Benchmark honesty
> We have **no measured token-savings figures for this framework yet**. Independent studies on code-graph-based exploration ([codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp), [arXiv:2603.27277](https://arxiv.org/abs/2603.27277)) report ~10× fewer tokens vs. file-by-file exploration — cite these as external evidence, not as a claim about agentic-tdd.

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| T-1 | Benchmark numbers | Own benchmarks for agentic-tdd (see note above). |
| T-2 | LiteLLM status | Verify whether `infra/docker-compose.yml` + `litellm_config.yaml` are shipped or aspirational. |
