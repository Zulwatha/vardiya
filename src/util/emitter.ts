import { EventEmitter } from "node:events";

/**
 * Typed EventEmitter wrapper. Listener args come from a map of event name
 * to a tuple of parameters, matching Node's EventEmitter call style.
 *
 * @typeParam Events - Map from event name to argument tuple.
 */
export class TypedEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly ee = new EventEmitter();

  on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.ee.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.ee.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.ee.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return this.ee.emit(event, ...args);
  }

  removeAllListeners<K extends keyof Events & string>(event?: K): this {
    if (event === undefined) {
      this.ee.removeAllListeners();
    } else {
      this.ee.removeAllListeners(event);
    }
    return this;
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.ee.listenerCount(event);
  }
}
