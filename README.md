# agentic-tdd

**An artifact-driven, 8-pass agentic pipeline for enterprise software development using OpenCode.**

> _"Stop asking AI to write code. Start orchestrating AI to build software."_

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org)

---

## The Problem

Ad-hoc agentic coding fails at the enterprise level for three reasons:

1. **Context Bloat** — Dumping entire codebases into a single prompt burns millions of tokens and causes "lost in the middle" attention drift.
2. **Spaghetti Edits** — Asking one model to write logic, enforce security, and format logs simultaneously causes "lazy coding" on at least one constraint.
3. **Specification Drift** — Agents change the code but leave the architecture docs untouched, creating a legacy codebase on day one.

## The Solution: AI as an Assembly Line

Instead of a zero-shot prompt, this framework breaks software development into a **strict 8-pass sequential pipeline**. Each pass is handled by a specialized sub-agent with a deeply constrained scope.

```
Pass 0  Design & Architecture  →  design.mmd + spec.gherkin  [HITL gate]
Pass 1  Contracts & Types      →  type stubs in source files
Pass 2  TDD Test Generation    →  test file                   [Red Phase]
Pass 3  Core Implementation    →  logic                       [Green Phase + self-correction]
Pass 4  Refactor & Optimise    →  complexity/DRY              [self-correction]
Pass 5  Security Hardening     →  OWASP Top-10               [self-correction]
Pass 6  Observability & Logs   →  logging + error classes     [self-correction]
Pass 7  Documentation          →  docstrings + @see links
```

Each guarded pass runs your local test suite and self-corrects (up to 2 retries) before advancing. Every pass produces an **atomic git commit** — so if an agent breaks something, you `git revert` one step and retry.

---

## Architecture at a Glance

```mermaid
stateDiagram-v2
    classDef human fill:#08427b,color:#fff,stroke:#052e56,stroke-width:2px
    classDef agent fill:#1168bd,color:#fff,stroke:#0b4884,stroke-width:2px
    classDef testGate fill:#2dd4bf,color:#000,stroke:#0f766e,stroke-width:2px

    [*] --> Pass_0

    Pass_0 : Pass 0 - Design & Context (Agent)
    class Pass_0 agent

    HITL : Developer Review (HITL)
    class HITL human

    Pass_0 --> HITL : Outputs .mmd & .gherkin
    HITL --> Pass_0 : Request Architecture Changes
    HITL --> Pass_1 : Approve Specs

    Pass_1 : Pass 1 - Contracts & Types (Agent)
    class Pass_1 agent

    Pass_2 : Pass 2 - Test Generation [Red Phase]
    class Pass_2 agent

    Pass_1 --> Pass_2
    Pass_2 --> Pass_3

    Pass_3 : Pass 3 - Core Logic [Green Phase]
    class Pass_3 agent

    Gate_3 : Test Runner (Verify Core)
    class Gate_3 testGate

    Pass_3 --> Gate_3
    Gate_3 --> Pass_3 : Tests Failed (Fix Core)
    Gate_3 --> Pass_4 : Tests Passed

    Pass_4 : Pass 4 - Clean Code & Refactor
    class Pass_4 agent

    Gate_4 : Test Runner (Verify Refactor)
    class Gate_4 testGate

    Pass_4 --> Gate_4
    Gate_4 --> Pass_4 : Refactor Broke Logic (Revert & Fix)
    Gate_4 --> Pass_5 : Tests Passed

    Pass_5 : Pass 5 - Security Hardening
    class Pass_5 agent

    Gate_5 : Test Runner (Verify Security)
    class Gate_5 testGate

    Pass_5 --> Gate_5
    Gate_5 --> Pass_5 : Security Blocked Valid Logic (Fix)
    Gate_5 --> Pass_6 : Tests Passed

    Pass_6 : Pass 6 - Observability & Logs
    class Pass_6 agent

    Gate_6 : Test Runner (Verify Observability)
    class Gate_6 testGate

    Pass_6 --> Gate_6
    Gate_6 --> Pass_6 : Logs Broke Scopes/Types (Fix)
    Gate_6 --> Pass_7 : Tests Passed

    Pass_7 : Pass 7 - Sync Docs & Spec Artifacts
    class Pass_7 agent

    Gate_7 : Final CI/CD Verification
    class Gate_7 testGate

    Pass_7 --> Gate_7
    Gate_7 --> Pass_7 : Spec Drift Detected (Update Specs)
    Gate_7 --> [*] : Branch Ready for PR
```

### Decoupled Architecture (Node.js / TypeScript)

This is a ground-up rewrite of the Python orchestrator, designed for extensibility:

| Layer | Technology | Role |
|---|---|---|
| **Core Engine** (`src/core/`) | Pure TypeScript state machine | Pipeline state transitions, pass scheduling, self-correction loop |
| **OS Integrations** (`src/infrastructure/`) | Dependency Injection via interfaces | File system, Git, subprocess execution (`execa`), EventBus |
| **CLI** (`src/cli/`) | Commander.js | Argument parsing, terminal UX (banners, HITL prompts, pass headers) |

The Core Engine has zero knowledge of filesystems, Git, or shell commands. All OS interactions are injected. This means the exact same engine can drive:

- A **native VS Code extension** (swap `NodeFileSystem` for `VSCodeFileSystem`, `CommandRunner` for `VSCodeTerminal`).
- A **web dashboard** (swap the EventBus listener for a WebSocket broadcaster).
- A **GitHub Actions runner** (swap the Git service for the GitHub API).

### Three Cost-Critical Invariants

| Invariant | What it does |
|---|---|
| **Static Prefix** | Files are attached in a locked order (`design.mmd` → `spec.gherkin` → source code). Every pass shares the same cacheable prefix → ~90% discount on input tokens. |
| **Context Compaction** | Error logs are written to `.opencode_error.log`, then deleted the moment tests pass. No debugging context bleeds across passes. |
| **Single-Model Lock** | Model is declared in each agent's YAML frontmatter — never overridden by the orchestrator. Cache pool stays intact. |

---

## Repository Structure

```
agentic-tdd-node/
├── .opencode/                # Agent engine: agents.xml + 8 agent .md files
│   └── agent/                # One .md file per pipeline pass
├── docs/
│   ├── architecture-manifesto.md   # Full design rationale & diagrams
│   └── roadmap.md
├── examples/
│   └── basic-addition/       # Verified integration test (run this first!)
│       ├── basic_addition.py
│       ├── basic_addition_test.py
│       ├── design.mmd
│       └── spec.gherkin
├── infra/
│   ├── docker-compose.yml    # LiteLLM proxy stack
│   └── litellm_config.yaml   # Model routing configuration
├── src/
│   ├── core/                 # Pipeline orchestrator (pure state machine)
│   │   ├── orchestrator.ts   # 8-pass sequential pipeline engine
│   │   └── types.ts          # Pipeline pass enums, context & event types
│   ├── infrastructure/       # DI-wired OS adapters
│   │   ├── file-system.ts    # IFilesystem → NodeFileSystem
│   │   ├── git-service.ts    # IGitService → GitService
│   │   ├── command-runner.ts # ICommandRunner → CommandRunner (execa)
│   │   └── event-bus.ts      # IEventBus → EventBus
│   └── cli/
│       └── index.ts          # Commander.js CLI entrypoint
├── test/                     # Vitest test suite
├── package.json
├── tsconfig.json
└── README.md
```

---

## Quick Start

### Prerequisites

- **Node.js >= 22**
- [opencode CLI](https://opencode.ai) (`npm install -g opencode-ai`)
- An [OpenRouter](https://openrouter.ai) API key
- `git` initialized in your working directory

### 1. Install dependencies

```bash
git clone https://github.com/Digital-Assistant/agentic-tdd-node.git
cd agentic-tdd-node
npm install
```

### 2. Build the TypeScript source

```bash
npm run build
```

### 3. Link globally (optional — for `agentic-tdd` on your PATH)

```bash
npm link
```

### 4. Configure your API key

```bash
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY
```

### 5. Run the example

```bash
# Run the full 8-pass pipeline against the basic-addition example
npx agentic-tdd examples/basic-addition/basic_addition.py

# Skip the human approval gate (for CI/automated use)
npx agentic-tdd examples/basic-addition/basic_addition.py --skip-hitl

# Just run the tests directly (no API calls)
pytest examples/basic-addition/ -v
```

### 6. Run against your own file

```bash
npx agentic-tdd path/to/your/module.py --test-cmd "pytest path/to/tests/ -x"
npx agentic-tdd path/to/your/module.ts --test-cmd "npm test"
```

If you ran `npm link`, you can also use the bare command:

```bash
agentic-tdd specs/my_feature.md --skip-hitl
```

---

## CLI Usage

```
agentic-tdd [spec_file] [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--test-cmd <command>` | `npm test` | Test command to run after each guarded pass. |
| `--skip-hitl` | `false` | Skip the human approval gate after Pass 0 (for CI/CD). |
| `--issue <ref>` | — | Issue ref (e.g. `123` or `PAY-404`) to auto-create a feature branch. |
| `--base-branch <name>` | — | Base branch for auto-branching (bypasses the `main` guardrail). |
| `--log-level <level>` | `INFO` | Logging verbosity. Choices: `DEBUG` \| `INFO` \| `WARNING` \| `ERROR`. |



---

## The Infrastructure Layer (Optional)

For enterprise use, route all agent traffic through a self-hosted **LiteLLM** proxy. This gives you:

- **Budget control** per developer/department
- **Model routing** (cheap models for docs, frontier models for security)
- **PII masking** before prompts leave your network

```bash
cd infra/
docker compose up -d
# LiteLLM proxy now running at http://localhost:4000
```

See `docs/architecture-manifesto.md` for the full enterprise architecture including SSO, Bloop semantic indexing, and DevContainer sandboxing.

---

## Agent Configuration

Agents are defined in `.opencode/agents.xml` and `.opencode/agent/*.md`. Each agent file has YAML frontmatter that locks the model, permissions, and scope.

The pipeline enforces that agents can only:

- **Read**: their assigned files (`design.mmd`, `spec.gherkin`, source code)
- **Write**: only the files appropriate to their pass (e.g., the Docs agent can only edit comments)
- **Execute**: nothing — no bash, no web fetch

See `docs/architecture-manifesto.md` § 4 for the full agent guardrail design.

---

## Development

```bash
# Clone and install
git clone https://github.com/Digital-Assistant/agentic-tdd-node.git
cd agentic-tdd-node
npm install

# Build
npm run build

# Run the test suite (Vitest)
npm test

# Watch mode
npm run test:watch

# Type-check only (no emit)
npm run lint
```

---

## Roadmap

- [x] 8-pass pipeline orchestrator (TypeScript state machine)
- [x] Decoupled Core Engine / OS layer (Dependency Injection)
- [x] Commander.js CLI with terminal UX
- [x] Self-correction loop (max 2 retries per guarded pass)
- [x] Human-in-the-Loop gate after Pass 0
- [x] Atomic git commits per pass
- [x] Agent guardrails via `.opencode/agents.xml`
- [x] Vitest test suite (72 tests, 100% pass rate)
- [ ] VS Code extension (native HITL UX, inline diagram preview)
- [ ] Bloop integration for cross-repo semantic context retrieval
- [ ] Semgrep hard-fail gates between passes
- [ ] DevContainer / Nix flake for deterministic agent sandboxing

See `docs/roadmap.md` for the full list.

---

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE) for details.

This means: you can use, study, and modify this freely. If you run a modified version as a network service, you must release your modifications under the same license.
