# Strong-Advisory Context: Letting opencode Augment Your Pipeline Context

## Problem Statement

The agentic-tdd pipeline injects a curated JSON payload into each agent's prompt (via `getAgentContextPayload`), containing `contextFiles`, `targetSymbols`, and `fileChanges`. This focused context is a strength — but two concerns arise:

1. **Is opencode's native context mechanism being overridden?** Does the pipeline's injected context *replace* opencode's own tool-based exploration, or do they coexist?
2. **How do we make the injected context "strong-advisory" rather than restrictive?** The current agent prompts contain directives like `MUST restrict your edits ONLY to the functions listed in this map` — which may prevent the agent from discovering context it needs.

---

## Analysis: How the Two Context Layers Interact

### Layer 1: Your Pipeline's Injected Context

The pipeline builds context through this chain:

```
StateContextProvider.build()           → BuiltContext (files, targetSymbols, fileChanges)
    ↓
getAgentContextPayload(ctx, built)     → JSON string (the prompt text)
    ↓
OpenCodeAgentRunner.#buildArgs()       → ['run', '--agent', name, '--file', ...artefacts, prompt]
    ↓
spawner.spawn(args)                    → opencode process
```

**What gets injected:**
- The JSON payload (as the final positional argument — the prompt text)
- `--file` attachments: `designMmd`, `specGherkin`, `specFile`, `errorLog`

**What does NOT get injected:**
- The files listed in `contextFiles.contracts`, `contextFiles.tests`, `contextFiles.implementation` — these are **filenames in the JSON payload**, not `--file` attachments. The agent must use its own tools (`read`, `glob`, `grep`) to actually read them.

### Layer 2: opencode's Native Context

When opencode receives `opencode run --agent pass-X --file artefact1 --file artefact2 <prompt>`, it does the following:

1. **Loads the agent prompt** (the `.md` file in `src/agents/`) as the system prompt
2. **Attaches the `--file` artefacts** directly into the context window
3. **Presents the prompt text** (your JSON payload) as the user message
4. **The agent then executes using its full tool suite**: `read`, `edit`, `glob`, `grep`, MCP tools, etc.

> [!IMPORTANT]
> **opencode's native tools are NOT being overridden.** The agent always retains full access to `read`, `glob`, `grep`, and MCP tools. Your `--file` attachments and JSON prompt are *additive* — they don't suppress anything.

### The Good News

Your architecture already achieves coexistence. The `contextFiles` arrays are **filename hints**, not injected content. The agent reads them with its own tools. opencode's AGENTS.md, MCP servers, and tool-based exploration all remain active. The two layers cooperate naturally.

### The Problem: Prompt-Level Restriction

The tension isn't in the *mechanism* — it's in the **language of the agent prompts**. Several prompts use **hard-restrictive** phrasing that tells the agent to ignore anything outside the injected context:

| Pass | Problematic Directive | Effect |
|---|---|---|
| 4 (Refactor) | `MUST restrict your edits ONLY to the functions listed in this map` | Agent won't refactor helper functions that it discovers via `grep`/MCP are tightly coupled |
| 5 (Observability) | `MUST restrict your edits ONLY to the functions listed in this map` | Agent won't add logging to a function it discovers is a critical error path via exploration |
| 6 (Security) | `MUST restrict your edits ONLY to the functions listed in this map` | Agent won't harden a function it discovers has an injection vulnerability via its own analysis |

The `indexer-first` rule and `use-file-changes` rule *encourage* exploration, but then the `target-symbols-only` rule slams the door shut. This creates a contradiction:

> "Use the indexer to understand the project..." → "...but don't touch anything the indexer reveals unless it's in our list."

---

## Proposed Changes: Strong-Advisory, Not Restrictive

### Philosophy

Reframe the injected context as a **priority map** — "start here, focus here, these are the most important things" — while allowing the agent to **widen scope when its own analysis reveals a need**. Add a "justification gate" for out-of-scope changes rather than a hard ban.

### Concrete Changes

---

### Agent Prompts (`src/agents/`)

#### [MODIFY] All passes with `target-symbols-only` rule: Pass 4, 5, 6

Replace the hard-restrictive `target-symbols-only` rule with a **strong-advisory + justification** pattern. The current rule:

```xml
<rule id="target-symbols-only">You will receive a `targetSymbols` map in the
  JSON payload (mapping file paths to specific function/method names). You
  MUST restrict your edits ONLY to the functions listed in this map. You may
  add imports and helper functions if needed, but do NOT modify any existing
  functions outside the map.</rule>
```

Becomes:

```xml
<rule id="target-symbols-priority">You will receive a `targetSymbols` map in the
  JSON payload (mapping file paths to specific function/method names changed
  in prior passes). These are your PRIMARY edit targets — start with these
  functions and devote the majority of your effort here.

  If your own analysis (via indexer, grep, read, or MCP tools) reveals that
  an additional function MUST be edited to fulfil your pass mandate (e.g. a
  tightly-coupled helper, a shared utility with a security flaw, or a
  function that must be instrumented because it is the only error-reporting
  path), you MAY edit it — but you MUST:
  1. Add an inline comment: `// OUT-OF-SCOPE: {pass}-agent — {one-line justification}`
  2. Keep the change minimal and directly related to your pass mandate.
  3. Do NOT use this as license to expand scope broadly — the targetSymbols
     map represents the orchestrator's considered judgement of what needs work.
</rule>
```

#### [MODIFY] All passes: Reframe `contextFiles` as advisory in `<task>`

In each agent's `<task>` block, the phrase:

```
Read the implementation files listed in `contextFiles.implementation`
```

Becomes:

```
Read the implementation files listed in `contextFiles.implementation` — these
are the orchestrator's priority files for this pass. You SHOULD also use your
own tools (indexer, grep, glob) to discover any additional files that are
relevant to your mandate, especially imports, callers, and tightly-coupled
modules that the orchestrator may not have tracked.
```

#### [MODIFY] All passes: Add a `<context-philosophy>` section

Add this new block to each agent prompt, after `<directives>` and before `<task>`:

```xml
<context_philosophy>
  The JSON payload you receive contains the orchestrator's best-effort context:
  priority files, target symbols, and precise change descriptors. Treat this as
  your STARTING POINT, not your complete picture:

  - `contextFiles` → These files are your priority. Read them first.
  - `targetSymbols` → These functions are your primary edit targets.
  - `fileChanges` → These precise locations help you find the exact code fast.

  You also have access to the full project via your own tools (read, glob, grep,
  MCP indexer). Use them to SUPPLEMENT the payload — especially to understand
  call chains, imports, and coupling that the orchestrator's diff-based tracking
  may miss. The payload tells you WHERE to start; your tools tell you what ELSE
  matters.
</context_philosophy>
```

---

### No Infrastructure Changes Needed

The infrastructure layer ([open-code-agent-runner.ts](file:///home/kc/Projects/UDAN/agentic-compress-before-github--6Jun26/agentic-tdd/src/infrastructure/open-code-agent-runner.ts), [context-builder.ts](file:///home/kc/Projects/UDAN/agentic-compress-before-github--6Jun26/agentic-tdd/src/core/context-builder.ts), [context-provider.ts](file:///home/kc/Projects/UDAN/agentic-compress-before-github--6Jun26/agentic-tdd/src/core/context-provider.ts), [shared.ts](file:///home/kc/Projects/UDAN/agentic-compress-before-github--6Jun26/agentic-tdd/src/core/runners/shared.ts)) does NOT need changes. The mechanisms already work correctly:

1. `contextFiles` are filename hints, not injected file contents — ✅ already advisory
2. `--file` attachments are additive to opencode's context — ✅ already cooperative  
3. opencode's tools (`read`, `glob`, `grep`, MCP) remain fully available — ✅ not suppressed
4. `targetSymbols` and `fileChanges` are data in the prompt, not tool restrictions — ✅ agent decides how to use them

The restriction is purely in the **prompt language**, so the fix is purely in the **prompt language**.

---

## Open Questions

> [!IMPORTANT]
> ### 1. How strict should the justification gate be for late passes (5, 6)?
> For Observability and Security, there's a strong argument that the agent *should* be allowed to discover new targets via its own analysis — these are cross-cutting concerns. But for Refactor (Pass 4), the "don't change observable behaviour" constraint means broader scope is riskier. Should the advisory level differ per pass?

> [!IMPORTANT]
> ### 2. Should out-of-scope edits be tracked?
> If an agent edits a function NOT in `targetSymbols`, the current WRITER mechanism (AST symbol resolver + git diff) will capture it in the next pass's `targetSymbols`/`fileChanges` anyway — so downstream passes will see it. But should we also log a warning in the orchestrator when the diff reveals symbols not in the original `targetSymbols`? This could be a useful audit trail.

> [!WARNING]
> ### 3. Risk: Assessment-first workflow interaction
> In the previous conversation (cf93cfb1), you implemented an "assessment-first" workflow for passes 5, 6, 7 where the agent evaluates whether intervention is needed before acting. If we loosen the `target-symbols-only` constraint, an agent that was going to NO-OP (because all target symbols are already well-instrumented) might now find new things to change via exploration. This could undermine the assessment-first optimisation. We should ensure the `<context_philosophy>` section clarifies that exploration is for *understanding*, and the assessment gate still controls whether to *act*.

---

## Per-Pass Impact Summary

| Pass | Current Behaviour | Proposed Behaviour | Risk |
|---|---|---|---|
| 0 (Design) | No `targetSymbols` — already exploratory | No change needed | None |
| 1 (Contracts) | No `targetSymbols` — already exploratory | No change needed | None |
| 2 (Tests) | No `targetSymbols` — relies on contracts | No change needed | None |
| 3 (Implementation) | No `target-symbols-only` rule — already free to create | Add `<context_philosophy>` only | Low |
| 4 (Refactor) | Hard-restricted to `targetSymbols` | Advisory with justification gate | Medium — relaxed scope with behaviour-preservation constraint |
| 5 (Observability) | Hard-restricted to `targetSymbols` | Advisory with justification gate | Low — observability is additive |
| 6 (Security) | Hard-restricted to `targetSymbols` | Advisory with justification gate | Low — security hardening benefits from wider analysis |
| 7 (Documentation) | `targetSymbols` already empty `{}` — documents everything | Add `<context_philosophy>` only | None |

---

## Verification Plan

### Automated Tests
- `npm run lint && npm test` — the agent prompts are `.md` files, so no code changes to break tests
- `npm run build` — verify prompts are copied to `dist/agents/`

### Manual Verification
- Run a real pipeline pass (e.g. pass 5 or 6) on a test project and inspect:
  1. Does the agent read files beyond `contextFiles`?
  2. Does it add `// OUT-OF-SCOPE` comments when editing outside `targetSymbols`?
  3. Does the assessment-first workflow still produce NO-OP when appropriate?

---

## Summary

The good news is that opencode's native context mechanism is already working alongside your pipeline's context injection — they're additive, not competing. The issue is that your agent prompt language creates an artificial restriction via `target-symbols-only` rules. The fix is entirely in prompt engineering: reframe `targetSymbols` as a priority map with a justification gate, not a hard boundary. No infrastructure code changes needed.
