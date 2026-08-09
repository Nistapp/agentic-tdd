import { join } from 'node:path';
import { cwd } from 'node:process';

export function sanitizeFilename(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

const STATE_DIR = '.agentic-tdd';

export function getStateDir(workDir?: string): string {
  return join(workDir ?? cwd(), STATE_DIR);
}

export function getStateFilePath(featureName: string, workDir?: string): string {
  const safe = sanitizeFilename(featureName);
  return join(getStateDir(workDir), `state-${safe}.json`);
}

export function getLogDir(workDir?: string): string {
  return join(workDir ?? cwd(), STATE_DIR, 'log');
}

export { PACKAGE_AGENTS_DIR } from '../infrastructure/command-runner.js';

export function getOpencodeLogPath(): string {
  return join(process.env.HOME ?? '~', '.local', 'share', 'opencode', 'log', 'opencode.log');
}
