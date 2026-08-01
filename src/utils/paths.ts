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

export function getStateFilePath(featureName: string, workDir?: string): string {
  const safe = sanitizeFilename(featureName);
  return join(workDir ?? cwd(), '.opencode', `state-${safe}.json`);
}

export function getLogDir(workDir?: string): string {
  return join(workDir ?? cwd(), '.opencode', 'log');
}

export { PACKAGE_AGENTS_DIR } from '../infrastructure/command-runner.js';

export function getOpencodeLogPath(): string {
  return join(process.env.HOME ?? '~', '.local', 'share', 'opencode', 'log', 'opencode.log');
}
