import type { PipelineContext, AgentArtefacts } from '../types.js';
import type { IFileSystem, ILogger } from '../interfaces.js';

export function getAgentContextPayload(ctx: PipelineContext, meta: Record<string, unknown> = {}): string {
  const payload = {
    featureName: ctx.featureName,
    featureDescription: ctx.featureDescription,
    pipelineVersion: ctx.pipelineVersion,
    paths: {
      designMmd: ctx.designMmdPath,
      specGherkin: ctx.specGherkinPath,
      errorLog: ctx.errorLogPath,
    },
    meta,
  };
  return JSON.stringify(payload, null, 2);
}

export async function buildArtefacts(
  ctx: PipelineContext,
  fs: IFileSystem,
  errorLog?: string,
  logger?: ILogger,
): Promise<AgentArtefacts> {
  const artefacts: AgentArtefacts = {};

  if (await fs.exists(ctx.designMmdPath)) {
    artefacts.designMmd = ctx.designMmdPath;
  }
  if (await fs.exists(ctx.specGherkinPath)) {
    artefacts.specGherkin = ctx.specGherkinPath;
  }
  if (ctx.specFileAbsPath) {
    const specExists = await fs.exists(ctx.specFileAbsPath);
    if (logger) logger.debug(`buildArtefacts: specFileAbsPath='${ctx.specFileAbsPath}' exists=${specExists}`);
    if (specExists) {
      artefacts.specFile = ctx.specFileAbsPath;
    } else {
      if (logger) logger.debug('buildArtefacts: specFileAbsPath does not exist — not attaching as --file');
    }
  } else if (ctx.featureDescription) {
    if (logger) logger.debug('buildArtefacts: featureDescription present but specFileAbsPath is not set — spec will NOT be attached as --file');
  }
  if (errorLog) {
    artefacts.errorLog = errorLog;
  }

  return artefacts;
}
