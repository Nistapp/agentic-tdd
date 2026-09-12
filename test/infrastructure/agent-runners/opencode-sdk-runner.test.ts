import { describe, it, expect, vi } from 'vitest';

import {
  OpencodeSdkRunner,
  captureOpencodeEvent,
  isPermissionAsked,
  type OpencodeCaptureState,
  type OpencodeEvent,
  type OpencodeSdkClient,
} from '../../../src/infrastructure/agent-runners/opencode-sdk-runner.js';
import { AgentRunError, PipelinePass } from '../../../src/core/types.js';
import type { AgentRunRequest } from '../../../src/core/types.js';
import type { IAgentServerHandle, IFileSystem, ILogger, PipelineConfig } from '../../../src/core/interfaces.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
  get level(): string {
    return 'info';
  }
}

function stubFs(): IFileSystem & { writeFile: ReturnType<typeof vi.fn> } {
  return {
    exists: vi.fn(async () => false),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    renameFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
  };
}

function streamOf(events: OpencodeEvent[]): AsyncIterable<OpencodeEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

interface ClientHarness {
  client: OpencodeSdkClient;
  create: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  messages: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function makeClient(opts: {
  events?: OpencodeEvent[];
  promptResult?: unknown;
  promptError?: unknown;
  messagesResult?: unknown;
} = {}): ClientHarness {
  const create = vi.fn(async () => ({ data: { id: 'sess-1' } }));
  const prompt = vi.fn(async () => {
    if (opts.promptError !== undefined) throw opts.promptError;
    return opts.promptResult ?? { data: { info: { tokens: { input: 100, output: 20 } } } };
  });
  const messages = vi.fn(async () => opts.messagesResult ?? { data: [] });
  const deleteSession = vi.fn(async () => ({}));
  const abort = vi.fn(async () => ({}));

  const client: OpencodeSdkClient = {
    session: { create, prompt, messages, delete: deleteSession, abort },
    event: {
      subscribe: vi.fn(async () => ({ stream: streamOf(opts.events ?? []) })),
    },
  };
  return { client, create, prompt, messages, deleteSession, abort };
}

const SERVER: IAgentServerHandle = {
  baseUrl: 'http://127.0.0.1:4321',
  isAlive: vi.fn(async () => true),
  close: vi.fn(async () => undefined),
};

const CONFIG: PipelineConfig = { opencodeLogPath: '/tmp/log', apiKeySet: 'present' };

function request(pass: PipelinePass = PipelinePass.Design): AgentRunRequest {
  return { pass, prompt: 'do the thing', artefacts: {}, runId: 'run-1' };
}

function makeRunner(client: OpencodeSdkClient, fs = stubFs()) {
  return new OpencodeSdkRunner(fs, new StubLogger(), CONFIG, SERVER, () => client);
}

// ---------------------------------------------------------------------------
// Pure capture helpers
// ---------------------------------------------------------------------------

describe('captureOpencodeEvent', () => {
  function state(): OpencodeCaptureState {
    return { textDeltas: [], messageEvents: [], toolCalls: [] };
  }

  it('filters reasoning deltas', () => {
    const s = state();
    captureOpencodeEvent(
      { type: 'message.part.delta', properties: { sessionID: 's', field: 'reasoning', delta: 'think' } },
      's',
      s,
    );
    expect(s.textDeltas).toEqual([]);
  });

  it('ignores events for a different session', () => {
    const s = state();
    captureOpencodeEvent(
      { type: 'message.part.delta', properties: { sessionID: 'other', field: 'text', delta: 'x' } },
      's',
      s,
    );
    expect(s.textDeltas).toEqual([]);
  });

  it('recognises permission requests', () => {
    expect(isPermissionAsked({ type: 'permission.asked' })).toBe(true);
    expect(isPermissionAsked({ type: 'permission.v2.asked' })).toBe(true);
    expect(isPermissionAsked({ type: 'message.updated' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

describe('OpencodeSdkRunner.execute', () => {
  it('binds the agent, maps deltas/tools/usage, and deletes the session', async () => {
    const fs = stubFs();
    const { client, create, deleteSession } = makeClient({
      events: [
        { type: 'message.part.delta', properties: { sessionID: 'sess-1', field: 'text', delta: 'Hello ' } },
        { type: 'message.part.delta', properties: { sessionID: 'sess-1', field: 'text', delta: 'world' } },
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'sess-1',
            part: {
              type: 'tool',
              callID: 'c1',
              tool: 'codebase-memory_list_projects',
              state: { status: 'completed', input: { a: 1 }, output: '{"ok":true}' },
            },
          },
        },
        {
          type: 'message.updated',
          properties: { sessionID: 'sess-1', info: { role: 'assistant', tokens: { input: 100, output: 20 } } },
        },
      ],
    });

    const result = await makeRunner(client, fs).execute(request(PipelinePass.Design));

    expect(create).toHaveBeenCalledWith({ agent: 'pass-0-design-agent' });
    expect(result.output).toBe('Hello world');
    expect(result.sessionId).toBe('sess-1');
    expect(result.structured?.toolCalls).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'codebase-memory_list_projects',
        args: { a: 1 },
        result: '{"ok":true}',
        isError: false,
      },
    ]);
    expect(result.structured?.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(deleteSession).toHaveBeenCalledWith({ sessionID: 'sess-1' });
    expect(fs.writeFile).toHaveBeenCalled();

    const writeCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const inputCall = writeCalls.find(([p]) => p.endsWith('pass-0-run-1.input.log'));
    expect(inputCall).toBeDefined();
    const inputPayload = JSON.parse(inputCall![1]) as { pass: PipelinePass; prompt: string };
    expect(inputPayload.pass).toBe(PipelinePass.Design);
    expect(inputPayload.prompt).toBe('do the thing');
  });

  it('marks tool errors via isError', async () => {
    const { client } = makeClient({
      events: [
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'sess-1',
            part: { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'error', error: 'boom' } },
          },
        },
      ],
    });

    const result = await makeRunner(client).execute(request());
    expect(result.structured?.toolCalls[0]?.isError).toBe(true);
    expect(result.structured?.toolCalls[0]?.result).toBe('boom');
  });

  it('falls back to session.messages() when the stream yields nothing', async () => {
    const { client, messages } = makeClient({
      events: [],
      messagesResult: {
        data: [
          {
            info: { role: 'assistant', tokens: { input: 7, output: 3 } },
            parts: [
              { type: 'text', text: 'fallback text' },
              { type: 'tool', callID: 'c9', tool: 'codebase-memory_search_graph', state: { status: 'completed', output: '{}' } },
            ],
          },
        ],
      },
    });

    const result = await makeRunner(client).execute(request());
    expect(messages).toHaveBeenCalledWith({ sessionID: 'sess-1' });
    expect(result.output).toBe('fallback text');
    expect(result.structured?.toolCalls[0]?.toolName).toBe('codebase-memory_search_graph');
    expect(result.structured?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('binds the correct agent for the requested pass', async () => {
    const { client, create } = makeClient({ events: [] });
    await makeRunner(client).execute(request(PipelinePass.CoreImplementation));
    expect(create).toHaveBeenCalledWith({ agent: 'pass-3-core-implementation-agent' });
  });

  it('fails fast with agent_failed when a permission request is raised', async () => {
    const { client, abort, deleteSession } = makeClient({
      events: [{ type: 'permission.asked', properties: { sessionID: 'sess-1', tool: { callID: 'c' } } }],
    });

    await expect(makeRunner(client).execute(request())).rejects.toMatchObject({
      name: 'AgentRunError',
      kind: 'agent_failed',
    });
    expect(abort).toHaveBeenCalledWith({ sessionID: 'sess-1' });
    expect(deleteSession).toHaveBeenCalled();
  });

  it('classifies a missing API key', async () => {
    const { client } = makeClient({ events: [], promptError: new Error('no api key configured') });
    const err = await makeRunner(client).execute(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    expect((err as AgentRunError).kind).toBe('no_api_key');
  });

  it('classifies a timeout', async () => {
    const { client } = makeClient({ events: [], promptError: new Error('request timed out') });
    const err = await makeRunner(client).execute(request()).catch((e: unknown) => e);
    expect((err as AgentRunError).kind).toBe('timeout');
  });

  it('classifies an unknown provider/model as no_model', async () => {
    const { client } = makeClient({ events: [], promptError: new Error('unknown provider: foo') });
    const err = await makeRunner(client).execute(request()).catch((e: unknown) => e);
    expect((err as AgentRunError).kind).toBe('no_model');
  });

  it('classifies everything else as agent_failed', async () => {
    const { client } = makeClient({ events: [], promptError: new Error('kaboom') });
    const err = await makeRunner(client).execute(request()).catch((e: unknown) => e);
    expect((err as AgentRunError).kind).toBe('agent_failed');
  });

  it('deletes the session even when the run fails', async () => {
    const { client, deleteSession } = makeClient({ events: [], promptError: new Error('kaboom') });
    await makeRunner(client).execute(request()).catch(() => undefined);
    expect(deleteSession).toHaveBeenCalledWith({ sessionID: 'sess-1' });
  });
});
