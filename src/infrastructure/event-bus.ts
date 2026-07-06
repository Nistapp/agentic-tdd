import { EventEmitter } from 'node:events';
import type { IEventBus } from '../core/interfaces.js';
import type { AgenticEvent, AgenticEventKind } from '../core/types.js';

export class EventBus implements IEventBus {
  readonly #emitter = new EventEmitter();

  emit(event: AgenticEvent): void {
    this.#emitter.emit(event.kind, event);
  }

  on(kind: AgenticEventKind, handler: (event: AgenticEvent) => void): () => void {
    this.#emitter.on(kind, handler);
    return () => {
      this.#emitter.off(kind, handler);
    };
  }
}