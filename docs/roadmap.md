# Roadmap

Items in no particular order of priority. Contributions welcome — see the [architecture manifesto](architecture-manifesto.md) for design context.

## Planned

- [ ] Modularise `pipeline_v3_1.py` into a proper Python package with a clean CLI entry point
- [ ] Run a full pipeline against a real-world feature and document the results
- [ ] Figure out how to invoke the pipeline from a ticket/issue (GitHub Actions integration)
- [ ] Dev mode vs. debug mode — should there be separate verbosity levels and dry-run support?
- [ ] Handling agent failures and infinite loops. Further enhancement - Orchestrator captures the stdout/stderr, saves it to logs/pass_n_failures.txt. Orchestrator prompts the agent again, appending the failure log. This will ensure agents try new approaches different from what they tried before.  
- [ ] Better LiteLLM config using Postgres for budget tracking (see `infra/` for current setup)
- [ ] Bloop integration for cross-repo semantic context retrieval
- [ ] VS Code extension / cleaner HITL flow for reviewing and editing artifact files (`.mmd`, `.gherkin`) during the Pass 0 gate. 
- [ ] Better HITL overall - this will keep improving once we start using this tool in real projects and tickets.
- [ ] Semgrep integration as a hard-fail gate between passes (see architecture manifesto § 4.3)
- [ ] DevContainer / Nix flake for deterministic agent sandboxing (see architecture manifesto § 2.3)
- [ ] Benchmarking: quantify token savings from Static Prefix caching across model providers
- [ ] Improve security agent - input sanitisation, zip bombs, size restrictions etc. Do we need different frameworks for frontend, backend and desktop apps ?
- [ ] Pass 0 - better workflow - make a git branch before working on the problem.
- [ ] Have a maker-checker pattern for soem critical parts like specs and mmd. 
- [ ] Implement dev mode and debug mode and other best practices. This should ideally be in the prompt for one of the initial passes where we should check if this already exists and implement existing patterns. All implementations should be in dev mode by default. Do we need a separate pass to convert dev mode to production mode? Maybe a dry-run mode at the end?
- [ ] What if we need more than one diagram for the feature ? i.e. a sequence diagram, a state diagram and a flow chart?
- [ ] Pass 0 agent creates gherkin files which are not suitable for GUI applications. Need to address these separately. Maybe a different harness for GUI applications ? 
- [ ] Need to improve the naming of the gherkin and mmd files. 
- [ ] I think we need to enforce agenta to create new files in appropriate directories. Also, agents should not move files to various directories wily-nily. Check if we have any public 'git enforcement' agents. Else, create a 'git validation' agent which will ensure git hygiene.  
- [ ] We should be able to restart a pass if it fails. This should be easy since we have atomic commits and this is enough context to resstart from wherever it failed.
- [ ] Unit tests are a key component of our pipeline. What if the unit tests generated have errors ? Do we need manual review and correction ? We should probably have a maker/checker pattern ? (Maker and checker should have different models.) 
- [ ] Do we need a dedicated agent to implement stuff like "log-level" i.e. INFO DEBUG etc? Or do we integrate it into our current observability agent ? Maybe this should be subagents and configurable. 
- [ ] Consider XState/Temporal for future versions to handle more complex workflows. This will be useful when we have sub-agents for each pass and maker/checker patterns.
- [ ] Implement detailed log-level across the app's functionality - INFO, DEBUG etc and enable passing it via command line.
- [ ] Should we be able to run individual passes ? Specificy the pass at command line ? This will help in re-using agents. Going forward, this will also help in different orchestrator patterns. 
- [ ] Move the opencode agents to main repo and add some kind of 'init' script to copy them into the right location. Also have a 'clean' script to clean-up.


## Other architectural debates and discussions

- [ ] Swap Pass 5 and Pass 6.
    - [ ] New Pass 5: Observability & Error Handling. The agent builds the try/catch blocks, defines the error classes, and drops in the log statements.
    - [ ] New Pass 6: Security Hardening (The Final Gate). The Security agent now reviews the complete feature—including the error handlers. It will see the raw logger.error from Pass 5 and correctly modify it to mask PII, and it will sanitize the API response so the stack trace isn't leaked to the client.
- Relook at the compaction and context management. There is scope for further optimisation. 
- [] We should use joern or some kind of solid code analysis too to provide better context to agents. This will reduce hallucination, reduce retries and thereby improve accuracy. This should also reduce costs as the context will be precise and have lesser retries. Better the code indexing, better the overall quality.  
- [] We will improve the prompts of all agents in the system. 
- [] We will introduce maker/checker for each pass.
-  [] Each Pass and in turn become an independent agentic system in its own right with its own orchestrator.
- [ ] The "Security Orchestrator" Pattern
    - [ ] Instead of one massive security prompt, Pass 6 should invoke a Security Orchestrator Agent. This agent reads the design.mmd to figure out what type of code it is looking at, and then delegates to specialized experts:
        - [ ] Sub-Agent 1: The Payload Specialist (Checks for Zip Bombs/Decompression attacks, JSON size limits, XML External Entities).
        - [ ] Sub-Agent 2: The Data Sanitizer (Checks Regex constraints, SQL Injection, Prototype Pollution).
        - [ ] Sub-Agent 3: The Context Expert (Frontend vs. Backend)
          - [ ] If the code is React/Next.js, it looks for XSS and missing CSRF tokens.
          - [ ] If the code is Node/Python backend, it looks for SSRF and broken access control. 
- [ ] When implementing a security fix or a feature, we will enforce a strict resolution heirarchy. AI agent may generate code by importing random libraries (e.g., pulling in DOMPurify when you already use xss, or adding Joi when your project uses Zod
  - [ ] Heirarchy - 
    1. CURRENT PATTERNS: Look at the existing codebase context (via Bloop/imports). Does the team already have a custom utility for this? (e.g., `src/utils/sanitizer.ts`). If yes, use it.
    2. CURRENT LIBRARIES: Look at the `package.json` / `requirements.txt`. Do we already have an installed library capable of this? (e.g., Zod, DOMPurify). If yes, use it.
    3. FRAMEWORK NATIVE: Can this be solved using the native standard library or framework defaults without adding dependencies? (e.g., Django's built-in validators, Python's native `json` limits). If yes, use it.
    4. NEW DEPENDENCY: ONLY if 1, 2, and 3 fail, propose adding a highly standard, vetted enterprise library (and flag it for human review).  


## Completed

- [x] 8-pass pipeline orchestrator (`src/pipeline_v3_1.py`)
- [x] Static Prefix anchoring (immutable file ordering for cache hits)
- [x] Context Compaction (disposable error logs, clean pass starts)
- [x] Self-correction loop (max 2 retries per guarded pass)
- [x] Human-in-the-Loop gate after Pass 0
- [x] Atomic git commits per pass
- [x] Agent guardrails via `.opencode/agents.xml` and per-agent `.md` files
- [x] OpenRouter + LiteLLM proxy configuration (`infra/`)
- [x] Verified integration example (`examples/basic-addition/`)

## Command to run: (Todo: explain in detail)
- agentic-tdd --issue "Create tkinter app using pytest.  Refer to specs/tictactoe-frontned-prompt.md" --test-cmd "pytest"
- Other misc:
-   npm run build
-   npm link
-   npm uninstall -g agentic-tdd 
-   cp -r path/to/agentic-tdd-node/.opencode .
-   npx agentic-tdd run --spec /path/to/my_feature.md

