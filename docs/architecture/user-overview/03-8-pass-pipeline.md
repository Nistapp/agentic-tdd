# 3. The 8-Pass Pipeline

> **Target Audience:** Users — CTOs, Team Leads, and Architects.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline

- **Overview:** N's output = N+1's read-only context.
- **Pass Reference Table:** Name, Persona, Context In, Gate, Recommended Model.
- **Human-in-the-Loop (HITL):** artifact approval checkpoint after Pass 0.
- **Rollback Strategy:** atomic git commits per pass (`git revert`).

---

## Existing material to mine

- Pass state diagram: [README.md#architecture-at-a-glance](../../../README.md).
- Per-pass prompts: `src/agents/pass-0..7-*.md`.
- ADRs: [0002 XState machines](../adrs/0002-xstate-machines.md), [0003 atomic commits per pass](../adrs/0003-atomic-commits-per-pass.md), [0004 HITL gate after Pass 0](../adrs/0004-hitl-gate-after-pass-0.md), [0008 observability before security](../adrs/0008-observability-before-security.md).
- Drift-correction rationale: summarised on [page 1](01-why-this-exists.md).

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| P-1 | Pass Reference Table | Compile actual `model:`, `permission:`, and scope from each `src/agents/pass-*.md` file. |
| P-2 | HITL behaviour | Describe the actual HITL flow from `src/cli/hitl-handler.ts` and the `HITL_REQUIRED` event. |
| P-3 | Rollback walkthrough | Concrete `git revert` example + `--abort` semantics from `src/cli/session.ts`. |
