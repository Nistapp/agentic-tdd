# 7. Security Model & Sandboxing

> **Target Audience:** Users — CTOs, Security Leads, and Architects.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline - This whole section is aspirational. Say with complete honesty that these will be solved sometime this year. 

- **Agent Sandbox:** file-glob permission locking.
- **DLP Masking:** PII stripping before external API calls via LiteLLM (planned — verify).
- **Hard-Fail Gates:** Semgrep runs between guarded passes (PLANNED).

---

## Existing material to mine

- Agent isolation and scope locking (prevents Agent Trampling) — see [page 1](01-why-this-exists.md) and the glossary's *Agent Trampling* entry.
- Deterministic environments: DevContainer/Nix sandboxing (**implementation pending**).
- Security pass prompt: `src/agents/pass-6-security-agent.md`.
- `src/core/log-sanitizer.ts`.

> [!NOTE] Planned vs. shipped
> Several security features — Semgrep hard-fail gates, DevContainer sandboxing, PII masking via LiteLLM — are **planned, not shipped**. This page MUST use explicit notice banners per STYLE_GUIDE and NOT present them as existing capabilities.

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| S-1 | Current shipped surface | What security is enforced today (agent permission scopes, log sanitizer)? |
| S-2 | DLP/PII masking | Verify whether the LiteLLM DLP masking exists in `infra/` or is aspirational. |
| S-3 | Log sanitizer | `src/core/log-sanitizer.ts` exists — document what it strips. |
