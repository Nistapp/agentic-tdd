import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IFileSystem, ILogger } from '../core/interfaces.js';

const execFileAsync = promisify(execFile);

const PLACEHOLDER = '__CODEBASE_MEMORY_MCP_BIN__';
const MCP_FILENAME = '.mcp.json';
const MCP_SERVER_KEY = 'codebase-memory';

/**
 * Records the outcome of materialising `.mcp.json` so the caller can
 * decide whether to tear it down when the pipeline finishes.
 */
export interface McpConfigResult {
  /** The harness created `.mcp.json` (it was absent before this run). */
  created: boolean;
  /** The harness merged its server entry into an existing `.mcp.json`. */
  merged: boolean;
  /** An existing codebase-memory entry was detected and left untouched. */
  kept: boolean;
  /** Exact final content written to `.mcp.json` (empty when {@link kept}). */
  writtenContent: string;
}

// ---------------------------------------------------------------------------
// Module-level helpers (pure, exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the `codebase-memory-mcp` binary for the
 * current platform. Uses `which` on POSIX / `where` on Windows.
 *
 * There is **no** hardcoded fallback: a missing binary is a hard error that
 * the mandatory indexer gate must surface as a fatal before any session is
 * spawned (never a dead MCP registration).
 *
 * Accepts an optional shell-out function so tests can inject a fake.
 *
 * @throws {Error} when the binary cannot be located on PATH.
 */
export async function resolveMcpBinary(
  exec?: (cmd: string, args: string[]) => Promise<string>,
): Promise<string> {
  const isWindows = process.platform === 'win32';
  const lookupCmd = isWindows ? 'where' : 'which';
  const lookupArgs = [isWindows ? 'codebase-memory-mcp.cmd' : 'codebase-memory-mcp'];

  const runner = exec ?? ((cmd: string, args: string[]) =>
    execFileAsync(cmd, args).then((r) => r.stdout)
  );

  let resolved: string | undefined;
  try {
    const stdout = await runner(lookupCmd, lookupArgs);
    const firstLine = stdout.split('\n')[0]?.trim();
    if (firstLine) resolved = firstLine;
  } catch {
    // Lookup failed — surface as a missing-binary error below.
  }

  if (!resolved) {
    throw new Error(
      'codebase-memory-mcp binary not found on PATH. ' +
      'Install the codebase-memory-mcp indexer (see its README) before running the pipeline.',
    );
  }
  return resolved;
}

/**
 * Derive the dist-package template path from this module's URL so the
 * template is resolved relative to the installed npm package, never
 * from the project's source tree.
 */
export function getMcpTemplateDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  return resolve(__filename, '..', '..');
}

// ---------------------------------------------------------------------------
// Public API — used by the CLI/DI layer
// ---------------------------------------------------------------------------

/**
 * Materialise `.mcp.json` in *workDir* from the shipped template.
 *
 * @param fs         Injected filesystem (never raw `node:fs`).
 * @param logger     Injected logger for info/warn messages.
 * @param workDir    Project root where `.mcp.json` should be written.
 * @param templatePath  Absolute path to `mcp.template.json`.
 * @param resolvedBin   Pre-resolved binary path (defaults to calling
 *                      {@link resolveMcpBinary} when omitted, so tests
 *                      can inject a fixed value).
 */
export async function writeMcpConfig(
  fs: IFileSystem,
  logger: ILogger,
  workDir: string,
  templatePath: string,
  resolvedBin?: string,
): Promise<McpConfigResult> {
  const bin = resolvedBin ?? await resolveMcpBinary();
  const templateRaw = await fs.readFile(templatePath);
  const serverEntry = JSON.parse(templateRaw).mcpServers?.[MCP_SERVER_KEY];
  if (!serverEntry) {
    throw new Error(`Template '${templatePath}' is missing mcpServers.${MCP_SERVER_KEY}`);
  }
  serverEntry.command = bin;

  const mcpPath = join(workDir, MCP_FILENAME);

  if (!(await fs.exists(mcpPath))) {
    const payload = { mcpServers: { [MCP_SERVER_KEY]: serverEntry } };
    const content = JSON.stringify(payload, null, 2) + '\n';
    await fs.writeFile(mcpPath, content);
    logger.info({ mcpPath, bin }, '.mcp.json created (absent before run)');
    return { created: true, merged: false, kept: false, writtenContent: content };
  }

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await fs.readFile(mcpPath));
  } catch (err) {
    logger.warn({ err, mcpPath }, '.mcp.json exists but is not valid JSON — leaving untouched');
    return { created: false, merged: false, kept: false, writtenContent: '' };
  }

  const servers = existing.mcpServers;
  if (servers !== null && typeof servers === 'object' && !Array.isArray(servers)) {
    if (MCP_SERVER_KEY in (servers as Record<string, unknown>)) {
      logger.info({ mcpPath }, `Existing ${MCP_SERVER_KEY} entry detected in .mcp.json — left untouched`);
      return { created: false, merged: false, kept: true, writtenContent: '' };
    }
  }

  if (!existing.mcpServers || typeof existing.mcpServers !== 'object' || Array.isArray(existing.mcpServers)) {
    existing.mcpServers = {};
  }
  (existing.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY] = serverEntry;

  const content = JSON.stringify(existing, null, 2) + '\n';
  await fs.writeFile(mcpPath, content);
  logger.info({ mcpPath }, `Merged ${MCP_SERVER_KEY} entry into existing .mcp.json`);
  return { created: false, merged: true, kept: false, writtenContent: content };
}

/**
 * Tear down `.mcp.json` after the pipeline finishes.
 *
 * Deletes the file **only** when the harness created it (it was absent
 * before the run) **and** its current content still matches what the
 * harness originally wrote. Merged or user-edited files are always kept.
 */
export async function teardownMcpConfig(
  fs: IFileSystem,
  logger: ILogger,
  workDir: string,
  result: McpConfigResult,
): Promise<void> {
  if (!result.created || result.writtenContent === '') return;

  const mcpPath = join(workDir, MCP_FILENAME);

  try {
    if (!(await fs.exists(mcpPath))) return;

    const current = await fs.readFile(mcpPath);
    if (current === result.writtenContent) {
      await fs.deleteFile(mcpPath);
      logger.info({ mcpPath }, 'Teardown: removed harness-created .mcp.json (content unchanged)');
    } else {
      logger.info({ mcpPath }, 'Teardown: keeping .mcp.json (content modified since creation)');
    }
  } catch (err) {
    logger.warn({ err, mcpPath }, 'Teardown: failed to check/delete .mcp.json — leaving in place');
  }
}