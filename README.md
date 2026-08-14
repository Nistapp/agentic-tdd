# agentic-tdd

**An artifact-driven, 8-pass agentic pipeline for enterprise software development using OpenCode.**

> _"Stop asking AI to write code. Start orchestrating AI to build software."_

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org)

---

## The Problem

Ad-hoc agentic coding fails at the enterprise level for multiple reasons:

1. **Context Bloat** — Dumping entire codebases into a single prompt burns millions of tokens and causes "lost in the middle" attention drift.
2. **Spaghetti Edits** — Asking one model to write logic, enforce security, and format logs simultaneously causes "lazy coding" on at least one constraint.
3. **Specification Drift** — Agents change the code but leave the architecture docs untouched, creating a legacy codebase on day one.
4. **Lack of Formal development Process and quality gating** - This leads to inconsistent code quality, security vulnerabilities, and drift from the intended architecture.

## The Solution: AI as an Assembly Line

Instead of a zero-shot prompt, this framework breaks software development into a **strict 8-pass sequential pipeline**. Each pass is handled by a specialized sub-agent with a deeply constrained scope.

```
Pass 0  Design & Architecture  →  design.mmd + spec.gherkin  [HITL gate]
Pass 1  Contracts & Types      →  type stubs in source files
Pass 2  TDD Test Generation    →  test file                   [Red Phase]
Pass 3  Core Implementation    →  logic                       [Green Phase + self-correction]
Pass 4  Refactor & Optimise    →  complexity/DRY              [self-correction]
Pass 5  Observability & Logs   →  logging + error classes     [self-correction]
Pass 6  Security Hardening     →  Secure Code + OWASP         [self-correction]
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

    Pass_5 : Pass 5 - Observability & Logs
    class Pass_5 agent

    Gate_5 : Test Runner (Verify Observability)
    class Gate_5 testGate

    Pass_5 --> Gate_5
    Gate_5 --> Pass_5 : Logs Broke Scopes/Types (Fix)
    Gate_5 --> Pass_6 : Tests Passed

    Pass_6 : Pass 6 - Security Hardening
    class Pass_6 agent

    Gate_6 : Test Runner (Verify Security)
    class Gate_6 testGate

    Pass_6 --> Gate_6
    Gate_6 --> Pass_6 : Security Blocked Valid Logic (Fix)
    Gate_6 --> Pass_7 : Tests Passed

    Pass_7 : Pass 7 - Sync Docs & Spec Artifacts
    class Pass_7 agent

    Gate_7 : Final CI/CD Verification
    class Gate_7 testGate

    Pass_7 --> Gate_7
    Gate_7 --> Pass_7 : Spec Drift Detected (Update Specs)
    Gate_7 --> [*] : Branch Ready for PR
```


### Summary of problems addressed

| Problem                                    | Coverage by harness | Harness coverage / mechanism                                                                | Notes                                                                   |
| ------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Reliability & failure rates                | Partially           | Deterministic sandboxing, strict pass gates, atomic commits, model routing, quota controls. | Reduces blast radius and improves recovery, but model errors still exist.    |
| Code quality & maintainability             | Yes                 | 8-pass pipeline, TDD, refactor pass, scope guardrails, atomic commits.                      | Directly targets spaghetti code and unreadable cross-cutting changes.        |
| Specification drift                        | Planned                 | Artifact-driven development, mandatory spec sync, Pass 7 documentation sync.                | Specs are treated as source of truth and kept in lockstep with code.         |
| Security vulnerabilities                   | Partially/Ongoing           | Security pass, DLP/PII masking, Semgrep hard-fail gates.                                    | Strong baseline, but deeper whole-repo analysis is still needed.             |
| Architectural / legacy context             | Partially           | codebase-memory-mcp (or similar MCP based semantic indexing), Pass 0 context retrieval, human approval of design artifacts.      | Improves codebase awareness, but large refactors still need human oversight. |
| Process bottlenecks / duplicate PRs        | Partially           | Atomic commits per pass, existing-context retrieval, CI gates before PR.                    | Helps review flow, but approval latency remains a tradeoff.                  |
| Observability & auditability               | Yes                 | Central telemetry, traceability links between code, tests, diagrams, and commits.           | Useful for compliance, debugging, and post-incident analysis.                |
| Benchmarking / measurement                 | No                  | No formal held-out benchmark or acceptance metric defined in the framework.                 | Needs explicit internal evals and pass/fail thresholds.                      |
| Prompt injection / agent scope creep       | Yes                 | XML prompts, strict scope locking, write permissions by pass.                               | Strong guardrail against agent trampling and instruction leakage.            |
| Semantic correctness / hidden logic errors | Partially           | Executable specs plus TDD and repeated verification gates.                                  | Better than ad-hoc coding, but still depends on test quality.                |
| Org rollout / pilot-to-production gap      | Partially           | Budgeting, model independence, workflow governance.                                         | Helps scale technically, but change management is still external.            |

---


## Quick Start

### Prerequisites

- **Node.js >= 22**
- [opencode CLI](https://opencode.ai) 
- An API key - [OpenRouter](https://openrouter.ai) or Claude or openAi codex (or configure opencode to use free models on openrouter or opencode Zen.)
- `git` initialized in your working directory

### 1. Install dependencies

```bash
git clone https://github.com/Nistapp/agentic-tdd.git
cd agentic-tdd
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
$ cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY
# something like "export OPENROUTER_API_KEY=sk-or-v1-............................."

$ source .env
```

### 6. Run against your own file

```bash
npx agentic-tdd --feature-desc-file ./src/artefacts/Prompt-3.md --log-level DEBUG --test-cmd "pytest"
```

If you ran `npm link`, you can also use the bare command:

```bash
agentic-tdd --feature-desc-file specs/my_feature.md --skip-hitl --test-cmd "pytest"
```

---

## CLI Usage

```
agentic-tdd -feature-desc-file <spec_file> [options]
```

### Options

| Command | Description |
| :--- | :--- |
| -V, --version | output the version number |
| --feature-desc-file <path> | Path to the feature description file (e.g. specs/feature.md) |
| --test-cmd <command> | Test command to run after each pass (language-specific) |
| --skip-hitl | Skip human-in-the-loop prompts |
| --base-branch <branch> | Base branch to create the feature branch from |
| --log-level <level> | Log level (DEBUG, INFO, WARNING, ERROR) (default: "INFO") |
| --resume | Resume an active Agentic TDD session |
| --abort | Abort the active session and rewind Git history |
| -h, --help | display help for command |


---

## Agent Configuration

Agents are defined in `src/agents/`. Each agent file has YAML frontmatter that locks the model, permissions, and scope.

The pipeline enforces that agents can only:

- **Read**: their assigned files (`design.mmd`, `spec.gherkin`, source code)
- **Write**: only the files appropriate to their pass (e.g., the Docs agent can only edit comments)
- **Execute**: nothing — no bash, no web fetch

See the Contributor Deep Dive — [Prompt Engineering & Agent Files](docs/architecture/contributor-deep-dive/02-prompt-engineering.md) for the full agent guardrail design.

---

## Uninstall

To remove the CLI:

```bash
# If installed via npm link
npm unlink -g agentic-tdd

# If installed via npm install -g
npm uninstall -g agentic-tdd
```

---

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE) for details.

This means: you can use, study, and modify this freely. If you run a modified version as a network service, you must release your modifications under the same license.
