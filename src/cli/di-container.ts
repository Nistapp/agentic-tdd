/**
 * Dependency Injection (DI) container for the agentic-tdd CLI.
 *
 * Responsible for wiring up all pipeline services: EventBus, CommandRunner,
 * HitlHandler, OpenCodeAgentRunner, SelfCorrectionRunner, and PipelineOrchestrator.
 */

import { EventBus } from '../infrastructure/event-bus.js';
import { CommandRunner } from '../infrastructure/command-runner.js';
import { OpenCodeAgentRunner } from '../infrastructure/open-code-agent-runner.js';
import { SelfCorrectionRunner } from '../core/runners/self-correction-runner.js';
import { PipelineOrchestrator } from '../core/orchestrator.js';
import { PinoLoggerAdapter } from '../infrastructure/pino-logger.js';
import { getOpencodeLogPath } from '../utils/paths.js';
import { loggers } from '../utils/logger.js';

import type { PipelineConfig, IFileSystem, IGitService } from '../core/interfaces.js';
import type { PipelineContext } from '../core/types.js';
import type { TerminalRenderer } from './terminal-renderer.js';

import { attachTerminalListener } from './terminal-event-listener.js';
import { createHitlHandler } from './hitl-handler.js';

export interface ContainerOptions {
  ctx: PipelineContext;
  fs: IFileSystem;
  git: IGitService;
  renderer: TerminalRenderer;
  version: string;
}

export interface PipelineServices {
  orchestrator: PipelineOrchestrator;
}

export function createPipelineServices(opts: ContainerOptions): PipelineServices {
  const { ctx, fs, git, renderer, version } = opts;

  const events = new EventBus();
  attachTerminalListener(events, renderer, version);

  const cmdRunner = new CommandRunner();
  const hitlHandler = createHitlHandler(ctx, undefined, (msg) => renderer.log(msg));

  const pipelineConfig: PipelineConfig = {
    opencodeLogPath: getOpencodeLogPath(),
    apiKeySet: process.env.OPENROUTER_API_KEY ? 'present' : 'missing',
  };

  const agentRunner = new OpenCodeAgentRunner(
    fs, new PinoLoggerAdapter(loggers.core), pipelineConfig, cmdRunner,
  );

  const selfCorrectionRunner = new SelfCorrectionRunner(
    agentRunner, cmdRunner, git, fs, events, new PinoLoggerAdapter(loggers.core),
  );

  const orchestrator = new PipelineOrchestrator(
    git, fs, cmdRunner, agentRunner, selfCorrectionRunner, events,
    new PinoLoggerAdapter(loggers.core), pipelineConfig, hitlHandler,
  );

  return { orchestrator };
}
