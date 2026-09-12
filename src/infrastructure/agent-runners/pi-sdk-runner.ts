import { resolve, join } from 'node:path';
import { cwd } from 'node:process';

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import type { IAgentRunner, IFileSystem, ILogger, PipelineConfig } from '../../core/interfaces.js';
import { AgentRunError, AGENT_NAMES, PipelinePass } from '../../core/types.js';
import type { AgentRunRequest, AgentRunResult, AgentStructuredOutput, AgentToolCallEvent, AgentMessageEvent, AgentUsage } from '../../core/types.js';
import { sanitizeLogPayload } from '../../core/log-sanitizer.js';
import { PACKAGE_AGENTS_DIR, getLogDir } from '../../utils/paths.js';
import { buildIndexerBridgeTools } from './indexer-bridge.js';

type PiSdkModule = typeof import('@earendil-works/pi-coding-agent');
type PiModelRuntime = Awaited<ReturnType<PiSdkModule['ModelRuntime']['create']>>;
type CreateAgentSessionOpts = NonNullable<Parameters<PiSdkModule['createAgentSession']>[0]>;

/**
 * Canonical tool names the `codebase-memory` MCP server registers when its
 * server entry carries `"directTools": true` (see `mcp.template.json`).
 * The `pi-mcp-adapter`
 * extension registers one individually-named tool per MCP tool under the
 * `mcp__<server>__<tool>` scheme.
 *
 * The harness guarantees these tools are reachable (indexer gate), so they are
 * always enabled — the frontmatter `permission:` block governs built-in tools
 * only. The live probe asserts this exact set appears on a probe session.
 */
export const INDEXER_TOOLS: readonly string[] = [
  'mcp__codebase-memory__index_repository',
  'mcp__codebase-memory__search_graph',
  'mcp__codebase-memory__query_graph',
  'mcp__codebase-memory__trace_path',
  'mcp__codebase-memory__get_code_snippet',
  'mcp__codebase-memory__get_graph_schema',
  'mcp__codebase-memory__get_architecture',
  'mcp__codebase-memory__search_code',
  'mcp__codebase-memory__list_projects',
  'mcp__codebase-memory__delete_project',
  'mcp__codebase-memory__index_status',
  'mcp__codebase-memory__check_index_coverage',
  'mcp__codebase-memory__detect_changes',
  'mcp__codebase-memory__manage_adr',
  'mcp__codebase-memory__ingest_traces',
] as const;

export const MCP_INDEXER_SERVER_PREFIX = 'mcp__codebase-memory__';

/**
 * Pi SDK-backed agent runner.
 *
 * Executes a pipeline pass in-process against the Pi coding-agent SDK,
 * eliminating the per-pass OS process fork used by the opencode CLI backend.
 *
 * Per-pass session strategy: each `execute()` call creates a fresh
 * in-memory session, runs a single prompt, captures the typed event stream,
 * persists a sanitized pass log, and disposes the session — preserving the
 * pipeline's strict per-pass context isolation.
 */
export class PiSdkRunner implements IAgentRunner {
  readonly #fs: IFileSystem;
  readonly #logger: ILogger;
  readonly #config: PipelineConfig;

  /** Per-pass thinking level (v3 review decision): high for deep-reasoning passes, off otherwise. */
  private static readonly PASS_THINKING: Record<PipelinePass, 'high' | 'off'> = {
    [PipelinePass.Design]: 'high',
    [PipelinePass.Contracts]: 'off',
    [PipelinePass.TestGeneration]: 'high',
    [PipelinePass.CoreImplementation]: 'off',
    [PipelinePass.Refactor]: 'off',
    [PipelinePass.Observability]: 'off',
    [PipelinePass.Security]: 'off',
    [PipelinePass.Documentation]: 'off',
  };

  #sdkPromise?: Promise<PiSdkModule>;
  #modelRuntimePromise?: Promise<PiModelRuntime>;

  constructor(fs: IFileSystem, logger: ILogger, config: PipelineConfig) {
    this.#fs = fs;
    this.#logger = logger;
    this.#config = config;
  }

  async execute(request: AgentRunRequest): Promise<AgentRunResult> {
    const agentName = AGENT_NAMES[request.pass];
    const execLogger = this.#logger.child({ module: 'pi-sdk-runner', pass: request.pass, agent: agentName });
    const startedAt = Date.now();

    const sdk = await this.#sdk();
    const agentMdPath = resolve(PACKAGE_AGENTS_DIR, `${agentName}.md`);

    let agentMd: string;
    try {
      agentMd = await this.#fs.readFile(agentMdPath);
    } catch (err) {
      throw this.#classify(err, request.pass, `Could not read agent prompt file '${agentMdPath}'`);
    }

    const { frontmatter, body } = sdk.parseFrontmatter(agentMd);
    const canonicalModel = await this.#resolveCanonicalModel(agentName, request.pass, frontmatter, execLogger);

    let session: Awaited<ReturnType<PiSdkModule['createAgentSession']>>['session'] | undefined;
    const toolCalls: AgentToolCallEvent[] = [];
    const messageEvents: AgentMessageEvent[] = [];
    const textDeltas: string[] = [];
    let usage: AgentUsage | undefined;

    try {
      const thinkingLevel = PiSdkRunner.PASS_THINKING[request.pass];
      const modelRuntime = await this.#modelRuntime(sdk);

      const resolved = sdk.resolveCliModel({
        cliModel: `${canonicalModel}:${thinkingLevel}`,
        modelRuntime,
      });
      if (!resolved.model || resolved.error) {
        throw new AgentRunError('no_model', request.pass, resolved.error ?? `No model resolved for '${canonicalModel}'`);
      }

      const tools = buildToolsAllowlist(frontmatter);
      // In-process indexer bridge: pi-mcp-adapter does not register its MCP
      // tools inside an embedded headless SDK session, so register the indexer
      // tools as SDK customTools (each invoking the binary's one-shot CLI).
      const customTools = buildIndexerBridgeTools(INDEXER_TOOLS) as unknown as
        NonNullable<CreateAgentSessionOpts['customTools']>;
      const workDir = cwd();
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: workDir,
        agentDir: sdk.getAgentDir(),
        systemPromptOverride: () => body,
      });
      await resourceLoader.reload();

      const sessionManager = sdk.SessionManager.inMemory(workDir);
      const created = await sdk.createAgentSession({
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel ?? thinkingLevel,
        tools,
        customTools,
        cwd: workDir,
        agentDir: sdk.getAgentDir(),
        resourceLoader,
        sessionManager,
        modelRuntime,
      });
      session = created.session;

      execLogger.debug({ agent: agentName, model: `${canonicalModel}:${thinkingLevel}`, tools, indexerBridgeTools: customTools.length }, 'Pi SDK session created');

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        captureEvent(event, textDeltas, messageEvents, toolCalls, (u) => { usage = u; });
      });

      try {
        await session.prompt(request.prompt, { source: 'rpc' });
      } finally {
        unsubscribe();
      }

      const output = textDeltas.join('');
      const structured: AgentStructuredOutput = { toolCalls, messages: messageEvents };
      if (usage) structured.usage = usage;

      const result: AgentRunResult = {
        output,
        structured,
        sessionId: session.sessionId,
        durationMs: Date.now() - startedAt,
      };

      await this.#persistPassLog(request, result, execLogger);
      return result;
    } catch (err) {
      throw this.#classify(err, request.pass);
    } finally {
      session?.dispose();
    }
  }

  // -- Private helpers --------------------------------------------------------

  #sdk(): Promise<PiSdkModule> {
    this.#sdkPromise ??= import('@earendil-works/pi-coding-agent');
    return this.#sdkPromise;
  }

  #modelRuntime(sdk: PiSdkModule): Promise<PiModelRuntime> {
    this.#modelRuntimePromise ??= sdk.ModelRuntime.create();
    return this.#modelRuntimePromise;
  }

  async #resolveCanonicalModel(
    agentName: string,
    pass: PipelinePass,
    frontmatter: Record<string, unknown>,
    logger: ILogger,
  ): Promise<string> {
    const fromConfig = this.#config.models?.[agentName];
    const fromFrontmatter = typeof frontmatter.model === 'string' ? frontmatter.model : undefined;
    const canonical = fromConfig ?? fromFrontmatter;
    if (!canonical) {
      throw new AgentRunError('no_model', pass, `No model configured for agent '${agentName}'`);
    }
    logger.debug({ agent: agentName, model: canonical, source: fromConfig ? 'config' : 'frontmatter' }, 'Resolved Pi model');
    return canonical;
  }

  #classify(err: unknown, pass: PipelinePass, fallbackMessage?: string): AgentRunError {
    if (err instanceof AgentRunError) return err;
    const message = err instanceof Error ? err.message : String(err);
    let kind: AgentRunError['kind'] = 'agent_failed';
    if (/api key|authentication failed|no api key|not authenticated|login/i.test(message)) {
      kind = 'no_api_key';
    } else if (/timeout|timed out/i.test(message)) {
      kind = 'timeout';
    } else if (/no models available|model .*not found|unknown provider|could not be resolved/i.test(message)) {
      kind = 'no_model';
    }
    return new AgentRunError(kind, pass, fallbackMessage ?? message, { cause: err });
  }

  async #persistPassLog(request: AgentRunRequest, result: AgentRunResult, logger: ILogger): Promise<void> {
    try {
      const logDir = getLogDir();
      if (!(await this.#fs.exists(logDir))) {
        await this.#fs.mkdir(logDir);
      }
      const runId = request.runId ?? 'unknown';
      const logFile = join(logDir, `pass-${request.pass}-${runId}.log`);
      const sanitized = sanitizeLogPayload({ output: result.output, structured: result.structured }, this.#logger.level);
      await this.#fs.writeFile(logFile, JSON.stringify(sanitized, null, 2));
      logger.debug({ logFile }, 'Persisted Pi SDK run to per-pass log');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist per-pass Pi SDK log');
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (pure — unit-testable without a session)
// ---------------------------------------------------------------------------

/**
 * Capture a single Pi session event into the output/structured accumulators.
 * Exported for unit testing.
 */
export function captureEvent(
  event: AgentSessionEvent,
  textDeltas: string[],
  messageEvents: AgentMessageEvent[],
  toolCalls: AgentToolCallEvent[],
  setUsage: (usage?: AgentUsage) => void,
): void {
  if (event.type === 'message_update') {
    if (event.assistantMessageEvent.type === 'text_delta') {
      textDeltas.push(event.assistantMessageEvent.delta);
      messageEvents.push({
        role: 'assistant',
        delta: event.assistantMessageEvent.delta,
        text: extractText(event.assistantMessageEvent.partial),
      });
    } else if (event.assistantMessageEvent.type === 'done') {
      const u = event.assistantMessageEvent.message?.usage;
      if (u) {
        setUsage({ inputTokens: u.input, outputTokens: u.output });
      }
    }
    return;
  }
  if (event.type === 'tool_execution_start') {
    toolCalls.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      isError: false,
    });
    return;
  }
  if (event.type === 'tool_execution_end') {
    const existing = toolCalls.find((t) => t.toolCallId === event.toolCallId);
    if (existing) {
      existing.result = event.result;
      existing.isError = event.isError;
    }
    return;
  }
}

/**
 * Map the agent file's YAML `permission:` block onto Pi's built-in `tools`
 * allowlist. Entries are Pi in-process tool names (never Unix binaries), so
 * the mapping is platform-safe. When no permission block is present the
 * default allowlist (all non-shell built-ins) is used.
 *
 * The canonical `INDEXER_TOOLS` set is always appended: the indexer is a
 * mandatory harness prerequisite (verified once per session by the gate), so
 * its MCP-namespaced tools are harness-guaranteed and never gated by the
 * agent's frontmatter `permission:` block.
 */
export function buildToolsAllowlist(frontmatter: Record<string, unknown>): string[] {
  let builtins: string[];
  const permission = frontmatter.permission;
  if (permission === null || typeof permission !== 'object' || Array.isArray(permission)) {
    builtins = ['read', 'edit', 'write', 'grep', 'find', 'ls'];
  } else {
    const p = permission as Record<string, unknown>;
    const tools: string[] = [];
    if (p.read === 'allow') tools.push('read');
    if (p.edit === 'allow') tools.push('edit', 'write');
    if (p.glob === 'allow') tools.push('find', 'ls');
    if (p.grep === 'allow') tools.push('grep');
    builtins = tools.length > 0 ? tools : ['read', 'edit', 'write', 'grep', 'find', 'ls'];
  }
  return [...builtins, ...INDEXER_TOOLS];
}

/**
 * True when *name* is a `mcp__codebase-memory__*` tool. Used by the live probe
 * to separate expected indexer tools from unexpected/extra registrations.
 */
export function isIndexerToolName(name: string): boolean {
  return name.startsWith(MCP_INDEXER_SERVER_PREFIX);
}

function extractText(partial: unknown): string | undefined {
  if (partial === null || typeof partial !== 'object') return undefined;
  const content = (partial as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((c) => (c !== null && typeof c === 'object' && (c as { type?: string }).type === 'text' ? (c as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === 'string');
  return parts.length > 0 ? parts.join('') : undefined;
}
