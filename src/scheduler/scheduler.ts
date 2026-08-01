import type { EnqueueOptions, RepeatableJob, Storage } from "../types.js";
import { unrefTimer } from "../util/timer.js";
import { nextRun, parseCron } from "./cron.js";

/**
 * Storage surface the maintenance loop needs. Same as {@link Storage}.
 */
export type SchedulerStorage = Storage;

/**
 * Configuration for {@link MaintenanceLoop}.
 * All fields are optional; omitted values use the defaults below.
 */
export interface MaintenanceLoopOptions {
  /**
   * Tick period in milliseconds. Default 1000.
   */
  intervalMs?: number;
  /**
   * Active jobs with a heartbeat older than this many ms are reclaimed.
   * Default 30_000.
   */
  stalledTimeoutMs?: number;
  /**
   * When set, each cleanup pass deletes terminal jobs older than this age.
   * When omitted, cleanup is skipped.
   */
  cleanupOlderThanMs?: number;
  /**
   * Run {@link Storage.cleanup} every N ticks (only when cleanupOlderThanMs
   * is set). Default 60 (roughly once a minute at the default interval).
   */
  cleanupEveryTicks?: number;
  /**
   * Cap how many missed occurrences one repeatable may materialize in a
   * single tick. Prevents a long outage from enqueueing a stampede.
   * Default 10.
   */
  maxCatchUpPerRepeatable?: number;
  /**
   * Clock injection for tests. Defaults to Date.now.
   */
  now?: () => number;
  /**
   * Called when a background tick throws. Tick errors never kill the interval.
   */
  onError?: (error: Error) => void;
}

const DEFAULTS = {
  intervalMs: 1000,
  stalledTimeoutMs: 30_000,
  cleanupEveryTicks: 60,
  maxCatchUpPerRepeatable: 10,
} as const;

/** Counters from one maintenance tick (useful for tests and metrics). */
export interface MaintenanceTickResult {
  promoted: number;
  reclaimed: number;
  materialized: number;
  cleaned: number;
}

/**
 * Build the idempotency job id for one occurrence of a repeatable.
 * Format: `repeat:{queue}:{key}:{scheduledAtMs}`.
 */
export function repeatOccurrenceJobId(queue: string, key: string, scheduledAtMs: number): string {
  return `repeat:${queue}:${key}:${scheduledAtMs}`;
}

/**
 * Periodic maintenance for a vardiya database.
 *
 * Each tick:
 * 1. Promote delayed jobs whose runAt has arrived.
 * 2. Reclaim stalled active jobs (stale heartbeat).
 * 3. Materialize due repeatables into concrete jobs (deduped by job id).
 * 4. Optionally clean up old completed/dead jobs.
 *
 * Depends only on the {@link Storage} interface.
 * Never imports a concrete storage or worker implementation.
 */
export class MaintenanceLoop {
  private readonly storage: SchedulerStorage;
  private readonly intervalMs: number;
  private readonly stalledTimeoutMs: number;
  private readonly cleanupOlderThanMs: number | undefined;
  private readonly cleanupEveryTicks: number;
  private readonly maxCatchUpPerRepeatable: number;
  private readonly now: () => number;
  private readonly onError: ((error: Error) => void) | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;
  private ticks = 0;
  private started = false;

  constructor(storage: SchedulerStorage, options: MaintenanceLoopOptions = {}) {
    this.storage = storage;
    this.intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
    this.stalledTimeoutMs = options.stalledTimeoutMs ?? DEFAULTS.stalledTimeoutMs;
    this.cleanupOlderThanMs = options.cleanupOlderThanMs;
    this.cleanupEveryTicks = options.cleanupEveryTicks ?? DEFAULTS.cleanupEveryTicks;
    this.maxCatchUpPerRepeatable =
      options.maxCatchUpPerRepeatable ?? DEFAULTS.maxCatchUpPerRepeatable;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  /** Whether {@link start} has been called and {@link stop} has not. */
  get running(): boolean {
    return this.started;
  }

  /**
   * Begin ticking on `intervalMs`. Idempotent.
   * Fires an immediate tick so delayed/repeatable work is not held for a full
   * interval after startup.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.safeTick();
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.intervalMs);
    // Allow the process to exit naturally while the loop is the only waiter.
    unrefTimer(this.timer);
  }

  /**
   * Stop the interval timer. In-flight tick work is allowed to finish.
   * Idempotent.
   */
  stop(): void {
    this.started = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Resolve once any in-flight tick finishes. Call after {@link stop} before
   * closing storage so the process can exit cleanly.
   */
  async waitForIdle(): Promise<void> {
    while (this.tickInFlight) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        unrefTimer(timer);
      });
    }
  }

  /**
   * Run one maintenance cycle. Safe to call from tests without {@link start}.
   * Overlapping calls are skipped (returns zeros) so ticks never pile up.
   */
  async tick(): Promise<MaintenanceTickResult> {
    if (this.tickInFlight) {
      return { promoted: 0, reclaimed: 0, materialized: 0, cleaned: 0 };
    }
    this.tickInFlight = true;
    this.ticks += 1;

    try {
      const now = this.now();

      const promoted = await Promise.resolve(this.storage.promoteDelayed(now));
      const reclaimed = await Promise.resolve(
        this.storage.reclaimStale(now, this.stalledTimeoutMs),
      );
      const materialized = await this.materializeRepeatables(now);

      let cleaned = 0;
      if (this.cleanupOlderThanMs !== undefined && this.ticks % this.cleanupEveryTicks === 0) {
        cleaned = await Promise.resolve(this.storage.cleanup(this.cleanupOlderThanMs, now));
      }

      return { promoted, reclaimed, materialized, cleaned };
    } finally {
      this.tickInFlight = false;
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      // Tick errors must not kill the interval.
      const error =
        err instanceof Error ? err : new Error("Maintenance tick failed", { cause: err });
      try {
        this.onError?.(error);
      } catch {
        // Listener errors must not kill the interval either.
      }
    }
  }

  /**
   * For every repeatable whose nextRunAt is due, enqueue a job and advance
   * nextRunAt. Uses {@link repeatOccurrenceJobId} so a retried tick cannot
   * create duplicates.
   */
  private async materializeRepeatables(now: number): Promise<number> {
    const list = await Promise.resolve(this.storage.listRepeatables());
    let materialized = 0;

    for (const repeatable of list) {
      materialized += await this.materializeOne(repeatable, now);
    }

    return materialized;
  }

  private async materializeOne(repeatable: RepeatableJob, now: number): Promise<number> {
    // Validate cron once so a bad row fails loudly instead of spinning.
    const schedule = parseCron(repeatable.cron);

    let nextAt = repeatable.nextRunAt;
    if (nextAt === undefined) {
      // First materialization: schedule the occurrence after "now".
      // Callers that want an immediate first fire should set nextRunAt on upsert.
      nextAt = nextRun(schedule, new Date(now)).getTime();
      await this.persistNextRun(repeatable, nextAt);
      return 0;
    }

    let produced = 0;
    let cursor = nextAt;

    while (cursor <= now && produced < this.maxCatchUpPerRepeatable) {
      const jobId = repeatOccurrenceJobId(repeatable.queue, repeatable.key, cursor);

      const enqueueOptions: EnqueueOptions = {
        ...repeatable.options,
        runAt: cursor,
        jobId,
        repeat: { cron: repeatable.cron, key: repeatable.key },
      };

      await Promise.resolve(
        this.storage.enqueue({
          queue: repeatable.queue,
          name: repeatable.name,
          payload: repeatable.payload,
          options: enqueueOptions,
        }),
      );

      produced += 1;
      cursor = nextRun(schedule, new Date(cursor)).getTime();
    }

    if (cursor !== repeatable.nextRunAt) {
      await this.persistNextRun(repeatable, cursor);
    }

    return produced;
  }

  private async persistNextRun(repeatable: RepeatableJob, nextRunAt: number): Promise<void> {
    await Promise.resolve(
      this.storage.upsertRepeatable({
        queue: repeatable.queue,
        name: repeatable.name,
        cron: repeatable.cron,
        key: repeatable.key,
        payload: repeatable.payload,
        options: repeatable.options,
        nextRunAt,
      }),
    );
  }
}
