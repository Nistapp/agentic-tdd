import type { Logger as PinoLogger } from 'pino';
import type { ILogger } from '../core/interfaces.js';

export class PinoLoggerAdapter implements ILogger {
  readonly #pino: PinoLogger;

  constructor(pino: PinoLogger) {
    this.#pino = pino;
  }

  debug(msgOrObj: string | object, msg?: string): void {
    this.#pino.debug(msgOrObj as any, msg as any);
  }

  info(msgOrObj: string | object, msg?: string): void {
    this.#pino.info(msgOrObj as any, msg as any);
  }

  warn(msgOrObj: string | object, msg?: string): void {
    this.#pino.warn(msgOrObj as any, msg as any);
  }

  error(msgOrObj: string | object, msg?: string): void {
    this.#pino.error(msgOrObj as any, msg as any);
  }

  child(bindings: Record<string, unknown>): ILogger {
    return new PinoLoggerAdapter(this.#pino.child(bindings));
  }

  get level(): string {
    return this.#pino.level;
  }
}
