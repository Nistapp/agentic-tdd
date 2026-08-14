# 15. Developer Guide

> **Target Audience:** Contributors setting up locally and extending the pipeline.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline

- **Local Setup:** Node.js ≥ 18, `npm install`, `.env` setup (`OPENROUTER_API_KEY`), `npm run build`, `npm link`.
- **Adding a New Pass:** creating the prompt, updating `types.ts`, XState transitions, `context-builder.ts` (`CONTEXT_RULES`), and the pipeline machine.
- **Extending DI:** define the port in `interfaces.ts`, implement in `infrastructure/`, wire in `di-container.ts`.
- **Running / Verifying:** `npm run lint` (type-check), `npm test`, `npm run build`.

---

## Related

- [2. Prompt Engineering §5](02-prompt-engineering.md#5-adding--modifying-a-pass) — pass-addition recipe
- [5. CLI & DI Wiring](05-cli-di-wiring.md) — DI extension
- [7. Testing Strategy & Mock Patterns](07-testing-strategy.md)

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| G-1 | Quick-start walkthrough | End-to-end first-run example with a sample spec. |
| G-2 | Pass template | A copyable pass skeleton. |
