# agentic-tdd — CLI Installation & Usage Guide

> **Package version:** 1.0.0
> **Pipeline version:** 1.0.0
> **Entrypoint:** `agentic-tdd`

---

## Overview

`agentic-tdd` is the npx-executable CLI that drives the **8-pass AI factory pipeline**. Once installed, any developer can run it from any project root without manually invoking `node dist/cli/index.js`.

The CLI is CWD-aware: it always executes `opencode` in the directory from which you invoked `agentic-tdd`, picks up `.env` from there, and resolves all file paths relative to that location — regardless of where the package is installed.

---

## Installation

### Option A — `npm link` (recommended for local global usage)

```bash
# Clone the repo (or cd into your local copy)
git clone https://github.com/Digital-Assistant/agentic-tdd-node.git
cd agentic-tdd-node

# Install dependencies and build
npm install
npm run build

# Link globally (creates a symlink on your PATH)
npm link
```

After link, `agentic-tdd` is on your `PATH` permanently. It picks up the `.opencode/` agent files bundled with the repo — no separate `init` step needed.

To update:

```bash
git pull
npm install
npm run build
```

### Option B — `npx` (no global install)

```bash
# Clone the repo
git clone https://github.com/Digital-Assistant/agentic-tdd-node.git
cd agentic-tdd-node

# Install and build
npm install
npm run build

# Run from any project directory
npx agentic-tdd [spec_file] [options]
```

### Option C — `npm install -g .` (global install from local)

```bash
# Inside the repo directory
npm install -g .
```

---

## Prerequisites

Before running the pipeline, ensure:

| Requirement | How to get it |
|---|---|
| Node.js >= 22 | [nodejs.org](https://nodejs.org) |
| `opencode` CLI | `npm install -g opencode-ai` |
| `OPENROUTER_API_KEY` | Add to `.env` in your project root |
| `git` initialised | `git init` in your project directory |

The `.opencode/` directory (with `agents.xml` and agent `.md` files) is bundled with the package. No separate `init` command is required.

---

## Usage

```
agentic-tdd INPUT_SOURCE [options]
```

### Positional argument

| Argument | Description |
|---|---|
| `INPUT_SOURCE` | The pipeline input. Meaning depends on `--source-type` (default: a file path). |

### Options

| Flag | Default | Description |
|---|---|---|
| `--source-type TYPE` | `file` | How to interpret `INPUT_SOURCE`. Choices: `file` \| `string` \| `github`. |
| `--test-cmd CMD` | auto-inferred | Shell command to run the test suite after each guarded pass. |
| `--skip-hitl` | `false` | Skip the human approval gate after Pass 0 (for CI/CD). |
| `--issue REF` | — | Issue ref (e.g. `123` or `PAY-404`) to auto-create a feature branch. |
| `--base-branch NAME` | — | Base branch for auto-branching (bypasses the `main` guardrail). |
| `--log-level LEVEL` | `INFO` | Logging verbosity. Choices: `DEBUG` \| `INFO` \| `WARNING` \| `ERROR`. |

---

## Examples

### Run the full pipeline against a Python file

```bash
cd /path/to/my-project
npx agentic-tdd src/my_module.py
```

Or if installed globally via `npm link`:

```bash
agentic-tdd src/my_module.py
```

### Run against a TypeScript file

```bash
agentic-tdd src/my_module.ts --test-cmd "npm test"
```

### Skip the HITL gate (CI mode)

```bash
agentic-tdd src/my_module.py --skip-hitl
```

### Custom test command

```bash
agentic-tdd src/my_module.py --test-cmd "pytest tests/ -k my_module -x -v"
```

### Auto-create a feature branch from an issue reference

```bash
# branches from HEAD (must not be `main`)
agentic-tdd src/payments.py --issue "PAY-404"

# branch from a specific base, bypassing the main guardrail
agentic-tdd src/payments.py --issue "PAY-404" --base-branch dev
```

### Enable debug logging

```bash
agentic-tdd src/my_module.py --log-level DEBUG
```

**Advanced Debugging:**
The project uses the `debug` module, giving you fine-grained control over what gets logged via the `DEBUG` environment variable. The `--log-level DEBUG` flag is just a shortcut for `DEBUG=orchestrator:*`.

To log *only* the core orchestrator and the design agent:
```bash
DEBUG=orchestrator:core,orchestrator:agent:pass-0-design-agent agentic-tdd src/my_module.py
```
*(For more details, see [docs/debugging.md](docs/debugging.md))*

### Future: string or GitHub issue input *(not yet implemented)*

```bash
# Placeholder — will materialise the feature description as a temp file
agentic-tdd "Add OAuth2 login flow" --source-type string

# Placeholder — will fetch the issue body via the GitHub API
agentic-tdd https://github.com/org/repo/issues/42 --source-type github
```

---

## The 8-Pass Pipeline

```
Pass 0  Design & Architecture   ->  design.mmd + spec.gherkin  [HITL gate]
Pass 1  Contracts & Types       ->  type stubs in source files
Pass 2  TDD Test Generation     ->  test file                   [Red Phase]
Pass 3  Core Implementation     ->  logic                       [Green Phase + SC]
Pass 4  Refactor & Optimise     ->  complexity/DRY              [SC]
Pass 5  Security Hardening      ->  OWASP Top-10               [SC]
Pass 6  Observability & Logs    ->  logging + error classes     [SC]
Pass 7  Documentation           ->  docstrings + @see links

SC   = Self-correction loop (max 2 retries, then abort with diagnostics)
HITL = Human-in-the-Loop review gate
```

## Architecture

The CLI is built on a decoupled, Dependency-Injected architecture:

| Layer | Technology | Role |
|---|---|---|
| **Core Engine** (`src/core/`) | Pure TypeScript state machine | Pipeline state transitions, pass scheduling, self-correction loop |
| **OS Integrations** (`src/infrastructure/`) | DI via interfaces | File system, Git, subprocess execution (`execa`), EventBus |
| **CLI** (`src/cli/`) | Commander.js | Argument parsing, terminal UX (banners, HITL prompts, pass headers) |

The Core Engine has zero knowledge of filesystems, Git, or shell commands. All OS interactions are injected — making the engine reusable in a VS Code extension, a web dashboard, or a CI runner without modification.

---

## Package Structure

```
agentic-tdd-node/
├── src/
│   ├── core/
│   │   ├── orchestrator.ts    # 8-pass sequential pipeline engine
│   │   └── types.ts           # Pipeline pass enums, context & event types
│   ├── infrastructure/
│   │   ├── file-system.ts     # IFilesystem → NodeFileSystem
│   │   ├── git-service.ts     # IGitService → GitService
│   │   ├── command-runner.ts  # ICommandRunner → CommandRunner (execa)
│   │   └── event-bus.ts       # IEventBus → EventBus
│   └── cli/
│       └── index.ts           # Commander.js CLI entrypoint
├── test/                      # Vitest test suite
├── .opencode/                 # Agent engine (agents.xml + agent/*.md)
├── infra/                     # Docker Compose + LiteLLM configs
├── docs/                      # Architecture manifesto & roadmap
├── package.json
├── tsconfig.json
├── README.md                  # Project overview
└── README-CLI.md              # This file — install & usage guide
```

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

# Verify the CLI is wired correctly
npx agentic-tdd --help
```

---

## Uninstall

To remove the CLI:

```bash
# If installed via npm link
npm unlink -g agentic-tdd

# If installed via npm install -g
npm uninstall -g agentic-tdd
```
