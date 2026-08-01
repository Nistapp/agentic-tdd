import { dirname } from 'node:path';
import { cwd } from 'node:process';

import type { IStateStore, IFileSystem } from '../core/interfaces.js';
import type { PipelineContext } from '../core/types.js';
import { getStateFilePath } from '../utils/paths.js';

export class JsonStateStore implements IStateStore {
  readonly #fs: IFileSystem;
  readonly #workDir: string;
  readonly path: string;

  constructor(fs: IFileSystem, featureName: string, workDir?: string) {
    this.#fs = fs;
    this.#workDir = workDir ?? cwd();
    this.path = getStateFilePath(featureName, this.#workDir);
  }

  async save(ctx: PipelineContext): Promise<void> {
    const tmp = this.path + '.tmp';
    await this.#fs.mkdir(dirname(this.path));
    await this.#fs.writeFile(tmp, JSON.stringify(ctx, null, 2));
    await this.#fs.renameFile(tmp, this.path);
  }

  async load(): Promise<PipelineContext> {
    const raw = await this.#fs.readFile(this.path);
    return JSON.parse(raw) as PipelineContext;
  }

  async delete(): Promise<void> {
    await this.#fs.deleteFile(this.path);
  }

  async exists(): Promise<boolean> {
    return this.#fs.exists(this.path);
  }
}
