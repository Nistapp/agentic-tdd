# 0006. Static Prefix Ordering for Prompt Cache Hits

* **Status:** Deprecated — low priority, may no longer be relevant
* **Date:** 2026-07-01 (estimated)
* **Deciders:** @kcramakrishna

> [!NOTE] Deprecation
> Static Prefix caching has been **deprecated** pending further research. Each pass's agent file pins its own `model:` in YAML frontmatter — and per-pass model configuration at runtime is planned — so the value of engineering prefix-cache hits *across* passes is no longer clear. Tracked in [discussion #53 — "Static Prefix caching redundant?"](https://github.com/Nistapp/agentic-tdd/discussions/53). The feature is not lost to regression, but it is deferred until we establish whether it still helps in our context. Do not invest further in cache-hit ordering until that question is settled.

---

## Context

Every pass dispatches an LLM sub-agent with a payload that the harness builds deterministically: `StateContextProvider.build(ctx, pass)` assembles `{ files, targetSymbols, fileChanges }` ([`src/core/context-provider.ts#L11-L43`](../../../src/core/context-provider.ts#L11-L43)), `getAgentContextPayload` serialises it to the JSON prompt text ([`src/core/runners/shared.ts#L5-L29`](../../../src/core/runners/shared.ts#L5-L29)), and `buildArtefacts` attaches `--file` artefacts ([`src/core/runners/shared.ts#L31-L68`](../../../src/core/runners/shared.ts#L31-L68)). The whole request is handed to the harness by `OpenCodeAgentRunner.#buildArgs` ([`src/infrastructure/open-code-agent-runner.ts#L42-L69`](../../../src/infrastructure/open-code-agent-runner.ts#L42-L69)).

Most LLM providers bill **prompt / KV caching**: if two requests share a long, byte-identical **prefix**, the cached portion is served at a discount and with lower latency. Consecutive passes are structurally well suited to this: the agent prompt file is identical for a given pass, the payload JSON has stable fields, and stable artefacts (contracts/specs) recur across later passes. The opportunity was to make the shared prefix as long as possible by ordering each pass's context so that **stable content comes first** — a "Static Prefix".

The risk without explicit ordering discipline was that cache hits become **accidental**: the payload's key order and the `files`/`targetSymbols`/`fileChanges` content drift as `ctx.history` grows, silently shaving the shared prefix and costing tokens and latency with no visible failure.

> [!IMPORTANT] Scope of what the harness can actually order
> `contextFiles` are **filename hints, not injected file contents** — the agent reads the files itself with `read`/`glob`/`grep`. The prefix the harness controls covers the agent prompt + payload JSON + `--file` attachments; it does **not** cover the file contents the agent pulls in later. See [3. Context Engineering — Overview](../contributor-deep-dive/03-context-engineering.md#overview). Static Prefix could only ever guarantee the *head* of the request, not the whole token stream.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **No ordering discipline (status quo)** | Rejected — cache hits are accidental; payload shape drifts with `history`, so the shared prefix is unstable and uncounted. |
| **Static Prefix ordering** | **Chosen (then deprecated)** — deterministic, stable-first file ordering to maximise provider-level cache reuse across passes. |
| **Dynamic relevance-first ordering** (recently-changed files first per pass) | Rejected — maximises per-pass quality but destroys prefix stability, defeating the cache; it is the opposite optimisation. |
| **Context Compaction** (delete stale error logs on pass success) | Complementary, not a replacement — compaction removes **tail** noise, Static Prefix stabilises the **head**. Compaction is the surviving, shipped lever ([ADR-0005](./0005-context-compaction.md)). |

---

## Decision

Adopt **Static Prefix ordering**: each pass's context is assembled **deterministically** with the most stable, cacheable content placed first, so consecutive passes sharing the same model maximise the provider-level KV-cache hit.

The implementation vehicle is the per-pass selection table `CONTEXT_RULES` ([`src/core/context-builder.ts#L10-L83`](../../../src/core/context-builder.ts#L10-L83)), which declares, for every pass, which upstream pass outputs appear in `files.contracts` / `files.tests` / `files.implementation` and which upstream passes' `targetSymbols`/`fileChanges` are merged (`target`). This enforces the pipeline invariant **"N's output is N+1's read-only context"** and gives the payload a stable, categorised ordering (contracts → tests → implementation) resolved by `buildContextFiles` ([`context-builder.ts#L101-L115`](../../../src/core/context-builder.ts#L101-L115)) and `buildTargetPasses` ([`context-builder.ts#L121-L130`](../../../src/core/context-builder.ts#L121-L130)).

The full path that realises (and today, still reflects) the decision:

| Stage | Where | Role |
|---|---|---|
| 1. Selection & ordering | `CONTEXT_RULES` ([`context-builder.ts#L10-L83`](../../../src/core/context-builder.ts#L10-L83)) | Declarative, per-pass, stable file ordering (contracts/tests/implementation). |
| 2. Payload assembly | `StateContextProvider.build` ([`context-provider.ts#L11-L43`](../../../src/core/context-provider.ts#L11-L43)) | Pure, synchronous assembler — deterministic `{ files, targetSymbols, fileChanges }`. |
| 3. Serialisation | `getAgentContextPayload` ([`src/core/runners/shared.ts#L5-L29`](../../../src/core/runners/shared.ts#L5-L29)) | Fixed-key JSON; stable serialisation of the curated payload. |
| 4. Invocation | `OpenCodeAgentRunner.#buildArgs` ([`src/infrastructure/open-code-agent-runner.ts#L42-L69`](../../../src/infrastructure/open-code-agent-runner.ts#L42-L69)) | `opencode run --agent pass-N --file <artefacts> <prompt>` — the byte-prefix boundary. |
| 5. (Surface) | `TerminalRenderer.banner` ([`src/cli/terminal-renderer.ts#L71`](../../../src/cli/terminal-renderer.ts#L71)) | Still prints `Cache strategy: Static Prefix  +  Context Compaction` — a leftover of the two-lever strategy. |

**Deprecation rationale (current status).** Each pass agent pins its own `model:` in its YAML frontmatter (e.g. [`pass-3-core-implementation-agent.md#L8-L11`](../../../src/agents/pass-3-core-implementation-agent.md#L8-L11)), and `#logPreFlight` reads it back for observability ([`open-code-agent-runner.ts#L71-L91`](../../../src/infrastructure/open-code-agent-runner.ts#L71-L91)). Once passes run **different models/providers** — each with its own KV cache and tokenizer — a prefix built for pass N does not hit in pass N+1. Runtime per-pass model configuration is planned (see [5. Agent Prompt System §3.2](../user-overview/05-agent-prompt-system.md#32-overriding-the-routing)); the value of prefix engineering depends on model homogeneity, which is no longer guaranteed. The decision is therefore **deferred, not reverted** — `CONTEXT_RULES` ordering remains, but cache-hit engineering is not a design goal until [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53) is resolved.

---

## Consequences

### Positive

* **Deterministic, cacheable prompts** — stable key order + categorised, ordered file lists make the request head reproducible across passes (and across retries of the same pass).
* **Declarative single source of truth** — `CONTEXT_RULES` is the one table that defines what each pass sees; no per-pass bespoke code ([`context-builder.ts#L10-L83`](../../../src/core/context-builder.ts#L10-L83)).
* **Complementary to Context Compaction** — a stable *head* (Static Prefix) plus a clean *tail* (compaction, [ADR-0005](./0005-context-compaction.md)) together control attention drift and context rot while managing cost.
* **Zero runtime cost** — pure ordering at build time; no extra I/O, no per-run overhead.

### Negative / Trade-offs

* **File ordering is a hidden contract** — changes to `CONTEXT_RULES` ordering can silently break cross-pass cache hits; the only symptom is a cost/latency regression, not a test failure.
* **Prefix reach is limited** — `contextFiles` are filename hints the agent reads itself, so the harness controls only the prompt/payload/`--file` head, never the full token stream the model processes.
* **Model/provider dependence** — cache hits require the same model (and provider cache policy/TTL) across consecutive passes; per-pass model config undermines the premise — see [discussion #53](https://github.com/Nistapp/agentic-tdd/discussions/53).
* **Unquantified benefit** — no measured token/latency savings; the rationale is qualitative (see placeholder P-1).
* **Leftover surface** — the `Cache strategy` banner in `TerminalRenderer.banner` still advertises Static Prefix after deprecation ([`src/cli/terminal-renderer.ts#L71`](../../../src/cli/terminal-renderer.ts#L71)).

---

## Placeholders / Open Items

| # | Topic | What is missing |
|---|---|---|
| P-1 | Savings quantification | No measured data on how many tokens/latency Static Prefix saved; the benefit is qualitative, and the cost of the "hidden contract" is unobserved. |
| P-2 | Discussion #53 resolution | The deprecation is pending research on whether prefix-cache ordering still helps with per-pass LLM config. Until resolved, no further cache-hit investment. |
| P-3 | Runtime per-pass model config | The feature that "each pass can be configured with its own LLM" is **planned, not shipped** — today all pass files pin DeepSeek in frontmatter. The deprecation premise is aspirational until the config file + `--model` flag land. |
| P-4 | Banner drift | `TerminalRenderer.banner` still prints `Cache strategy: Static Prefix + Context Compaction`; decide whether to keep or update once the deprecation is finalised. |
| P-5 | Decision date & deciders | Date is estimated (2026-07-01); no decider GitHub handles are recorded. |
