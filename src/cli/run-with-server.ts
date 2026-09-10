/**
 * Guaranteed teardown for the gate-owned agent server.
 *
 * Every session entry point wraps orchestrator execution in
 * {@link runWithServer}. The active handle is also reachable from the CLI's
 * SIGINT / crash handlers via {@link closeActiveServer} so a server is never
 * left behind.
 */

import type { IAgentServerHandle } from '../core/interfaces.js';

let activeServer: IAgentServerHandle | undefined;

/** Expose the currently active server (if any). */
export function getActiveServer(): IAgentServerHandle | undefined {
  return activeServer;
}

/**
 * Close the active server, if any, and clear it. Idempotent and never throws —
 * safe to call from signal/crash handlers.
 */
export async function closeActiveServer(): Promise<void> {
  const server = activeServer;
  activeServer = undefined;
  if (server === undefined) return;
  try {
    await server.close();
  } catch {
    // Best-effort: never let teardown throw from a signal handler.
  }
}

/**
 * Run *fn* with guaranteed server teardown.
 *
 * The server is registered as active for the duration of the run so signal
 * handlers can close it early; `finally` always closes it and clears the
 * registry.
 */
export async function runWithServer<T>(
  server: IAgentServerHandle | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (server !== undefined) activeServer = server;
  try {
    return await fn();
  } finally {
    // Only close here if a signal handler did not already close it (which
    // clears the active registry first).
    if (server !== undefined && activeServer === server) {
      activeServer = undefined;
      try {
        await server.close();
      } catch {
        // Best-effort teardown; the run result/error is more important.
      }
    }
  }
}
