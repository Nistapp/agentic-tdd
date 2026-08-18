import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { IFileSystem } from '../core/interfaces.js';
import { AGENT_NAMES } from '../core/types.js';

/**
 * Per-agent model resolution for the agentic-tdd CLI.
 *
 * Pure module: no `process.env` reads, no real filesystem access. All file
 * I/O is performed through an injected {@link IFileSystem} so the module is
 * unit-testable without touching the disk.
 *
 * Precedence (highest first):
 *   1. `--model <provider/model>`   (global override for every agent)
 *   2. `--config <path>`            (explicit alternate config file)
 *   3. `.agentic-tdd/config.json`   (git-ignored user override file)
 *   4. `config.default.json`        (bundled committed default)
 *   5. agent-file YAML frontmatter  (kept as the final fallback, applied by
 *                                   opencode when no `--model` is passed)
 */

export interface ModelConfig {
  /** agentName (an `AGENT_NAMES` value from `src/core/types.ts`) → `provider/model`. */
  models?: Partial<Record<string, string>>;
}

export interface CliModelOpts {
  /** `--model <provider/model>` — global override for every agent. */
  model?: string;
  /** `--config <path>` — alternate config file that replaces the user override file. */
  configPath?: string;
}

export interface ModelConfigPaths {
  /** `<cwd>/.agentic-tdd/config.json` — git-ignored user override file. */
  userPath: string;
  /** Injected filesystem for existence checks and reads. */
  fs: IFileSystem;
}

/** Matches `provider/model` and multi-segment forms like `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`. */
const MODEL_PATTERN = /^[a-z0-9-_.]+(\/[a-z0-9-_.:]+)+$/i;

/** Agent keys accepted inside `agents.models` — the `AGENT_NAMES` values. */
export const KNOWN_AGENTS: readonly string[] = Object.values(AGENT_NAMES);

/**
 * Strip `//` line and `/* *&#47;` block comments from a JSONC string, producing
 * strict JSON. String-aware: comment markers inside string literals (e.g. URLs
 * like `http://...`) are preserved.
 */
export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let prev = '';

  for (const ch of input) {
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
        prev = '';
      }
      continue;
    }

    if (inBlockComment) {
      if (prev === '*' && ch === '/') {
        inBlockComment = false;
        prev = '';
      } else {
        prev = ch;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      prev = ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      prev = ch;
      continue;
    }

    if (ch === '/' && prev === '/') {
      out = out.slice(0, -1);
      inLineComment = true;
      prev = '';
      continue;
    }

    if (ch === '*' && prev === '/') {
      out = out.slice(0, -1);
      inBlockComment = true;
      prev = '';
      continue;
    }

    out += ch;
    prev = ch;
  }

  return out;
}

/**
 * Resolve the bundled `config.default.json` for the current runtime.
 * Source runs resolve to `<repo>/config.default.json` (committed at repo
 * root); published `dist/` runs resolve to `<pkg>/dist/config.default.json`
 * (copied there by `copy:agents`). Returns `undefined` if neither exists.
 */
export async function defaultModelConfigPath(fs: IFileSystem): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../config.default.json'), // repo root (source runs)
    resolve(here, '../config.default.json'),    // dist/ (published builds)
  ];
  for (const candidate of candidates) {
    if (await fs.exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Load, parse, and validate a config file. Unknown *top-level* sections are
 * ignored (forward compatibility); unknown agent keys inside `agents.models`
 * and malformed model strings are rejected (fail fast).
 */
export async function loadConfigFile(path: string, fs: IFileSystem): Promise<ModelConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (err) {
    throw new Error(
      `Could not read model config file at '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new Error(
      `Invalid JSON in model config file '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return normalizeConfig(parsed, path);
}

function normalizeConfig(parsed: unknown, path: string): ModelConfig {
  if (parsed === undefined || parsed === null) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid model config file '${path}': expected a JSON object`);
  }

  const agents = (parsed as { agents?: unknown }).agents;
  if (agents === undefined || agents === null) {
    return {};
  }
  if (typeof agents !== 'object' || Array.isArray(agents)) {
    throw new Error(`Invalid model config file '${path}': "agents" must be an object`);
  }

  const models = (agents as { models?: unknown }).models;
  if (models === undefined || models === null) {
    return {};
  }
  if (typeof models !== 'object' || Array.isArray(models)) {
    throw new Error(`Invalid model config file '${path}': "agents.models" must be an object`);
  }

  const result: Partial<Record<string, string>> = {};
  for (const [agentName, value] of Object.entries(models)) {
    if (!KNOWN_AGENTS.includes(agentName)) {
      throw new Error(
        `Unknown agent "${agentName}" in '${path}'. Known agents: ${KNOWN_AGENTS.join(', ')}`,
      );
    }
    result[agentName] = validateModelString(value, agentName);
  }
  return { models: result };
}

function validateModelString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid model value for ${context}: expected a non-empty "provider/model" string`);
  }
  const model = value.trim();
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(`Invalid model value for ${context}: "${model}" does not match "provider/model"`);
  }
  return model;
}

/**
 * Resolve the effective per-agent model config, applying all precedence tiers
 * (see module docstring). Returns `{}` when nothing resolves — in which case
 * agents fall back to their file frontmatter (today's behaviour).
 */
export async function resolveModelConfig(cli: CliModelOpts, paths: ModelConfigPaths): Promise<ModelConfig> {
  const merged: Partial<Record<string, string>> = {};

  const defaultPath = await defaultModelConfigPath(paths.fs);
  if (defaultPath !== undefined) {
    const defaults = await loadConfigFile(defaultPath, paths.fs);
    Object.assign(merged, defaults.models);
  }

  let overridePath: string | undefined;
  if (cli.configPath !== undefined) {
    overridePath = cli.configPath;
  } else if (await paths.fs.exists(paths.userPath)) {
    overridePath = paths.userPath;
  }
  if (overridePath !== undefined) {
    const overrides = await loadConfigFile(overridePath, paths.fs);
    Object.assign(merged, overrides.models);
  }

  if (cli.model !== undefined) {
    const globalModel = validateModelString(cli.model, '--model');
    for (const agentName of KNOWN_AGENTS) {
      merged[agentName] = globalModel;
    }
  }

  return Object.keys(merged).length > 0 ? { models: merged } : {};
}
