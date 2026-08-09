import { PipelinePass } from './types.js';
import type {
  PipelineContext,
  BuiltContext,
  TargetSymbols,
  FileChanges,
} from './types.js';
import type { IContextProvider } from './interfaces.js';
import { buildContextFiles, buildTargetPasses } from './context-builder.js';

export class StateContextProvider implements IContextProvider {
  build(ctx: PipelineContext, pass: PipelinePass): BuiltContext {
    const files = buildContextFiles(ctx, pass);
    const targetPasses = buildTargetPasses(pass);

    const targetSymbols: TargetSymbols = {};
    const fileChanges: FileChanges = {};

    for (const upstreamPass of targetPasses) {
      const upstreamSymbols = ctx.history[upstreamPass]?.targetSymbols;
      if (upstreamSymbols) {
        for (const [filePath, symbols] of Object.entries(upstreamSymbols)) {
          const existing = targetSymbols[filePath];
          if (existing) {
            const merged = new Set([...existing, ...symbols]);
            targetSymbols[filePath] = [...merged].sort();
          } else {
            targetSymbols[filePath] = [...symbols];
          }
        }
      }

      const upstreamFileChanges = ctx.history[upstreamPass]?.fileChanges;
      if (upstreamFileChanges) {
        // Whole per-file records — the latest upstream pass wins per file.
        for (const [filePath, record] of Object.entries(upstreamFileChanges)) {
          fileChanges[filePath] = record;
        }
      }
    }

    return { files, targetSymbols, fileChanges };
  }
}
