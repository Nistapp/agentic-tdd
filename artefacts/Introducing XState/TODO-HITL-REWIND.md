# TODO: Event-Driven HITL with REWIND Support

**Created**: Phase 5 (XState test suite verification)
**Status**: Deferred — blocked on machine refactor

## Current State

The HITL gate (after Pass 0 and Pass 2) uses a synchronous `callOnHitl`
`fromPromise` actor (`src/core/machines/pipeline.machine.ts:199`):

```
awaiting_hitl_pass_0:
  invoke:
    src: 'callOnHitl'   // fromPromise<void, { pass }>
    onDone: 'pass_1_contracts'
    onError: 'pipeline_failed'
```

The `HitlHandler` signature is `(pass?, files?) => Promise<void>`
(`src/core/orchestrator.ts:14`).  The handler resolves when the user approves,
or throws to reject — it never sends an actor event.

## What's Missing

`PipelineMachineEvent` (`src/core/types.ts:243`) defines `HITL_REWIND` as a
valid event type, but it is accepted by no state in the pipeline machine.
The `awaiting_hitl_pass_0` / `awaiting_hitl_pass_2` states use `invoke` (which
only transitions via `onDone` / `onError`), not `on: { HITL_REWIND: ... }`.

## Required Refactor

Per `TODO-xstate-snapshot-resume.md` (section "2. Event-driven HITL"):

- Replace the synchronous `callOnHitl` fromPromise with event-listener
  states that wait for `HITL_APPROVE` / `HITL_REJECT` / `HITL_REWIND`
  actor events sent by the orchestrator or CLI interface.
- This makes HITL a genuine pausable boundary, enabling true loss-less
  snapshot resume (item 1 in the snapshot-resume TODO).
- The CLI `hitl-handler.ts` would send the appropriate event to the
  running actor instead of invoking a callback.

## Related Files

- `src/core/machines/pipeline.machine.ts` — `awaiting_hitl_pass_0/pass_2` states
- `src/core/types.ts` — `PipelineMachineEvent` type (already includes HITL_REWIND)
- `src/core/orchestrator.ts` — `HitlHandler` type and actor lifecycle
- `src/cli/hitl-handler.ts` — readline-based HITL UI
- `artefacts/Introducing XState/TODO-xstate-snapshot-resume.md` — linked dependency

## Test Gap

The existing HITL tests in `test/orchestrator.test.ts` cover:
- Happy-path HITL approve (handler resolves)
- Handler throwing → pipeline fails
- HITL_REQUIRED event payload accuracy
- Invoke count (exactly twice, for Pass 0 and Pass 2)

No test exercises `HITL_REWIND` because the transition does not exist yet.
When the event-driven HITL refactor lands, add tests for:
- Sending `HITL_REWIND` to `awaiting_hitl_pass_N` transitions back to the
  agent execution state for that pass
- `HITL_REJECT` reaches `pipeline_failed` without calling git commit
