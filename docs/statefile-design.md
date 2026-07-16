# StateFile: Session Persistence (DEFERRED)

This document captures the intended design for full state-file
persistence across the 8-pass pipeline. The feature is intentionally
deferred — clean scaffolding is in place but no per-pass state writes
are implemented yet.

---

## Current State (post-cleanup)

### What's wired (`IStateStore` skeleton)
- `src/core/interfaces.ts` defines `IStateStore` with `save()`, `load()`, `delete()`, `exists()`.
- `src/infrastructure/state-store.ts` provides `JsonStateStore` (serialises `PipelineContext` to `.opencode/active-run.json`).
- `src/utils/paths.ts` provides `getStateFilePath()` — single source of truth for the path.
- `src/cli/index.ts` uses `JsonStateStore` for:
  - Writing the state file once at pipeline start (new-run branch).
  - Reading it for --resume and --abort.
  - Deleting it on successful completion (both new-run and resume branches).
  - Guarding: detects existing state file → blocks new runs without --resume/--abort.

### What's NOT wired
- **The orchestrator has zero state-file knowledge.** It was removed
  from the engine entirely (DI-boundary fix). The CLI layer owns
  session lifecycle.
- **No per-pass state writes.** The state file is written once at
  start. If the pipeline crashes at pass 4, the state file says
  "pass 0" — no progress is captured.
- **Resume uses git log, not state file.** `getLastCompletedPass()`
  derives progress from commit messages, not from the JSON file.
  The state file is essentially a lock + abort-anchor (`originalBaseSha`).

---

## Planned Full Implementation

### Per-pass state updates
After each `#maybeCommit()` in `PipelineOrchestrator.run()`:
```
ctx.currentPass = pass;  // already set
await this.#stateStore.save(ctx);  // NEW
```
This writes the latest completed pass to disk, enabling true resume.

### Resume from state file
Replace the git-log derivation:
```ts
// Current (git log):
const lastCompletedPass = await git.getLastCompletedPass();

// Future (state file):
const ctx = await stateStore.load();
const lastCompletedPass = ctx.currentPass;
```

### Lock atomicity
Use temp-file + rename pattern in `JsonStateStore.save()`:
```ts
const tmp = path + '.tmp';
await fs.writeFile(tmp, JSON.stringify(ctx, null, 2));
await fs.rename(tmp, path);
```

### IStateStore integration into orchestrator
Add `IStateStore` as an optional DI constructor parameter:
```ts
constructor(
  git: IGitService,
  fs: IFileSystem,
  cmd: ICommandRunner,
  events: IEventBus,
  stateStore?: IStateStore,     // NEW
  onHitl: HitlHandler = () => Promise.resolve(),
)
```
When provided, the orchestrator calls `stateStore.save(ctx)` after each
pass. When not provided, no persistence (backwards-compatible).

### CLI wiring
`src/cli/index.ts` already injects `JsonStateStore` into the orchestrator
constructor — the port is defined, just needs wiring.

---

## Open Questions (from existing TODO/REMARK comments)

1. Should the state file be committed to git? (currently not — it lives in `.opencode/`)
2. Should we also store the `startPass` in the state file?
3. How to handle the HITL gate during resume — skip it or re-prompt?
4. Do we need a `stateFile` entry in `PipelineContext` for self-reference?
5. What happens when `stateStore.save()` fails mid-pipeline? Should we
   abort or continue without state?

---

## Related Files

| File | Role |
|---|---|
| `src/core/interfaces.ts` | `IStateStore` port |
| `src/infrastructure/state-store.ts` | `JsonStateStore` adapter |
| `src/utils/paths.ts` | `getStateFilePath()` |
| `src/cli/index.ts` | CLI wires `JsonStateStore`, owns session lifecycle |
| `src/core/orchestrator.ts` | Future: accepts optional `IStateStore` |
| `src/core/types.ts` | `PipelineContext.originalBaseSha` used for --abort |

---

## Touchpoints to update when implementing

1. Wire `IStateStore` into `PipelineOrchestrator` constructor (optional param).
2. Add `stateStore.save(ctx)` calls after each `#maybeCommit()` in `run()`.
3. Replace `getLastCompletedPass()` git-log derivation with state-file read in `cli/index.ts`.
4. Implement temp-file rename in `JsonStateStore.save()`.
5. Add test coverage: `src/core/interfaces.ts` → stub `IStateStore`, verify save calls per pass.
6. Add test coverage: `src/infrastructure/state-store.ts` → round-trip save/load, rename atomicity.
7. Remove the `// DEFERRED: StateFile` comments from `orchestrator.ts` and `cli/index.ts`.
