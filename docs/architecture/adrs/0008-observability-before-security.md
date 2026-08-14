# 0008. Swap Pass Order — Observability (Pass 5) Before Security (Pass 6)

* **Status:** Accepted
* **Date:** 2026-08-01 (estimated)
* **Deciders:** <!-- @github-handle -->

---

## Context

Pass 5 (Observability & Logging) and Pass 6 (Security Hardening) are **adjacent, additive passes**: Observability wraps every public function in `try/except` and adds structured `logger.error(...)` calls; Security then red-team reviews the finished code against the OWASP Top-10 checklist. The two passes must run in an order that makes both effective.

The **original design ran Security before Observability**. That left the Security agent auditing code *before* any log statements existed — so it could never inspect the error-handling paths for the leak vector that observability itself introduces: **raw values written into `logger.error(...)` messages**. A security review that cannot see the log statements cannot detect PII, tokens, or secrets leaking through them — a critical blind spot, since error logs are exactly where sensitive values end up.

The shipped agent files encode the intended contract. Pass 5 is told to log thoroughly and *defer* masking:

> "Security hardening will follow in Pass 6 — log statements should be thorough and may include raw values for now; the Security agent will mask PII in the next pass." ([`pass-5-observability-agent.md#L150-L153`](../../../src/agents/pass-5-observability-agent.md#L150-L153))

And Pass 6's OWASP **A02 – Cryptographic Failures** check explicitly requires auditing those very statements:

> "Ensure no passwords, tokens, or keys are logged or included in error message strings." ([`pass-6-security-agent.md#L107-L112`](../../../src/agents/pass-6-security-agent.md#L107-L112))

That check is only satisfiable if Pass 6 runs after the log statements exist.

### Alternatives considered

| Alternative | Verdict |
|---|---|
| **Security before Observability (original)** | Rejected — Security audits code with no log statements, so it cannot review the PII/secret leak surface that observability creates. |
| **Observability before Security** | **Chosen** — Security reviews the complete, instrumented output (including every `logger.error()`), and can mask PII at the code level in the same pass. |
| **One combined "observability + security" pass** | Rejected — violates the one-concern-per-pass invariant ([ADR-0002](./0002-xstate-machines.md)); a merged generalist pass degrades attention and cannot be rolled back independently. |

---

## Decision

**New pass order: Pass 5 = Observability & Error Handling, Pass 6 = Security Hardening.**

The order is the numeric `PipelinePass` enum order, applied consistently across the engine ([`src/core/types.ts#L15-L24`](../../../src/core/types.ts#L15-L24)):

| Pass | Enum value | Agent | Label ([`types.ts#L37-L46`](../../../src/core/types.ts#L37-L46)) |
|---|---|---|---|
| 5 | `Observability = 5` | `pass-5-observability-agent` | Observability & Logging |
| 6 | `Security = 6` | `pass-6-security-agent` | Security Hardening |

Responsibilities under the new order:

1. **Pass 5 — Observability & Error Handling** (`pass-5-observability-agent.md`): *additive-only* — module logger init, entry/exit logs, top-level `try/except` wrappers that log at ERROR and re-raise, domain-specific exception classes, no `print()`. Explicitly allowed to log raw values because Pass 6 will review them ([`pass-5-observability-agent.md#L52-L77`](../../../src/agents/pass-5-observability-agent.md#L52-L77), [`#L150-L153`](../../../src/agents/pass-5-observability-agent.md#L150-L153)).
2. **Pass 6 — Security Hardening** (`pass-6-security-agent.md`): red-team review of the **complete** output — including every log statement — against OWASP A01–A10 ([`pass-6-security-agent.md#L100-L153`](../../../src/agents/pass-6-security-agent.md#L100-L153)). A02 now has real statements to audit; A09 (Security Logging and Monitoring Failures) layers targeted `security.` logger lines on top of Pass 5's structured logging ([`pass-6-security-agent.md#L140-L146`](../../../src/agents/pass-6-security-agent.md#L140-L146)). The task briefs the agent that "the observability instrumentation (error handlers, structured logging) from Pass 5 is complete" ([`#L160-L163`](../../../src/agents/pass-6-security-agent.md#L160-L163)).

**Gating is unaffected by the swap.** Both passes remain guarded self-correction passes with an atomic commit ([`SELF_CORRECTION_PASSES`](../../../src/core/types.ts#L53-L59), [`GIT_COMMIT_PASSES`](../../../src/core/types.ts#L62-L71)), so each is independently verifiable and rollback-able via `git revert` ([ADR-0003](./0003-atomic-commits-per-pass.md)).

> [!NOTE] CONTEXT_RULES and the file set
> Both passes inherit the same implementation-file set from Refactor (`files.implementation: [Refactor]` in [`src/core/context-builder.ts#L46-L69`](../../../src/core/context-builder.ts#L46-L69)). Pass 6 reads the files **as they exist after Pass 5's commit**, so it physically sees the log statements — but its `targetSymbols`/`fileChanges` still derive from Refactor only, not Observability (open item O-1).

---

## Consequences

### Positive

* **Security can catch PII in `logger.error()`** — OWASP A02 is reviewable against real log statements, closing the leak blind spot that motivated the swap ([`pass-6-security-agent.md#L107-L112`](../../../src/agents/pass-6-security-agent.md#L107-L112)).
* **No self-censorship in Pass 5** — Observability can log raw values for maximum diagnosability and defer masking to the specialist pass, instead of guessing what is sensitive ([`pass-5-observability-agent.md#L150-L153`](../../../src/agents/pass-5-observability-agent.md#L150-L153)).
* **In-pipeline PII handling** — masking happens at the code level by the security specialist, complementing (and distinct from) gateway-level DLP (see [7. Security Model § 2.5 — Pass 6](../user-overview/07-security-model.md#25-pass-6--the-security-hardening-agent-the-in-pipeline-security-layer)).
* **Full-visibility security review** — the security agent reviews the complete, instrumented output, including error handlers that security checks A09 (logging/monitoring failures) rely on ([`pass-6-security-agent.md#L140-L146`](../../../src/agents/pass-6-security-agent.md#L140-L146)).
* **Gating unchanged** — both passes keep their test gate + self-correction loop and atomic commit, so the swap adds no new failure modes to the state machine.

### Negative / Trade-offs

* **Security now reviews a larger surface** — it must audit the added log statements in addition to the pre-existing code; both passes are additive and touch the same files, so line numbers shift between their change records (the drift-resistant anchor mechanism absorbs this — see the worked example in [6. Context Engineering § 3.1](../user-overview/06-context-and-token-savings.md#31-worked-example--a-real-session-state-file)).
* **Imprecise change descriptors for Pass 5 hunks** — `CONTEXT_RULES` does not chain Observability → Security, so Pass 6's payload omits the precise `fileChanges` for the log statements Pass 5 added; the agent must locate them by reading (open item O-1).
* **Unreviewed-log window is inherent** — the only statements Pass 6 cannot audit are ones added by Pass 6 itself (targeted security logging); these land under its own self-correction gate.
* **Adjacent-specialist ordering cost** — the pipeline must run two additive passes back-to-back, slightly increasing total passes-to-PR; this is the accepted price for the accuracy gain.

---

## Placeholders / Open Items

| # | Topic | What is missing |
|---|---|---|
| O-1 | CONTEXT_RULES chaining | Security's `files`/`target` lists Refactor only ([`context-builder.ts#L58-L68`](../../../src/core/context-builder.ts#L58-L68)); decide whether to add `Observability` so Pass 6 receives Pass 5's `targetSymbols`/`fileChanges` change descriptors. |
| O-2 | Historical evidence of the old order | The original Security-before-Observability order predates this repository's history (types.ts references a retired Python `cli.py`); no code ever shipped with it here — verify against `git log` if an audit trail is needed. |
| O-3 | Decision date & deciders | Date is estimated (2026-08-01); no decider GitHub handles are recorded. |

---

## Related

* [3. The 8-Pass Pipeline — pass order note](../user-overview/03-8-pass-pipeline.md) · [7. Security Model — why Security runs after Observability](../user-overview/07-security-model.md)
* [6. Observability & Operations (Contributor)](../contributor-deep-dive/06-observability-operations.md) · [3. Context Engineering § 6](../contributor-deep-dive/03-context-engineering.md#6-context-enrichment--anchored-change-descriptors)
* [ADR-0002 XState Machines](./0002-xstate-machines.md) · [ADR-0003 Atomic Commits Per Pass](./0003-atomic-commits-per-pass.md)
