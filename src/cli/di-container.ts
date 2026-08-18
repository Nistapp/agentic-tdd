/**
 * Dependency Injection (DI) container for the agentic-tdd CLI.
 *
 * Responsible for wiring up all pipeline services: EventBus, CommandRunner,
 * HitlHandler, OpenCodeAgentRunner, and PipelineOrchestrator.
 */

import { EventBus } from '../infrastructure/event-bus.js';
import { CommandRunner } from '../infrastructure/command-runner.js';
import { OpenCodeAgentRunner } from '../infrastructure/open-code-agent-runner.js';
import { PipelineOrchestrator } from '../core/orchestrator.js';
import { StateContextProvider } from '../core/context-provider.js';
import { AstGrepSymbolResolver } from '../infrastructure/ast-grep-symbol-resolver.js';
import { PinoLoggerAdapter } from '../infrastructure/pino-logger.js';
import { getOpencodeLogPath } from '../utils/paths.js';
import { loggers } from '../utils/logger.js';

import type { PipelineConfig, IFileSystem, IGitService, IStateStore } from '../core/interfaces.js';
import type { PipelineContext } from '../core/types.js';
import type { TerminalRenderer } from './terminal-renderer.js';
import type { ModelConfig } from './model-config.js';

import { attachTerminalListener } from './terminal-event-listener.js';
import { createHitlHandler } from './hitl-handler.js';

export interface ContainerOptions {
  ctx: PipelineContext;
  fs: IFileSystem;
  git: IGitService;
  renderer: TerminalRenderer;
  version: string;
  stateStore?: IStateStore;
  noContextEnrich?: boolean;
  /** Resolved per-agent model config (see `resolveModelConfig`). */
  modelConfig?: ModelConfig;
}

export interface PipelineServices {
  orchestrator: PipelineOrchestrator;
}

/** Build the runtime `PipelineConfig` DI seam from container options. */
export function buildPipelineConfig(opts: Pick<ContainerOptions, 'modelConfig'>): PipelineConfig {
  return {
    opencodeLogPath: getOpencodeLogPath(),
    apiKeySet: process.env.OPENROUTER_API_KEY || process.env.DEEPSEEK_API_KEY ? 'present' : 'missing',
    models: opts.modelConfig?.models,
  };
}

export function createPipelineServices(opts: ContainerOptions): PipelineServices {
  const { ctx, fs, git, renderer, version, stateStore, noContextEnrich } = opts;

  const events = new EventBus();
  attachTerminalListener(events, renderer, version);

  const cmdRunner = new CommandRunner();
  const hitlHandler = createHitlHandler(ctx, undefined, (msg) => renderer.log(msg));

  const pipelineConfig: PipelineConfig = buildPipelineConfig(opts);

  const agentRunner = new OpenCodeAgentRunner(
    fs, new PinoLoggerAdapter(loggers.core), pipelineConfig, cmdRunner,
  );

  const contextProvider = new StateContextProvider();
  const symbolResolver = noContextEnrich ? undefined : new AstGrepSymbolResolver();

  const orchestrator = new PipelineOrchestrator(
    git, fs, cmdRunner, agentRunner, events,
    new PinoLoggerAdapter(loggers.core), pipelineConfig, contextProvider, symbolResolver, stateStore, hitlHandler,
  );

  return { orchestrator };
}
