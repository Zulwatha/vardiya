/**
 * Adaptive poll delay for an idle/busy claim loop.
 *
 * After a successful claim the delay resets to `minMs` so the worker stays
 * snappy under load. After empty claims the delay doubles each miss until
 * it reaches `maxMs` (typically {@link WorkerOptions.pollIntervalMs}).
 */

export interface AdaptivePollerOptions {
  /** Delay used right after work was found, in milliseconds. */
  minMs: number;
  /** Upper bound for idle backoff, in milliseconds. */
  maxMs: number;
  /** Multiplier applied on each idle miss. Defaults to 2. */
  factor?: number;
}

/**
 * Pure backoff state. Call {@link onHit} / {@link onMiss}, then sleep for
 * {@link delayMs} before the next claim attempt.
 */
export class AdaptivePoller {
  readonly #minMs: number;
  readonly #maxMs: number;
  readonly #factor: number;
  #delayMs: number;

  constructor(options: AdaptivePollerOptions) {
    if (!Number.isFinite(options.minMs) || options.minMs < 0) {
      throw new Error("AdaptivePoller minMs must be a non-negative number");
    }
    if (!Number.isFinite(options.maxMs) || options.maxMs < options.minMs) {
      throw new Error("AdaptivePoller maxMs must be >= minMs");
    }
    const factor = options.factor ?? 2;
    if (!Number.isFinite(factor) || factor < 1) {
      throw new Error("AdaptivePoller factor must be >= 1");
    }
    this.#minMs = options.minMs;
    this.#maxMs = options.maxMs;
    this.#factor = factor;
    this.#delayMs = options.minMs;
  }

  /** Current wait before the next claim attempt. */
  get delayMs(): number {
    return this.#delayMs;
  }

  /** Reset to the fast interval after a successful claim. */
  onHit(): void {
    this.#delayMs = this.#minMs;
  }

  /**
   * Record an empty claim. Returns the delay to wait before retrying, then
   * grows the internal delay for the next miss.
   */
  onMiss(): number {
    const wait = this.#delayMs;
    const next = this.#delayMs === 0 ? Math.max(1, this.#minMs) : this.#delayMs * this.#factor;
    this.#delayMs = Math.min(this.#maxMs, next);
    return wait;
  }

  /** Force the delay back to `minMs`. */
  reset(): void {
    this.#delayMs = this.#minMs;
  }
}
