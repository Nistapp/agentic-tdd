import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PipelinePass, AGENT_NAMES } from '../core/types.js';

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

export const executionContextStorage = new AsyncLocalStorage<{ logger: pino.Logger }>();

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


