import { OpenCodeCliRunner } from './opencode-cli-runner.js';
import { PiSdkRunner } from './pi-sdk-runner.js';

import type { IAgentRunner, IFileSystem, ILogger, IOpencodeSpawner, PipelineConfig } from '../../core/interfaces.js';

export type AgentBackend = 'pi' | 'opencode-cli';

export interface CreateAgentRunnerDeps {
  fs: IFileSystem;
  logger: ILogger;
  config: PipelineConfig;
  cmdRunner?: IOpencodeSpawner;
}

export function createAgentRunner(backend: AgentBackend, deps: CreateAgentRunnerDeps): IAgentRunner {
  switch (backend) {
    case 'pi':
      return new PiSdkRunner(deps.fs, deps.logger, deps.config);
    case 'opencode-cli':
      if (!deps.cmdRunner) {
        throw new Error('cmdRunner is required for opencode-cli backend');
      }
      return new OpenCodeCliRunner(deps.fs, deps.logger, deps.config, deps.cmdRunner);
    default:
      throw new Error(`Unknown agent backend: ${backend}`);
  }
}