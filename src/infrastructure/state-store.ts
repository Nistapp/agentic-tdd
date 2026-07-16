import { dirname } from 'node:path';
import { cwd } from 'node:process';

import type { IStateStore, IFileSystem } from '../core/interfaces.js';
import type { PipelineContext } from '../core/types.js';
import { getStateFilePath } from '../utils/paths.js';

export class JsonStateStore implements IStateStore {
  readonly #fs: IFileSystem;
  readonly #workDir: string;

  constructor(fs: IFileSystem, workDir?: string) {
    this.#fs = fs;
    this.#workDir = workDir ?? cwd();
  }

  async save(ctx: PipelineContext): Promise<void> {
    const path = getStateFilePath(this.#workDir);
    await this.#fs.mkdir(dirname(path));
    await this.#fs.writeFile(path, JSON.stringify(ctx, null, 2));
  }

  async load(): Promise<PipelineContext> {
    const path = getStateFilePath(this.#workDir);
    const raw = await this.#fs.readFile(path);
    return JSON.parse(raw) as PipelineContext;
  }

  async delete(): Promise<void> {
    const path = getStateFilePath(this.#workDir);
    await this.#fs.deleteFile(path);
  }

  async exists(): Promise<boolean> {
    const path = getStateFilePath(this.#workDir);
    return this.#fs.exists(path);
  }
}
