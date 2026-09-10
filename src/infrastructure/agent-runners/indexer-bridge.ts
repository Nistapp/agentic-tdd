/**
 * In-process tool bridge for the `codebase-memory` indexer.
 *
 * pi-mcp-adapter only registers its MCP tools inside the interactive/print pi
 * host — an **embedded** headless pi SDK session (the exact shape the harness's
 * per-pass `PiSdkRunner` and the indexer live probe use) never receives them.
 * This bridge makes indexer access deterministic for the pipeline: it registers
 * the canonical indexer tools as pi SDK `customTools`, each executing the
 * indexer binary's one-shot CLI mode.
 *
 * Runtime cost per tool call is one short-lived CLI spawn (the binary keeps a
 * warm on-disk index), which is acceptable for the guarded per-pass pipeline.
 */

import { Type } from 'typebox';

import {
  execaProcessRunner,
  getResolvedIndexerBinary,
  type ProcessRunner,
} from '../indexer-client.js';

const MCP_SERVER_PREFIX = 'mcp__codebase-memory__';

/** Permissive schema: any JSON object the MCP tool accepts is passed through. */
const openArguments = Type.Object({}, { additionalProperties: Type.Any() });

export interface IndexerBridgeTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }>;
}

export interface IndexerBridgeOptions {
  /** Absolute binary path; when omitted it is resolved via PATH once per process. */
  binary?: string | null;
  /** Process runner (defaults to the execa runner with `stdin: ignore`). */
  runner?: ProcessRunner;
  /** Per-call timeout (default 120s — index_repository on a large repo is slow). */
  timeoutMs?: number;
}

/**
 * Build a pi `customTools` array registering *toolNames* (expected to already
 * carry the `mcp__codebase-memory__` prefix) as one-shot CLI tools.
 */
export function buildIndexerBridgeTools(
  toolNames: readonly string[],
  opts: IndexerBridgeOptions = {},
): IndexerBridgeTool[] {
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return toolNames.map((name) => {
    const mcpToolName = stripPrefix(name);
    return {
      name,
      label: name,
      description: `codebase-memory indexer (${mcpToolName}). Executes the ${mcpToolName} MCP tool against the local code knowledge graph.`,
      parameters: openArguments,
      execute: async (_toolCallId, params, _signal) => {
        const text = await invokeIndexerCli(name, mcpToolName, params, opts, timeoutMs);
        return { content: [{ type: 'text', text }], details: {} };
      },
    };
  });
}

async function invokeIndexerCli(
  toolName: string,
  mcpToolName: string,
  params: Record<string, unknown>,
  opts: IndexerBridgeOptions,
  timeoutMs: number,
): Promise<string> {
  const binary = opts.binary === null ? null : (opts.binary ?? (await getResolvedIndexerBinary()));
  if (!binary) {
    throw new Error(
      `codebase-memory-mcp binary not found on PATH — cannot run indexer tool '${mcpToolName}'. ` +
      'Install it (mandatory harness prerequisite) before running the pipeline.',
    );
  }

  const runner = opts.runner ?? execaProcessRunner;
  const result = await runner(binary, ['cli', mcpToolName, JSON.stringify(params ?? {})], { timeoutMs });

  if (result.exitCode !== 0) {
    throw new Error(
      `codebase-memory-mcp ${mcpToolName} exited with code ${result.exitCode}: ` +
      `${(result.stderr || result.stdout).slice(0, 400)}`,
    );
  }

  const parsed = parseLastJson(result.stdout);
  if (parsed === undefined) {
    const trimmed = result.stdout.trim();
    if (trimmed !== '') return trimmed;
    throw new Error(`codebase-memory-mcp ${mcpToolName} produced no usable output`);
  }

  const error = parsed['error'] ?? parsed['isError'];
  if (typeof parsed['error'] === 'string' && parsed['error'] !== '') {
    throw new Error(`codebase-memory-mcp ${mcpToolName} reported an error: ${parsed['error']}`);
  }
  if (error === true) {
    throw new Error(`codebase-memory-mcp ${mcpToolName} failed (isError=true)`);
  }

  // Prefer a structured payload when present, else the raw envelope text.
  const textPayload = parsed['content'];
  if (Array.isArray(textPayload)) {
    const text = textPayload
      .map((b) => (b !== null && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : undefined))
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    if (text.trim() !== '') return text;
  }
  return JSON.stringify(parsed, null, 2);
}

/**
 * Parse the last JSON object/line on stdout. The one-shot CLI prints log lines
 * to stderr and a JSON envelope to stdout; scanning from the end tolerates any
 * stray prefix noise.
 */
export function parseLastJson(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning backwards for the last JSON line.
    }
  }
  return undefined;
}

function stripPrefix(name: string): string {
  return name.startsWith(MCP_SERVER_PREFIX) ? name.slice(MCP_SERVER_PREFIX.length) : name;
}
