import { OpenCodeCliRunner } from './opencode-cli-runner.js';
import { OpencodeSdkRunner, type OpencodeClientFactory } from './opencode-sdk-runner.js';
import { PiSdkRunner } from './pi-sdk-runner.js';

import type { IAgentRunner, IAgentServerHandle, IFileSystem, ILogger, IOpencodeSpawner, PipelineConfig } from '../../core/interfaces.js';

/**
 * Agent backend selector.
 *
 * - `opencode` (default): opencode SDK server, real MCP.
 * - `pi`: in-process pi SDK, backup.
 * - `opencode-cli`: legacy shell-out.
 */
export type AgentBackend = 'opencode' | 'pi' | 'opencode-cli';

export interface CreateAgentRunnerDeps {
  fs: IFileSystem;
  logger: ILogger;
  config: PipelineConfig;
  cmdRunner?: IOpencodeSpawner;
  /** Gate-owned server handle; required for the `opencode` backend. */
  agentServer?: IAgentServerHandle;
  /** Client factory seam for tests (opencode backend). */
  opencodeClientFactory?: OpencodeClientFactory;
}

export function createAgentRunner(backend: AgentBackend, deps: CreateAgentRunnerDeps): IAgentRunner {
  switch (backend) {
    case 'opencode':
      if (!deps.agentServer) {
        throw new Error('agentServer is required for opencode backend');
      }
      return new OpencodeSdkRunner(
        deps.fs,
        deps.logger,
        deps.config,
        deps.agentServer,
        deps.opencodeClientFactory,
      );
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
