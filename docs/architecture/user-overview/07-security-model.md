# 7. Security Model & Sandboxing

> **Target Audience:** Users — CTOs, Security Leads, and Architects.
> **Status:** PLACEHOLDER — not yet drafted.
> **Source of truth for structure:** [wiki-structure.md §7](../../../artefacts/documentation-prep/wiki/wiki-structure.md).

---

## Outline

- **Agent Sandbox:** file-glob permission locking.
- **DLP Masking:** PII stripping before external API calls via LiteLLM.
- **Hard-Fail Gates:** Semgrep runs between guarded passes (PLANNED).

---

## Existing material to mine

- Manifesto [§2.3 Deterministic Environments](../../architecture-manifesto.md) (DevContainer/Nix — **implementation pending**).
- Manifesto [§4.2 Agent Isolation and Scope Locking](../../architecture-manifesto.md) (prevents Agent Trampling).
- Manifesto [§4.3 Semgrep hard-fail gates](../../architecture-manifesto.md) (**planned**).
- Manifesto appendix "Security and PII" Mermaid diagram.
- Security pass prompt: `src/agents/pass-6-security-agent.md`.

> [!NOTE] Planned vs. shipped
> Several security features in the manifesto (Semgrep gates, DevContainer sandboxing, PII masking via LiteLLM) are **planned, not shipped**. This page MUST use explicit notice banners per STYLE_GUIDE and NOT present them as existing capabilities.

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| S-1 | Current shipped surface | What security is enforced today (agent permission scopes, log sanitizer)? |
| S-2 | DLP/PII masking | Verify whether the LiteLLM DLP masking exists in `infra/` or is aspirational. |
| S-3 | Log sanitizer | `src/core/log-sanitizer.ts` exists — document what it strips. |
