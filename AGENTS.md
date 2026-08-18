# AGENTS.md — agentic-tdd

This file governs how AI coding agents (Antigravity, Claude Code, Gemini CLI, etc.) work
inside this repository. Read it in full before making any change.

---

## 1. Project Overview

**agentic-tdd** is a Node.js / TypeScript library and CLI that orchestrates an
**8-pass agentic TDD pipeline** for enterprise software development. It drives
[opencode](https://opencode.ai) sub-agents through sequential, guarded passes
(Design → Contracts → Tests → Implementation → Refactor → Observability → Security → Documentation), each producing an atomic git commit.

Key design invariants:
- The **Core Engine** (`src/core/`) is a pure state machine — zero knowledge of
  filesystems, Git, or shell commands.
- All OS interactions are injected via DI interfaces (`src/core/interfaces.ts`).
- Each pass outputs a git commit; rollback is `git revert`.
- Token cost is minimised via a **Static Prefix** (cacheable file ordering) and
  **Context Compaction** (error logs deleted on pass success).

---

## 2. Architectural Boundaries

> **Use `codebase_memory-mcp: get_architecture(aspects=["structure", "dependencies"])` to understand the current repository layout and file tree.**

While the exact file tree may evolve, agents MUST respect these structural rules:
- **Core Engine (`src/core/`)**: Must remain a pure state machine with zero OS dependencies.
- **Dependency Injection**: All DI interfaces live in `src/core/interfaces.ts`. `src/core/` must never import from `src/infrastructure/`.
- **Infrastructure (`src/infrastructure/`)**: All filesystem, git, and OS-level operations belong here.
- **Why?**: See `docs/architecture/adrs/0001-pure-core-engine.md` for the rationale behind these boundaries.

---

## 3. Tech Stack & Tooling

> **Refer to `package.json` for exact package versions.** Do not hallucinate versions.

| Concern | Tool |
|---|---|
| Language | TypeScript (`strict`, `noUncheckedIndexedAccess`, `isolatedModules`) |
| Runtime | Node.js (ESM `"type": "module"`) |
| Module system | `NodeNext` — always use `.js` extensions in `import` paths |
| Pipeline State | `xstate` (Core state machine engine) |
| Test runner | Vitest — run with `npm test` |
| Type-check | `npm run lint` (`tsc --noEmit`) |
| Build | `npm run build` (tsc + copy agents) |
| Process runner | `execa` |
| Logging | `pino` with child loggers |

---

## 4. Codebase-Memory-MCP Integration

The `codebase-memory-mcp` server (binary at `/usr/bin/codebase-memory-mcp`, v0.8.1)
is installed and registered as an MCP tool. **You must use it proactively** — not
just reactively — at every significant stage of work.

> [!IMPORTANT]
> **Always prefer `codebase_memory` MCP tools over reading full source files.**
> This avoids unnecessary token consumption and gives richer semantic context.

### Tool selection — priority order

| Situation | Preferred Tool | Fall-back |
|---|---|---|
| Understand overall structure / dependencies | `get_architecture` | — |
| Find a class, function, or method | `search_graph` | `search_code` |
| Understand call chains / data flow | `trace_path` | — |
| Read a specific function body | `get_code_snippet` | `view_file` (targeted line range only) |
| Locate usages of a symbol | `query_graph` | `grep_search` |
| Check if files changed since last index | `detect_changes` | — |
| Understand test coverage for a module | `query_graph` with `TESTS` edge type | — |
| Read an entire source file | ❌ avoid | only when `get_code_snippet` is insufficient |

### Quick-start recipes

```
# High-level architecture
codebase_memory: get_architecture(project="Nistapp-agentic-tdd", aspects=["all"])

# Find a symbol
codebase_memory: search_graph(project="Nistapp-agentic-tdd", query="PipelineOrchestrator")

# Read a function body
codebase_memory: get_code_snippet(project="Nistapp-agentic-tdd", node_id="<qualified_name>")

# Trace call path between two symbols
codebase_memory: trace_path(project="Nistapp-agentic-tdd", from_node="...", to_node="...")

# Check index freshness before starting work
codebase_memory: detect_changes(project="Nistapp-agentic-tdd")
```

> [!TIP]
> After any significant code change, call
> `index_repository(repo_path=".")`
> to keep the index fresh before querying.

### File Reading Policy

1. **Start with `codebase_memory` graph queries** — resolve symbols, relationships, call chains.
2. **Use `get_code_snippet`** to read specific function/method bodies.
3. **Use `view_file` with explicit line ranges** only when the snippet tool is insufficient.
4. **Never open entire large files** without a compelling reason — query by symbol name instead.

### Required workflow

#### Planning phase
1. Run `index_repository` (or `detect_changes` + `index_status` if already indexed).
2. Use `get_architecture` to orient yourself in the affected area.
3. Use `search_graph` / `query_graph` / `trace_path` to identify all callers, dependants,
   and DI wiring that your change will affect.
4. Only then write the implementation plan.

#### Execution phase
1. Before editing any file, call `get_code_snippet` for the specific symbol you are
   modifying — do not assume the file matches what you read earlier.
2. After each significant edit batch, run `detect_changes` to verify the graph
   reflects your changes.
3. Use `search_graph` to confirm that no stale references remain after a rename or
   interface change.

#### Verification phase
1. After `npm test` passes, run `detect_changes` once more to confirm the knowledge
   graph is up to date.
2. If a new architectural pattern was introduced, call `manage_adr` to record it.

---

## 5. Coding Standards

### TypeScript

- **Strict mode is non-negotiable.** All new code must pass `npm run lint` with
  zero errors.
- Use `noUncheckedIndexedAccess` — always guard array/record access (`.at(0)`,
  optional chaining, or explicit bounds checks).
- Prefer `interface` over `type` for object shapes that represent DI ports.
- Never use `any`. Use `unknown` and narrow it.
- All async functions must handle errors explicitly; never let a `Promise` reject silently.
- Use `.js` extensions in all `import` paths (ESM NodeNext requirement).

### Architecture (DI Layer)

- The `Core Engine` (`src/core/`) must have **zero** `import` statements that reach
  into `src/infrastructure/` or `src/cli/`. Violating this breaks the DI contract.
- New OS-level operations belong in `src/infrastructure/`; expose them via an
  interface in `src/core/interfaces.ts`.
- `process.env` reads belong in `src/cli/index.ts` or a `PipelineConfig` object
  passed at construction time — never inside `orchestrator.ts`.

### Naming

- Files: `kebab-case.ts`
- Classes / Interfaces: `PascalCase` (interfaces prefixed with `I`, e.g. `IFileSystem`)
- Enums: `PascalCase` members
- Private class fields: `#prefixed` (ES2022 hard-private syntax)
- Test helpers / stubs: suffix with `Stub` or `Mock`

### Imports

- Always prefer named imports over default imports.
- Group imports: (1) Node built-ins, (2) third-party, (3) internal — separated by
  a blank line.

---

## 6. Testing Standards

- **Framework**: Vitest 4.x. Import from `vitest`, not `jest`.
- **File location**: `test/` directory, mirroring the `src/` structure.
- **Coverage**: Every new public method or interface must have at least one
  positive and one negative test.
- **Mocks**: Use `vi.fn()` and typed stubs; never mock the entire module unless
  there is no alternative. Stubs must satisfy the full DI interface.
- **No real I/O**: Tests must not touch the real filesystem, run real git commands,
  or invoke the real `opencode` binary. Use the injected DI interfaces and stub them.
- After any refactoring step, run `npm run lint && npm test` before committing.
- The test suite must stay green at 100% pass rate — never comment out or `.skip`
  a failing test; fix it.

---

## 7. Git Conventions

- **Branch naming**: `feat/<issue-ref>-<slug>`, `fix/<slug>`, `refactor/<slug>`
- **Commit message format (Human)**:
  ```
  <type>(<scope>): <short imperative description>
  ```
  Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- **Commit message format (Agent)**:
  Agents MUST use the strict pipeline format: `chore(ai): pass-[N] – <description>`
- **One logical change per commit.** The 8-pass pipeline itself enforces this —
  mirror the same discipline in your own commits.
- Never commit directly to `main`. Always branch and PR.
- Do not commit generated files (`dist/`, `*.tsbuildinfo`).

---

## 8. Agent Prompt Files (`src/agents/`)

The `src/agents/pass-*.md` files are the prompts fed to opencode sub-agents. When
editing them:
- Preserve the YAML frontmatter (`model`, `tools`, `permissions`).
- Keep scope narrow — each agent is responsible for exactly one pass.
- Never grant an agent permission to read or write files outside its declared scope.
- After editing, rebuild with `npm run build` so the updated prompts are copied to `dist/agents/`.

---

## 9. Environment & Secrets

- `.env` holds the model-provider API keys (`OPENROUTER_API_KEY` for the default openrouter-routed models; `DEEPSEEK_API_KEY` when overriding to the `deepseek/...` provider). Never commit secrets.
- `.env.example` is the committed template.
- **NEVER** log, echo, or output the contents of `.env` to the terminal to prevent secret leakage into agent transcripts.
- The orchestrator must never read `process.env` directly — see § 5 (Architecture).
- LiteLLM proxy (optional): see `infra/docker-compose.yml` for enterprise routing.

---

## 10. Do Not Do

- Do not introduce runtime dependencies without documenting the decision as an Architecture Decision Record (see `docs/architecture/README.md` for the ADR process and index).
- Do not use `const enum` — it breaks `isolatedModules`. Use regular `enum`.
- Do not use `as any` or `// @ts-ignore` as a shortcut.
- Do not merge failing tests — fix them. Or ask the user if you are unable to fix.
- Do not skip the `codebase-memory-mcp` indexing step at the start of a session.
- Do not run `opencode` or make real API calls in tests.
- Do not modify `dist/` manually — it is generated.

---

## 11. Git Commit Conventions & Release Lifecycle (STRICT)

**Commit Format:** All git commits MUST strictly follow the Conventional Commits specification
(`<type>(<scope>): <description>`). Our automated release system (Release Please) relies on
these prefixes to bump versions and write the `CHANGELOG.md`.
- `feat:` -> MINOR bump (New features)
- `fix:` -> PATCH bump (Bug fixes)
- `feat!:` or `fix!:` -> MAJOR bump (Breaking changes)
- `chore:`, `docs:`, `test:`, `refactor:` -> No bump, but recorded.

**Branching Strategy:**
1. All work is done on feature branches and PR'd into `dev`. Never commit directly to `main`.
2. `main` is the production branch and contains only released code.
3. Direct PRs to `main` may only originate from `dev` (enforced by `.github/workflows/enforce-dev-base.yml`).

**Release Lifecycle:** Releases, version bumps, changelog generation, and the `main` → `dev`
back-merge are automated via `.github/workflows/release-and-sync.yml`.
**See `RELEASE_PROCESS.md` for the full step-by-step release lifecycle.**
