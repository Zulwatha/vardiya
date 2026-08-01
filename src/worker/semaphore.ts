/**
 * Counting semaphore for bounding in-flight work.
 *
 * acquire() waits when no permits remain. release() hands the permit to the
 * oldest waiter when one exists, otherwise increments the free count.
 */

export class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  /**
   * @param count - Maximum concurrent permits. Must be a positive integer.
   */
  constructor(count: number) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error("Semaphore count must be a positive integer");
    }
    this.#available = count;
  }

  /** Permits that can be taken without waiting. */
  get available(): number {
    return this.#available;
  }

  /** Callers blocked in {@link acquire}. */
  get pending(): number {
    return this.#waiters.length;
  }

  /**
   * Take a permit if one is free. Returns false when the caller must wait.
   */
  tryAcquire(): boolean {
    if (this.#available > 0) {
      this.#available -= 1;
      return true;
    }
    return false;
  }

  /**
   * Take a permit, waiting until one is released when none are free.
   */
  acquire(): Promise<void> {
    if (this.tryAcquire()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /**
   * Return a permit. If waiters exist, the oldest waiter receives it
   * immediately (available stays at 0 for that handoff).
   */
  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#available += 1;
  }
}
