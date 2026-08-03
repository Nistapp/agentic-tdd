import { PipelinePass } from './types.js';
import type { PassHistory, ContextFiles, PipelineContext } from './types.js';

const CONTEXT_RULES: Record<PipelinePass, { contracts: PipelinePass[]; tests: PipelinePass[]; implementation: PipelinePass[] }> = {
  [PipelinePass.Design]:             { contracts: [], tests: [], implementation: [] },
  [PipelinePass.Contracts]:          { contracts: [], tests: [], implementation: [] },
  [PipelinePass.TestGeneration]:     { contracts: [PipelinePass.Contracts], tests: [], implementation: [] },
  [PipelinePass.CoreImplementation]: { contracts: [PipelinePass.Contracts], tests: [PipelinePass.TestGeneration], implementation: [] },
  [PipelinePass.Refactor]:           { contracts: [], tests: [PipelinePass.TestGeneration], implementation: [PipelinePass.CoreImplementation] },
  [PipelinePass.Security]:           { contracts: [], tests: [PipelinePass.TestGeneration], implementation: [PipelinePass.CoreImplementation, PipelinePass.Refactor] },
  [PipelinePass.Observability]:      { contracts: [], tests: [PipelinePass.TestGeneration], implementation: [PipelinePass.CoreImplementation, PipelinePass.Refactor] },
  [PipelinePass.Documentation]:      { contracts: [], tests: [], implementation: [PipelinePass.CoreImplementation, PipelinePass.Refactor, PipelinePass.Security, PipelinePass.Observability] },
};

function collectFiles(history: Partial<Record<PipelinePass, PassHistory>>, passes: PipelinePass[]): string[] {
  const seen = new Set<string>();
  for (const p of passes) {
    const entry = history[p];
    if (entry) {
      for (const f of entry.filesTouched) {
        seen.add(f);
      }
    }
  }
  return [...seen];
}

export function buildContextFiles(
  ctx: PipelineContext,
  currentPass: PipelinePass,
): ContextFiles {
  const rule = CONTEXT_RULES[currentPass];
  if (!rule) {
    return { contracts: [], tests: [], implementation: [] };
  }

  return {
    contracts: collectFiles(ctx.history, rule.contracts),
    tests: collectFiles(ctx.history, rule.tests),
    implementation: collectFiles(ctx.history, rule.implementation),
  };
}
