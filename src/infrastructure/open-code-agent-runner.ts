import { resolve } from 'node:path';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { IFileSystem, ILogger, PipelineConfig, IAgentRunner, IOpencodeSpawner } from '../core/interfaces.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import { AGENT_NAMES } from '../core/types.js';
import { sanitizeLogPayload } from '../core/log-sanitizer.js';
import { PACKAGE_AGENTS_DIR } from '../utils/paths.js';
import { getLogDir } from '../utils/paths.js';

export class OpenCodeAgentRunner implements IAgentRunner {
  readonly #fs: IFileSystem;
  readonly #logger: ILogger;
  readonly #config: PipelineConfig;
  readonly #spawner: IOpencodeSpawner;

  constructor(
    fs: IFileSystem,
    logger: ILogger,
    config: PipelineConfig,
    spawner: IOpencodeSpawner,
  ) {
    this.#fs = fs;
    this.#logger = logger;
    this.#config = config;
    this.#spawner = spawner;
  }

  async execute(request: AgentRunRequest): Promise<AgentRunResult> {
    const agentName = AGENT_NAMES[request.pass];
    const execLogger = this.#logger.child({ module: 'agent-runner', pass: request.pass, agent: agentName });

    await this.#logPreFlight(request, execLogger);
    const args = await this.#buildArgs(request, execLogger);
    const output = await this.#spawner.spawn(args);
    await this.#persistPassLog(request, output, execLogger);
    return { output };
  }

  // -- Private helpers --------------------------------------------------------

  async #buildArgs(request: AgentRunRequest, logger: ILogger): Promise<string[]> {
    const agentName = AGENT_NAMES[request.pass];
    // --pure is a deliberate architectural decision: pipeline agents have narrow,
    // file-scoped tasks and tightly declared permissions. External opencode plugins
    // add unnecessary startup time, token budget overhead, and non-determinism.
    // It also prevents opencode from auto-installing plugin deps into
    // $OPENCODE_CONFIG_DIR, keeping our dist/ output free of node_modules pollution.
    const args = ['run', '--pure', '--agent', agentName];

    const { designMmd, specGherkin, specFile, errorLog } = request.artefacts;

    if (designMmd) {
      args.push('--file', designMmd);
    }
    if (specGherkin) {
      args.push('--file', specGherkin);
    }
    if (specFile) {
      args.push('--file', specFile);
    }
    if (errorLog) {
      args.push('--file', errorLog);
    }

    const level = this.#logger.level;
    if (level === 'debug' || level === 'trace') {
      logger.debug(`buildArgs: active log level is '${level}' — injecting --print-logs and --log-level DEBUG`);
      args.push('--print-logs', '--log-level', 'DEBUG');
    }

    args.push('--dangerously-skip-permissions', request.prompt);
    return args;
  }

  async #logPreFlight(request: AgentRunRequest, logger: ILogger): Promise<void> {
    const agentName = AGENT_NAMES[request.pass];
    const agentFile = resolve(PACKAGE_AGENTS_DIR, `${agentName}.md`);

    let model = '<unknown>';
    try {
      if (await this.#fs.exists(agentFile)) {
        const content = await this.#fs.readFile(agentFile);
        const match = content.match(/^model:\s*(.+)$/m);
        if (match) model = (match[1] ?? '').trim() || '<unknown>';
      }
    } catch {
      logger.warn({ agentFile }, 'Could not read agent model');
    }

    const apiKeySet = this.#config.apiKeySet;
    logger.info(
      { pass: request.pass, agent: agentName, model, apiKey: apiKeySet },
      'Pre-flight: invoking opencode agent',
    );
  }

  async #persistPassLog(request: AgentRunRequest, response: string, logger: ILogger): Promise<void> {
    try {
      const logDir = getLogDir();
      if (!(await this.#fs.exists(logDir))) {
        await this.#fs.mkdir(logDir);
      }
      const runId = request.runId ?? 'unknown';
      const logFile = join(logDir, `pass-${request.pass}-${runId}.log`);
      await this.#fs.writeFile(logFile, response);
      logger.debug({ logFile }, 'Persisted opencode output to per-pass log');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist per-pass opencode log');
    }
  }
}
