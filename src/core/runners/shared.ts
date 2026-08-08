import type { PipelineContext, AgentArtefacts, BuiltContext } from '../types.js';
import type { IFileSystem, ILogger } from '../interfaces.js';
import { buildContextFiles } from '../context-builder.js';

export function getAgentContextPayload(
  ctx: PipelineContext,
  built?: BuiltContext,
  meta: Record<string, unknown> = {},
): string {
  const currentPass = ctx.currentPass;
  const contextFiles = built?.files
    ?? (currentPass !== undefined ? buildContextFiles(ctx, currentPass) : { contracts: [], tests: [], implementation: [] });

  const payload = {
    featureName: ctx.featureName,
    featureDescription: ctx.featureDescription,
    pipelineVersion: ctx.pipelineVersion,
    paths: {
      designMmd: ctx.designMmdPath,
      specGherkin: ctx.specGherkinPath,
      errorLog: ctx.errorLogPath,
    },
    contextFiles,
    targetSymbols: built?.targetSymbols ?? {},
    meta,
  };
  return JSON.stringify(payload, null, 2);
}

export async function buildArtefacts(
  ctx: PipelineContext,
  fs: IFileSystem,
  built?: BuiltContext,
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

  if (built) {
    artefacts.contextFiles = built.files;
  } else if (ctx.currentPass !== undefined) {
    artefacts.contextFiles = buildContextFiles(ctx, ctx.currentPass);
  }

  return artefacts;
}
