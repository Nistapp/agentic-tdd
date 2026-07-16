import { join } from 'node:path';
import { cwd } from 'node:process';

export function getStateFilePath(workDir?: string): string {
  return join(workDir ?? cwd(), '.opencode', 'active-run.json');
}

export function getLogDir(workDir?: string): string {
  return join(workDir ?? cwd(), '.opencode', 'log');
}

export { PACKAGE_AGENTS_DIR } from '../infrastructure/command-runner.js';

export function getOpencodeLogPath(): string {
  return join(process.env.HOME ?? '~', '.local', 'share', 'opencode', 'log', 'opencode.log');
}
