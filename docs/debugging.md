# Dimensional Logging & Debugging

The `agentic-tdd` pipeline uses the industry-standard [`debug`](https://www.npmjs.com/package/debug) package to provide dimensional, hierarchal logging. This allows developers to selectively enable debug output for specific areas of the application, such as the core orchestrator, individual infrastructure adapters, or specific AI agent passes.

## Quick Start

You can enable all debug logs by passing the `--log-level DEBUG` flag to the CLI, or by setting `DEBUG=orchestrator:*`.

```bash
# Enable all orchestrator logs
DEBUG=orchestrator:* npx agentic-tdd specs/my-feature.md
```

## Namespace Architecture

All logs in the project are scoped under the `orchestrator:` namespace prefix. 

### High-Level Layers
- `orchestrator:cli` — UI and initial bootstrap code in `src/cli/index.ts`.
- `orchestrator:core` — The primary state machine and pipeline transitions in `src/core/orchestrator.ts`.

### Infrastructure Adapters
These namespaces handle low-level OS/system integrations in `src/infrastructure/`.
- `orchestrator:infra:git` — Git command executions.
- `orchestrator:infra:fs` — File system reads/writes.
- `orchestrator:infra:cmd` — Subprocess spawning (via `execa`).
- `orchestrator:infra:events` — Internal EventBus emissions.

### Subagents
Each of the 8 passes triggers an AI subagent. These use a dynamic namespace pattern based on the agent's file name located in `.opencode/agent/`.

- `orchestrator:agent:pass-0-design-agent`
- `orchestrator:agent:pass-1-contracts-agent`
- `orchestrator:agent:pass-2-test-generation-agent`
- `orchestrator:agent:pass-3-core-implementation-agent`
- `orchestrator:agent:pass-4-refactor-agent`
- `orchestrator:agent:pass-5-security-agent`
- `orchestrator:agent:pass-6-observability-agent`
- `orchestrator:agent:pass-7-documentation-agent`

## Examples

**Example 1:** Debug only the Core Engine and the Test Generation pass:
```bash
DEBUG=orchestrator:core,orchestrator:agent:pass-2-test-generation-agent npx agentic-tdd ...
```

**Example 2:** See all agent prompt payloads and responses, but silence the core and infrastructure:
```bash
DEBUG=orchestrator:agent:* npx agentic-tdd ...
```

**Example 3:** Debug git and filesystem operations:
```bash
DEBUG=orchestrator:infra:git,orchestrator:infra:fs npx agentic-tdd ...
```

## Developer Notes

If you are adding a new module or modifying an existing one, please ensure you import and use the centralized logger from `src/utils/logger.ts` rather than directly creating `debug` instances in your code. This ensures consistency with the above namespace hierarchy.

```typescript
import { loggers } from '../utils/logger.js';

// In an infrastructure file
loggers.infra.git('Committing file %s', filename);

// In core
loggers.core('Transitioning to pass %d', nextPass);
```
