import { resolve, basename, extname } from 'node:path';
import { cwd } from 'node:process';
import { readFile } from 'node:fs/promises';

import { TerminalRenderer } from './terminal-renderer.js';

export interface ValidatedOptions {
  specFileAbsPath: string;
  testCmd: string[];
  skipHitl: boolean;
  logLevel: string;
  baseBranch?: string;
  featureName: string;
  featureDescription: string;
}

export async function validateAndResolveOptions(
  options: Record<string, unknown>,
  renderer: TerminalRenderer,
): Promise<ValidatedOptions> {
  const W = 68;

  if (!options.featureDescFile) {
    console.error('');
    console.error('┌' + '─'.repeat(W) + '┐');
    console.error('│  ✖  MISSING REQUIRED ARGUMENT: --feature-desc-file'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│  Point this flag at the markdown file that describes the      '.padEnd(W + 1) + '│');
    console.error('│  feature you want the pipeline to implement.                  '.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│  Usage:'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│    agentic-tdd --feature-desc-file <path> --test-cmd <cmd>    '.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│  Examples:'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│    agentic-tdd --feature-desc-file specs/auth.md \\'.padEnd(W + 1) + '│');
    console.error('│               --test-cmd "pytest"'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│    agentic-tdd --feature-desc-file specs/search.md \\'.padEnd(W + 1) + '│');
    console.error('│               --test-cmd "npm test"'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('└' + '─'.repeat(W) + '┘');
    console.error('');
    process.exit(1);
  }

  if (!options.testCmd) {
    console.error('');
    console.error('┌' + '─'.repeat(W) + '┐');
    console.error('│  ✖  MISSING REQUIRED ARGUMENT: --test-cmd'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│  The test command is language-specific and must be provided   '.padEnd(W + 1) + '│');
    console.error('│  explicitly so the pipeline knows how to run your test suite. '.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│  Examples by language / ecosystem:'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('│    Python  →  --test-cmd "pytest"'.padEnd(W + 1) + '│');
    console.error('│    Python  →  --test-cmd "python -m pytest"'.padEnd(W + 1) + '│');
    console.error('│    Node    →  --test-cmd "npm test"'.padEnd(W + 1) + '│');
    console.error('│    Node    →  --test-cmd "npx vitest run"'.padEnd(W + 1) + '│');
    console.error('│    Go      →  --test-cmd "go test ./..."'.padEnd(W + 1) + '│');
    console.error('│    Java    →  --test-cmd "mvn test"'.padEnd(W + 1) + '│');
    console.error('│    Java    →  --test-cmd "./gradlew test"'.padEnd(W + 1) + '│');
    console.error('│    Ruby    →  --test-cmd "bundle exec rspec"'.padEnd(W + 1) + '│');
    console.error('│    Rust    →  --test-cmd "cargo test"'.padEnd(W + 1) + '│');
    console.error('│' + ' '.repeat(W) + '│');
    console.error('└' + '─'.repeat(W) + '┘');
    console.error('');
    process.exit(1);
  }

  const specFileAbsPath = resolve(cwd(), String(options.featureDescFile));

  let featureDescription: string;
  try {
    featureDescription = await readFile(specFileAbsPath, 'utf-8');
  } catch {
    renderer.fatal(`Spec file not found: '${specFileAbsPath}'`);
    throw new Error('unreachable');
  }

  const testCmd = String(options.testCmd).split(/\s+/);
  const featureName = basename(specFileAbsPath, extname(specFileAbsPath));

  return {
    specFileAbsPath,
    testCmd,
    skipHitl: Boolean(options.skipHitl),
    logLevel: String(options.logLevel ?? 'INFO'),
    baseBranch: options.baseBranch ? String(options.baseBranch) : undefined,
    featureName,
    featureDescription,
  };
}
