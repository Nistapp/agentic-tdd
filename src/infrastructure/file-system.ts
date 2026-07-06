import type { IFileSystem } from '../core/interfaces.js';
import { stat, readFile, writeFile as write, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { reqLogger } from '../utils/logger.js';

export class NodeFileSystem implements IFileSystem {
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    reqLogger().trace({ filePath: path }, 'Reading artifact from disk');
    return readFile(path, 'utf-8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    reqLogger().debug({ filePath: path }, 'Writing artifact to disk');
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    await write(path, content, 'utf-8');
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Silently ignore if the file doesn't exist
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const { rename } = await import('node:fs/promises');
    await rename(oldPath, newPath);
  }
}