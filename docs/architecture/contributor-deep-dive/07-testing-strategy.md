# 7. Testing Strategy & Mock Patterns

> **Target Audience:** Contributors writing or extending the test suite.
> **Status:** PLACEHOLDER — not yet drafted.

---

## Outline

- **Test Philosophy:** Zero real I/O. No filesystem, git, or real opencode API calls in tests.
- **Coverage Contract:** Every public method needs ≥ 1 positive and ≥ 1 negative test.
- **DI Stubs:** `vi.fn()` + typed stubs satisfying the full DI interface (e.g. `StubLogger`, `makeMocks` in `test/orchestrator.test.ts`).

---

## Existing material to mine

- `test/orchestrator.test.ts` — `StubLogger`, `makeMocks`, `findEvents`.
- [5. CLI & DI Wiring](05-cli-di-wiring.md) — how stubs map to the container.

---

## Placeholders / Open Questions

| # | Topic | What is missing |
|---|---|---|
| T-1 | Mock inventory | Full list of stub fixtures per interface. |
| T-2 | Machine tests | How pipeline/self-correction machines are exercised without I/O. |
