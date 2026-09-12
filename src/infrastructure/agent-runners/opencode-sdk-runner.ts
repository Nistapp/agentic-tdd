/**
 * opencode SDK-backed agent runner (the default backend).
 *
 * Each pipeline pass creates a **fresh** opencode session on the shared,
 * gate-owned server (one server per session entry — never one per pass),
 * binds the pass's agent, streams the turn, maps the event stream into the
 * harness's structured capture shape, persists a sanitized per-pass log, and
 * deletes the session. The shared server is never disposed here.
 */

import { join } from 'node:path';

import type { IAgentRunner, IAgentServerHandle, IFileSystem, ILogger, PipelineConfig } from '../../core/interfaces.js';
import { AgentRunError, AGENT_NAMES, PipelinePass } from '../../core/types.js';
import type {
  AgentMessageEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentStructuredOutput,
  AgentToolCallEvent,
  AgentUsage,
} from '../../core/types.js';
import { sanitizeLogPayload } from '../../core/log-sanitizer.js';
import { getLogDir } from '../../utils/paths.js';

// ---------------------------------------------------------------------------
// Structural SDK seams (kept SDK-typed-free so tests inject plain stubs)
// ---------------------------------------------------------------------------

export interface OpencodeToolState {
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export interface OpencodePart {
  type?: string;
  callID?: string;
  tool?: string;
  text?: string;
  state?: OpencodeToolState;
  [key: string]: unknown;
}

export interface OpencodeMessageInfo {
  role?: string;
  agent?: string;
  tokens?: { input?: number; output?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface OpencodeMessage {
  info?: OpencodeMessageInfo;
  parts?: OpencodePart[];
  [key: string]: unknown;
}

export interface OpencodeEventProperties {
  sessionID?: string;
  delta?: string;
  field?: string;
  partID?: string;
  part?: OpencodePart;
  info?: OpencodeMessageInfo;
  tool?: { callID?: string; messageID?: string };
  [key: string]: unknown;
}

export interface OpencodeEvent {
  type?: string;
  properties?: OpencodeEventProperties;
  [key: string]: unknown;
}

export interface OpencodeSdkClient {
  session: {
    create(input: { agent: string }): Promise<unknown>;
    prompt(input: {
      sessionID: string;
      agent?: string;
      parts: Array<{ type: 'text'; text: string }>;
    }): Promise<unknown>;
    messages(input: { sessionID: string }): Promise<unknown>;
    delete(input: { sessionID: string }): Promise<unknown>;
    abort(input: { sessionID: string }): Promise<unknown>;
  };
  event: {
    subscribe(
      params: Record<string, unknown>,
      options: { signal: AbortSignal },
    ): Promise<{ stream: AsyncIterable<OpencodeEvent> }>;
  };
}

export type OpencodeClientFactory = (baseUrl: string) => Promise<OpencodeSdkClient> | OpencodeSdkClient;

const defaultClientFactory: OpencodeClientFactory = async (baseUrl) => {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  return createOpencodeClient({ baseUrl }) as unknown as OpencodeSdkClient;
};

/** Delay before tearing the event stream down, to let trailing parts flush. */
const STREAM_FLUSH_MS = 500;

/**
 * opencode SDK agent runner.
 *
 * Constructor deps: filesystem, logger, pipeline config, the gate-owned server
 * handle, and a client factory seam (tests inject a stub client and never spawn
 * anything).
 */
export class OpencodeSdkRunner implements IAgentRunner {
  readonly #fs: IFileSystem;
  readonly #logger: ILogger;
  readonly #config: PipelineConfig;
  readonly #server: IAgentServerHandle;
  readonly #clientFactory: OpencodeClientFactory;
  #clientPromise?: Promise<OpencodeSdkClient>;

  constructor(
    fs: IFileSystem,
    logger: ILogger,
    config: PipelineConfig,
    server: IAgentServerHandle,
    clientFactory: OpencodeClientFactory = defaultClientFactory,
  ) {
    this.#fs = fs;
    this.#logger = logger;
    this.#config = config;
    this.#server = server;
    this.#clientFactory = clientFactory;
  }

  async execute(request: AgentRunRequest): Promise<AgentRunResult> {
    const agentName = AGENT_NAMES[request.pass];
    const execLogger = this.#logger.child({ module: 'opencode-sdk-runner', pass: request.pass, agent: agentName });
    const startedAt = Date.now();

    const client = await this.#client();
    const state: OpencodeCaptureState = { textDeltas: [], messageEvents: [], toolCalls: [] };
    let sessionID: string | undefined;

    try {
      sessionID = await this.#createSession(client, agentName, request.pass);

      const controller = new AbortController();
      const permissionRef = { asked: false };
      const streamErrorRef: { error?: unknown } = {};

      const streamPromise = this.#consumeStream(
        client,
        sessionID,
        controller.signal,
        state,
        permissionRef,
        streamErrorRef,
      );

      try {
        // Agent is bound at session.create (the standard path); the per-prompt
        // `agent` field is deliberately not sent so the binding has one source.
        const promptResult = await client.session.prompt({
          sessionID,
          parts: [{ type: 'text', text: request.prompt }],
        });
        applyPromptResult(promptResult, state);
      } catch (err) {
        if (permissionRef.asked) {
          throw this.#permissionError(agentName, request.pass);
        }
        throw err;
      } finally {
        await sleep(STREAM_FLUSH_MS);
        controller.abort();
        await streamPromise;
      }

      if (permissionRef.asked) {
        throw this.#permissionError(agentName, request.pass);
      }
      if (streamErrorRef.error !== undefined) {
        throw streamErrorRef.error;
      }

      if (state.textDeltas.length === 0 && state.toolCalls.length === 0) {
        await this.#fallbackToMessages(client, sessionID, state);
      }

      const output = state.textDeltas.join('');
      const structured: AgentStructuredOutput = {
        toolCalls: state.toolCalls,
        messages: state.messageEvents,
      };
      if (state.usage) structured.usage = state.usage;

      const result: AgentRunResult = {
        output,
        structured,
        sessionId: sessionID,
        durationMs: Date.now() - startedAt,
      };

      await this.#persistPassLog(request, result, execLogger);
      return result;
    } catch (err) {
      throw this.#classify(err, request.pass);
    } finally {
      if (sessionID !== undefined) {
        await this.#deleteSession(client, sessionID, execLogger);
      }
    }
  }

  // -- Private helpers --------------------------------------------------------

  #client(): Promise<OpencodeSdkClient> {
    this.#clientPromise ??= Promise.resolve(this.#clientFactory(this.#server.baseUrl));
    return this.#clientPromise;
  }

  async #createSession(client: OpencodeSdkClient, agentName: string, pass: PipelinePass): Promise<string> {
    const created = await client.session.create({ agent: agentName });
    const session = unwrapData(created) as { id?: unknown } | undefined;
    const id = session?.id;
    if (typeof id !== 'string' || id === '') {
      throw new AgentRunError('agent_failed', pass, `opencode session.create returned no session id for agent '${agentName}'`);
    }
    return id;
  }

  async #consumeStream(
    client: OpencodeSdkClient,
    sessionID: string,
    signal: AbortSignal,
    state: OpencodeCaptureState,
    permissionRef: { asked: boolean },
    errorRef: { error?: unknown },
  ): Promise<void> {
    try {
      const { stream } = await client.event.subscribe({}, { signal });
      for await (const event of stream) {
        if (signal.aborted) break;
        if (isPermissionAsked(event)) {
          permissionRef.asked = true;
          // Abort the turn so the blocking prompt does not hang headless.
          void client.session.abort({ sessionID }).catch(() => undefined);
          break;
        }
        captureOpencodeEvent(event, sessionID, state);
      }
    } catch (err) {
      if (!signal.aborted) errorRef.error = err;
    }
  }

  async #fallbackToMessages(client: OpencodeSdkClient, sessionID: string, state: OpencodeCaptureState): Promise<void> {
    try {
      const result = await client.session.messages({ sessionID });
      const messages = unwrapData(result);
      captureFromMessages(messages, state);
    } catch {
      // Fallback is best-effort; the prompt result already carries usage.
    }
  }

  #permissionError(agentName: string, pass: PipelinePass): AgentRunError {
    return new AgentRunError(
      'agent_failed',
      pass,
      `Agent '${agentName}' raised a permission request ('ask') during a headless run. ` +
        "The harness only generates `allow`/`deny` permissions; a stray `ask` in the opencode config must be removed.",
    );
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

  async #deleteSession(client: OpencodeSdkClient, sessionID: string, logger: ILogger): Promise<void> {
    try {
      await client.session.delete({ sessionID });
    } catch (err) {
      logger.warn({ err, sessionID }, 'Failed to delete opencode session');
    }
  }

  async #persistPassLog(request: AgentRunRequest, result: AgentRunResult, logger: ILogger): Promise<void> {
    try {
      const logDir = getLogDir();
      if (!(await this.#fs.exists(logDir))) {
        await this.#fs.mkdir(logDir);
      }
      const runId = request.runId ?? 'unknown';
      const inputFile = join(logDir, `pass-${request.pass}-${runId}.input.log`);
      const input = sanitizeLogPayload(
        { pass: request.pass, runId: request.runId, prompt: request.prompt, artefacts: request.artefacts },
        'debug',
      );
      await this.#fs.writeFile(inputFile, JSON.stringify(input, null, 2));
      logger.debug({ inputFile }, 'Persisted agent input context to per-pass log');

      const logFile = join(logDir, `pass-${request.pass}-${runId}.log`);
      const sanitized = sanitizeLogPayload({ output: result.output, structured: result.structured }, this.#logger.level);
      await this.#fs.writeFile(logFile, JSON.stringify(sanitized, null, 2));
      logger.debug({ logFile }, 'Persisted opencode SDK run to per-pass log');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist per-pass opencode SDK log');
    }
  }
}

// ---------------------------------------------------------------------------
// Pure capture helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export interface OpencodeCaptureState {
  textDeltas: string[];
  messageEvents: AgentMessageEvent[];
  toolCalls: AgentToolCallEvent[];
  usage?: AgentUsage;
}

/** True for a `permission.asked` / `permission.v2.asked` event. */
export function isPermissionAsked(event: OpencodeEvent): boolean {
  return event.type === 'permission.asked' || event.type === 'permission.v2.asked';
}

/**
 * Capture a single opencode event into *state*.
 *
 * Reasoning deltas (`field === 'reasoning'`) are filtered out so only
 * assistant-visible text is accumulated.
 */
export function captureOpencodeEvent(event: OpencodeEvent, sessionID: string, state: OpencodeCaptureState): void {
  const props = event.properties;
  if (props === undefined) return;
  if (typeof props.sessionID === 'string' && props.sessionID !== sessionID) return;

  if (event.type === 'message.part.delta') {
    if (props.field === 'reasoning') return;
    if (typeof props.delta === 'string') {
      state.textDeltas.push(props.delta);
      state.messageEvents.push({ role: 'assistant', delta: props.delta });
    }
    return;
  }

  if (event.type === 'message.part.updated' && props.part?.type === 'tool') {
    captureToolPart(props.part, state.toolCalls);
    return;
  }

  if (event.type === 'message.updated' && props.info?.role === 'assistant') {
    const usage = toUsage(props.info.tokens);
    if (usage) state.usage = usage;
  }
}

/** Map a `ToolPart` update onto the tool-call accumulator. */
function captureToolPart(part: OpencodePart, toolCalls: AgentToolCallEvent[]): void {
  const callID = typeof part.callID === 'string' ? part.callID : undefined;
  if (callID === undefined) return;

  let entry = toolCalls.find((t) => t.toolCallId === callID);
  if (entry === undefined) {
    entry = {
      toolCallId: callID,
      toolName: typeof part.tool === 'string' ? part.tool : 'unknown',
      args: part.state?.input,
      isError: false,
    };
    toolCalls.push(entry);
  }
  if (typeof part.tool === 'string') entry.toolName = part.tool;
  if (part.state?.input !== undefined) entry.args = part.state.input;
  if (part.state?.status === 'completed') {
    entry.result = part.state.output;
    entry.isError = false;
  } else if (part.state?.status === 'error') {
    entry.result = part.state.error;
    entry.isError = true;
  }
}

/** Fold the non-streaming `session.messages()` result into *state*. */
export function captureFromMessages(messages: unknown, state: OpencodeCaptureState): void {
  if (!Array.isArray(messages)) return;
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue;
    const message = raw as OpencodeMessage;
    if (message.info?.role !== 'assistant') continue;

    const usage = toUsage(message.info.tokens);
    if (usage) state.usage = usage;

    for (const part of message.parts ?? []) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
        if (state.textDeltas.length === 0) {
          state.textDeltas.push(part.text);
          state.messageEvents.push({ role: 'assistant', delta: part.text });
        }
      } else if (part.type === 'tool') {
        captureToolPart(part, state.toolCalls);
      }
    }
  }
}

/** Use the blocking `session.prompt` result's assistant info for usage. */
export function applyPromptResult(result: unknown, state: OpencodeCaptureState): void {
  const data = unwrapData(result) as { info?: OpencodeMessageInfo } | undefined;
  const usage = toUsage(data?.info?.tokens);
  if (usage) state.usage = usage;
}

function toUsage(tokens: OpencodeMessageInfo['tokens'] | undefined): AgentUsage | undefined {
  if (tokens === undefined) return undefined;
  const usage: AgentUsage = {};
  if (typeof tokens.input === 'number') usage.inputTokens = tokens.input;
  if (typeof tokens.output === 'number') usage.outputTokens = tokens.output;
  return usage;
}

function unwrapData(result: unknown): unknown {
  if (result !== null && typeof result === 'object' && 'data' in result) {
    return (result as { data?: unknown }).data;
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
