/**
 * CLI Registry and Init/Remove Subcommands Module
 * 
 * This module handles the registration of projects that have initialized the agentic-tdd pipeline,
 * and the logic for the `init` and `remove` subcommands.
 * 
 * Constants:
 * - `AGENT_STAMP_FILE = ".agentic-tdd-version"`
 * - `REGISTRY_FILE` = located in XDG_DATA_HOME/agentic-tdd/projects.json or ~/.local/share/...
 * 
 * Functions to implement:
 * 1. `getBundledAgentsDir(): string` - Returns the absolute path to the bundled agent `.md` files in this npm package (e.g., using `__dirname`).
 * 2. `loadRegistry(): string[]` - Reads the JSON registry file and returns an array of paths.
 * 3. `saveRegistry(paths: string[]): void` - Deduplicates, sorts, and writes paths to the registry file.
 * 4. `registerProject(projectDir: string): void` - Adds a path to the registry.
 * 5. `deregisterProject(projectDir: string): void` - Removes a path from the registry.
 * 6. `checkAgentFreshness(cwd: string, currentVersion: string): void` - Checks if `.opencode/agent/.agentic-tdd-version` matches `currentVersion`. Logs a warning if missing or outdated.
 * 7. `cmdInit(force: boolean, currentVersion: string): void` - Copies bundled `.md` files to `cwd/.opencode/agent/`. Skips existing unless `force` is true. Writes the version stamp and registers the project. Logs results.
 * 8. `cmdRemove(removeAll: boolean, skipConfirm: boolean): void` - If `removeAll` is true, deletes `.opencode/agent/` from all registered projects and clears registry. Otherwise, deletes it from CWD only and deregisters it. Respects `skipConfirm`.
 */
