import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PipelinePass, AGENT_NAMES, ExecutionMetadata } from '../core/types.js';

// Determine log level and whether to use pino-pretty
const args = process.argv;
const logLevelIndex = args.indexOf('--log-level');
const cliLogLevel = logLevelIndex !== -1 && args.length > logLevelIndex + 1 
  ? args[logLevelIndex + 1]?.toUpperCase() 
  : null;

const envLogLevel = process.env.LOG_LEVEL?.toUpperCase();
const isDebugEnv = process.env.DEBUG !== undefined;

const activeLevel = cliLogLevel || envLogLevel || (isDebugEnv ? 'DEBUG' : 'INFO');
const isDebugActive = activeLevel === 'DEBUG' || isDebugEnv;

const pinoOptions: pino.LoggerOptions = {
  name: 'orchestrator',
  level: activeLevel.toLowerCase(),
};

// Use pino-pretty for terminal output if debug flag/log level is active
if (isDebugActive) {
  pinoOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
};
}

const root = pino(pinoOptions);

export interface ExecutionContext {
  metadata: ExecutionMetadata;
  logger: pino.Logger;
}

export const executionContextStorage = new AsyncLocalStorage<ExecutionContext>();

export function getExecutionContext(): ExecutionContext | undefined {
  return executionContextStorage.getStore();
}

export function reqLogger(): pino.Logger {
  return executionContextStorage.getStore()?.logger ?? root;
}

export const loggers = {
  cli: root.child({ module: 'cli' }),
  core: root.child({ module: 'core' }),
  infra: {
    git: root.child({ module: 'infra:git' }),
    fs: root.child({ module: 'infra:fs' }),
    cmd: root.child({ module: 'infra:cmd' }),
    events: root.child({ module: 'infra:events' }),
  },
  agent: (pass: PipelinePass) => {
    const agentName = AGENT_NAMES[pass];
    if (agentName) {
      return root.child({ module: `agent:${agentName}` });
    }
    return root.child({ module: `agent:unknown-${pass}` });
  }
};

export function createExecutionContextLogger(metadata: ExecutionMetadata): pino.Logger {
  return root.child({
    module: 'execution',
    runId: metadata.runId,
    targetFile: metadata.targetFile,
    passId: metadata.passId,
    attemptCount: metadata.attemptCount,
  });
}

const MAX_INFO_STRING_LENGTH = 400;
const C0_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function sanitizeString(value: string, level: string): string {
  const clean = value.replace(C0_CONTROL_RE, '');
  if (level === 'debug' || level === 'trace') return clean;
  if (clean.length <= MAX_INFO_STRING_LENGTH) return clean;
  return clean.slice(0, MAX_INFO_STRING_LENGTH) + '[Truncated: ' + clean.length + ' characters total]';
}

function sanitizeValue(value: unknown, level: string): unknown {
  if (typeof value === 'string') return sanitizeString(value, level);
  if (Array.isArray(value)) return value.map(v => sanitizeValue(v, level));
  if (value instanceof Date) return new Date(value.getTime());
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeValue(v, level);
    }
    return result;
  }
  return value;
}

export function sanitizeLogPayload(payload: any, currentLevel: string): any {
  if (payload === null || payload === undefined) return payload;
  return sanitizeValue(payload, currentLevel.toLowerCase());
}
