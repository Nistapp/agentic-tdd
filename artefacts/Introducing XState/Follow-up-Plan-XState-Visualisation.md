# Follow-up Plan: Restore Full Stately Visualisation for Pipeline Machine

## Status

**Immediate fix applied** (commit `1a6fb37`): Replaced 5 inline
`src: createSelfCorrectionMachine({...})` calls in the machine config with string
references (`src: 'selfCorrectionPass3'` through `src: 'selfCorrectionPass7'`).
Actor implementations are now registered in `setup().actors` alongside the existing
`fromPromise` actors.

This removes **Blocker 1** from the machine definition — the config is now a pure
data structure with only string references. However, **Blocker 2** remains
unresolved.

## Remaining Blockers for Stately Visualisation

### Blocker 2: Machine inside a factory closure

The machine is returned from `createPipelineMachine(services)` (line 95) rather
than being exported as a module-level `const`. Stately's static parser works best
when the machine is at module scope — it sometimes fails to locate the machine
boundary inside a factory function.

### Blocker 3: Runtime code in `setup()` (less critical)

The `setup()` block still contains `fromPromise(...)` closures, the 5
`createSelfCorrectionMachine(...)` calls in `actors`, and `emit`/`logger`/`stateStore`
closures in `actions` and `guards`. While `fromPromise` is a well-known XState
utility that Stately may handle, all of this is still inside the factory closure
and inaccessible to a static parser.

## Proposed Architecture (Phases)

### Phase 1: Extract pure machine config to module scope

```typescript
// pipeline.machine.ts → NEW module-level const with ZERO runtime deps

const pipelineMachineConfig = setup({
  types: { /* unchanged */ },
  actors: {
    // All actors as placeholder 'fromPromise' stubs — sufficient for Stately
    // to understand the state graph shape. Real implementations injected via
    // createPipelineMachine(services).
    runPass0: fromPromise(async () => {}),
    runSimplePass: fromPromise(async () => []),
    prepareHitl: fromPromise(async () => ({ pass: 0 as PipelinePass, files: [] })),
    rewindToPassStart: fromPromise(async () => {}),
    doAtomicCommit: fromPromise(async () => {}),
    selfCorrectionPass3: {} as any, // machine actor placeholder
    selfCorrectionPass4: {} as any,
    selfCorrectionPass5: {} as any,
    selfCorrectionPass6: {} as any,
    selfCorrectionPass7: {} as any,
  },
  actions: {
    // Stubs that don't access DI services
    emitPipelineStarted: () => {},
    emitPipelineCompleted: () => {},
    // ...
  },
  guards: {
    // Guards only read context — they don't need stubbing
    atPass0: ({ context }) => context.ctx.currentPass === 0,
    // ...
  },
}).createMachine({
  id: 'pipeline',
  // ... UNCHANGED machine config with string references only
});

// DI factory → injects real implementations via .provide()
export function createPipelineMachine(services: { ... }) {
  const { agentRunner, cmd, fs, git, events, logger, stateStore } = services;
  const emit = makeEmit(events);

  return pipelineMachineConfig.provide({
    actors: {
      runPass0: fromPromise(async ({ input }) => { /* real impl */ }),
      runSimplePass: fromPromise(async ({ input }) => { /* real impl */ }),
      // ...
      selfCorrectionPass3: createSelfCorrectionMachine({ ... }),
      // ...
    },
    actions: {
      emitPipelineStarted: ({ context }) => { emit(...) },
      // ...
    },
  });
}
```

**Impact**: This fully separates the machine structure from its implementation.
Stately gets a module-level `pipelineMachineConfig` with zero opaque runtime
calls. The DI factory `createPipelineMachine(services)` only does wiring.

**Risk**: XState v5 `.provide()` for actors/actions/guards needs validation
with the actual xstate package version in use (currently `xstate@5.x`).
The approach is the documented XState v5 pattern for DI.

**Tests**: All existing tests pass without changes — they call
`createPipelineMachine(services)` which returns the same shaped machine.

### Phase 2: Extract `createSelfCorrectionMachine` to module scope (same pattern)

Apply the same treatment to `src/core/machines/self-correction.machine.ts`:
a pure module-level config, with `.provide()` injecting implementations.

### Phase 3: Colocate all machine configs in a dedicated directory

Move all machine configs to `src/machines/` at module scope, with DI factories
co-located or in a separate `src/machines/wiring/` directory. This gives Stately
a clean set of module-level exports to discover.

## Dependencies

- XState v5 `.provide()` must support overriding `actors`, `actions`, and `guards`
- The type system must allow `pipelineMachineConfig.provide({...})` to return
  the same type as the current `createPipelineMachine(...)` return
- `makeEmit(events)` is currently module-scoped in `pipeline.machine.ts`

## Priority

| Phase | Priority | Effort | Risk |
|-------|----------|--------|------|
| Phase 1 | Medium | ~2h | Low — pure refactor, tests guard correctness |
| Phase 2 | Low | ~1h | Low — same pattern |
| Phase 3 | Low | ~30m | Very low — file moves |

## Verification

After each phase:
1. `npm run lint` — zero errors
2. `npm test` — all 271 tests pass (currently 14 files, 271 tests)
3. Visual check: open `pipeline.machine.ts` in VS Code with Stately extension —
   the visual editor should render the full state chart
