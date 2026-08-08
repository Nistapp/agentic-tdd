import { dirname } from 'node:path';
import { cwd } from 'node:process';

import type { IStateStore, IFileSystem } from '../core/interfaces.js';
import type { PipelineContext, StateFileEnvelope } from '../core/types.js';
import { getStateFilePath } from '../utils/paths.js';

const CURRENT_SCHEMA_VERSION = '0.1.0';

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
    const envelope: StateFileEnvelope = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      context: ctx,
    };
    const tmp = this.path + '.tmp';
    await this.#fs.mkdir(dirname(this.path));
    await this.#fs.writeFile(tmp, JSON.stringify(envelope, null, 2));
    await this.#fs.renameFile(tmp, this.path);
  }

  async load(): Promise<PipelineContext> {
    const raw = await this.#fs.readFile(this.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[agentic-tdd] Corrupt state file at ${this.path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      throw new Error(`Corrupt state file at ${this.path}`);
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      'schemaVersion' in parsed &&
      'context' in parsed
    ) {
      const env = parsed as StateFileEnvelope;
      if (env.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        console.warn(
          `[agentic-tdd] Unsupported state file schema version "${env.schemaVersion}" ` +
          `at ${this.path}. Expected "${CURRENT_SCHEMA_VERSION}".`,
        );
        throw new Error(`Unsupported schema version: ${env.schemaVersion}`);
      }
      return env.context;
    }

    console.warn(
      `[agentic-tdd] State file at ${this.path} missing schema envelope — ` +
      `treating as raw context (forward-compat fallback).`,
    );
    return parsed as PipelineContext;
  }

  async delete(): Promise<void> {
    await this.#fs.deleteFile(this.path);
  }

  async exists(): Promise<boolean> {
    return this.#fs.exists(this.path);
  }
}
