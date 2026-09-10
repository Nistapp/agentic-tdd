/**
 * Pure generator for the run-scoped, isolated opencode configuration used by the
 * default opencode SDK backend.
 *
 * The harness owns environment truth: it registers exactly one MCP server (the
 * `codebase-memory` indexer), one primary agent per pipeline pass (built from
 * `src/agents/pass-*.md` frontmatter + body), and the two provider entries that
 * resolve API keys from the environment via `{env:...}` references.
 *
 * This module performs **no I/O** and imports no SDK types — it is a pure
 * function of its inputs, so it is trivially unit-testable and safe to use from
 * any layer.
 */

// ---------------------------------------------------------------------------
// Canonical indexer server + tool names (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Canonical MCP server name for the `codebase-memory` indexer.
 *
 * opencode registers MCP tools as `<serverName>_<toolName>` (single underscore).
 * Every opencode-side tool name is derived from this constant — never hardcode
 * the joined literal anywhere else.
 */
export const OPENCODE_INDEXER_SERVER_NAME = 'codebase-memory';

/**
 * The canonical indexer tool suffixes, in the order they appear in the pi-side
 * `INDEXER_TOOLS` list. The opencode names are derived by joining the canonical
 * server name and the suffix with a single underscore.
 */
export const OPENCODE_INDEXER_TOOL_SUFFIXES: readonly string[] = [
  'index_repository',
  'search_graph',
  'query_graph',
  'trace_path',
  'get_code_snippet',
  'get_graph_schema',
  'get_architecture',
  'search_code',
  'list_projects',
  'delete_project',
  'index_status',
  'check_index_coverage',
  'detect_changes',
  'manage_adr',
  'ingest_traces',
] as const;

/** Fully-qualified opencode MCP tool names (`codebase-memory_<tool>`). */
export const OPENCODE_INDEXER_TOOLS: readonly string[] =
  OPENCODE_INDEXER_TOOL_SUFFIXES.map((tool) => `${OPENCODE_INDEXER_SERVER_NAME}_${tool}`);

/** Derive the opencode tool name for a raw indexer tool suffix. */
export function opencodeToolName(suffix: string): string {
  return `${OPENCODE_INDEXER_SERVER_NAME}_${suffix}`;
}

/** True when *name* is an opencode `codebase-memory_*` MCP tool name. */
export function isOpencodeIndexerToolName(name: string): boolean {
  return name.startsWith(`${OPENCODE_INDEXER_SERVER_NAME}_`);
}

/**
 * The MCP tool set the LLM-free gate round-trip must observe (unprefixed
 * suffixes). Additional/newer tools are tolerated.
 */
export const OPENCODE_INDEXER_CORE_TOOL_SUFFIXES: readonly string[] = [
  'search_graph',
  'get_code_snippet',
  'index_repository',
];

// ---------------------------------------------------------------------------
// Permission mapping
// ---------------------------------------------------------------------------

/** opencode permission action (never `ask` — it blocks headless). */
export type OpencodePermissionAction = 'allow' | 'deny';

/** Frontmatter permission keys mapped, in deterministic emit order. */
const MAPPED_PERMISSION_KEYS: readonly string[] = [
  'read',
  'edit',
  'glob',
  'list',
  'grep',
  'bash',
  'webfetch',
  'websearch',
  'task',
  'todowrite',
  'question',
  'skill',
  'lsp',
  'doom_loop',
  'external_directory',
];

/**
 * Map a pass file's frontmatter `permission:` block onto an opencode agent
 * `permission` object.
 *
 * Rules (see the prompt's §4 table):
 *   - `read: allow` → `read: allow`
 *   - `edit: allow` → `edit: allow`
 *   - `glob: allow` → `glob: allow` + `list: allow`
 *   - `grep: allow` → `grep: allow`
 *   - explicit `deny` entries are preserved (`bash`, `webfetch`, `task`, …)
 *   - `ask` is **never** emitted (headless block); it is dropped
 *   - unknown / absent keys are omitted (inherit opencode defaults)
 *
 * MCP tools are never placed in a deny list — the indexer is harness-guaranteed.
 */
export function mapPermission(
  frontmatterPermission: unknown,
): Record<string, OpencodePermissionAction> {
  const out: Record<string, OpencodePermissionAction> = {};
  if (
    frontmatterPermission === null ||
    typeof frontmatterPermission !== 'object' ||
    Array.isArray(frontmatterPermission)
  ) {
    return out;
  }

  const source = frontmatterPermission as Record<string, unknown>;
  for (const key of MAPPED_PERMISSION_KEYS) {
    const value = source[key];
    if (value !== 'allow' && value !== 'deny') continue;
    out[key] = value;
    if (key === 'glob' && value === 'allow' && out.list === undefined) {
      out.list = 'allow';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generated config shape
// ---------------------------------------------------------------------------

export interface OpencodeAgentSource {
  /** Canonical agent name (an `AGENT_NAMES` value). */
  name: string;
  /** Frontmatter `description` (optional). */
  description?: string;
  /** Frontmatter `model` (used unless overridden via `models`). */
  model?: string;
  /** Agent system prompt (the pass file body). */
  prompt?: string;
  /** Raw frontmatter `permission` block. */
  permission?: unknown;
}

export interface BuildOpencodeConfigOptions {
  /** Absolute path to the resolved `codebase-memory-mcp` binary. */
  binary: string;
  /** Override the canonical MCP server name (defaults to the constant). */
  serverName?: string;
  /** The 8 pipeline agents. */
  agents: readonly OpencodeAgentSource[];
  /** Per-agent model overrides (agent name → `provider/model`). */
  models?: Partial<Record<string, string>>;
}

export interface OpencodeMcpEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
}

export interface OpencodeAgentEntry {
  description?: string;
  mode: 'primary';
  model?: string;
  prompt?: string;
  permission: Record<string, OpencodePermissionAction>;
}

export interface OpencodeProviderEntry {
  options: { apiKey: string };
}

export interface GeneratedOpencodeConfig {
  $schema: string;
  mcp: Record<string, OpencodeMcpEntry>;
  agent: Record<string, OpencodeAgentEntry>;
  provider: Record<string, OpencodeProviderEntry>;
}

/**
 * Build the complete, isolated opencode config object.
 *
 * Deterministic: agents are emitted in the order supplied; the MCP and provider
 * maps have fixed single entries.
 */
export function buildOpencodeConfig(opts: BuildOpencodeConfigOptions): GeneratedOpencodeConfig {
  const serverName = opts.serverName ?? OPENCODE_INDEXER_SERVER_NAME;

  const agent: Record<string, OpencodeAgentEntry> = {};
  for (const source of opts.agents) {
    const override = opts.models?.[source.name];
    const model = override ?? source.model;
    const entry: OpencodeAgentEntry = {
      mode: 'primary',
      permission: mapPermission(source.permission),
    };
    if (source.description !== undefined) entry.description = source.description;
    if (model !== undefined) entry.model = model;
    if (source.prompt !== undefined) entry.prompt = source.prompt;
    agent[source.name] = entry;
  }

  return {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      [serverName]: { type: 'local', command: [opts.binary], enabled: true },
    },
    agent,
    provider: {
      openrouter: { options: { apiKey: '{env:OPENROUTER_API_KEY}' } },
      deepseek: { options: { apiKey: '{env:DEEPSEEK_API_KEY}' } },
    },
  };
}
