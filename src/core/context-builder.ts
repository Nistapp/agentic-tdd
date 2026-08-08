import { PipelinePass } from './types.js';
import type { PassHistory, ContextFiles, PipelineContext } from './types.js';

interface ContextRuleCategory {
  contracts: PipelinePass[];
  tests: PipelinePass[];
  implementation: PipelinePass[];
}

export const CONTEXT_RULES: Record<
  PipelinePass,
  { files: ContextRuleCategory; target: ContextRuleCategory }
> = {
  [PipelinePass.Design]: {
    files: { contracts: [], tests: [], implementation: [] },
    target: { contracts: [], tests: [], implementation: [] },
  },
  [PipelinePass.Contracts]: {
    files: { contracts: [], tests: [], implementation: [] },
    target: { contracts: [], tests: [], implementation: [] },
  },
  [PipelinePass.TestGeneration]: {
    files: { contracts: [PipelinePass.Contracts], tests: [], implementation: [] },
    target: { contracts: [], tests: [], implementation: [] },
  },
  [PipelinePass.CoreImplementation]: {
    files: {
      contracts: [PipelinePass.Contracts],
      tests: [PipelinePass.TestGeneration],
      implementation: [],
    },
    target: { contracts: [], tests: [], implementation: [] },
  },
  [PipelinePass.Refactor]: {
    files: {
      contracts: [],
      tests: [PipelinePass.TestGeneration],
      implementation: [PipelinePass.CoreImplementation],
    },
    target: {
      contracts: [],
      tests: [],
      implementation: [PipelinePass.CoreImplementation],
    },
  },
  [PipelinePass.Observability]: {
    files: {
      contracts: [],
      tests: [],
      implementation: [PipelinePass.Refactor],
    },
    target: {
      contracts: [],
      tests: [],
      implementation: [PipelinePass.Refactor],
    },
  },
  [PipelinePass.Security]: {
    files: {
      contracts: [],
      tests: [],
      implementation: [PipelinePass.Refactor],
    },
    target: {
      contracts: [],
      tests: [],
      implementation: [PipelinePass.Refactor],
    },
  },
  [PipelinePass.Documentation]: {
    files: {
      contracts: [],
      tests: [],
      implementation: [
        PipelinePass.CoreImplementation,
        PipelinePass.Refactor,
        PipelinePass.Observability,
        PipelinePass.Security,
      ],
    },
    target: { contracts: [], tests: [], implementation: [] },
  },
};

function collectFiles(
  history: Partial<Record<PipelinePass, PassHistory>>,
  passes: PipelinePass[],
): string[] {
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
    contracts: collectFiles(ctx.history, rule.files.contracts),
    tests: collectFiles(ctx.history, rule.files.tests),
    implementation: collectFiles(ctx.history, rule.files.implementation),
  };
}

/**
 * Return the set of upstream passes whose `targetSymbols` should be merged
 * into the current pass's built context.
 */
export function buildTargetPasses(pass: PipelinePass): PipelinePass[] {
  const rule = CONTEXT_RULES[pass];
  if (!rule) return [];

  const seen = new Set<PipelinePass>();
  for (const p of rule.target.contracts) seen.add(p);
  for (const p of rule.target.tests) seen.add(p);
  for (const p of rule.target.implementation) seen.add(p);
  return [...seen];
}
