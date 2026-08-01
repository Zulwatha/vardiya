/**
 * Shared type contract for vardiya.
 *
 * This file is frozen. If you believe a change is required, add a comment
 * block starting with PROPOSED-CHANGE instead of editing the definitions.
 * Other agents build against these shapes in parallel.
 */

/**
 * Lifecycle state of a job in the queue.
 *
 * - `pending`: ready to be claimed by a worker
 * - `active`: claimed and currently running
 * - `completed`: finished successfully
 * - `failed`: exhausted a retryable failure (may still be eligible for retry
 *   depending on attempts vs maxAttempts; storage decides when it becomes dead)
 * - `delayed`: scheduled for a future `runAt`
 * - `dead`: permanently failed or cancelled; will not run again
 */
export type JobStatus = "pending" | "active" | "completed" | "failed" | "delayed" | "dead";

/**
 * How retries wait between attempts.
 *
 * `fixed` always waits `delayMs`. `exponential` waits
 * `delayMs * 2^(attempt - 1)`, capped by `maxDelayMs` when set.
 * When `jitter` is true, a random factor is applied so retries do not stampede.
 */
export interface BackoffOptions {
  /** Backoff strategy. */
  type: "fixed" | "exponential";
  /** Base delay in milliseconds. */
  delayMs: number;
  /** Upper bound for exponential backoff, in milliseconds. */
  maxDelayMs?: number;
  /** When true, add randomness to the computed delay. */
  jitter?: boolean;
}

/**
 * Options accepted when enqueuing a job.
 */
export interface EnqueueOptions {
  /**
   * Higher numbers run first. Defaults to 0 when omitted.
   */
  priority?: number;
  /**
   * Delay from now before the job becomes runnable, in milliseconds.
   * Mutually exclusive with `runAt` at the call site; if both are set,
   * `runAt` wins.
   */
  delayMs?: number;
  /**
   * Absolute time (unix ms) when the job becomes runnable.
   */
  runAt?: number;
  /**
   * Maximum number of attempts including the first run. Defaults to 1.
   */
  maxAttempts?: number;
  /**
   * Retry wait strategy used when a handler throws and attempts remain.
   */
  backoff?: BackoffOptions;
  /**
   * Caller-supplied id for idempotency. If a job with this id already exists
   * in the same queue, enqueue is a no-op (or returns the existing job).
   */
  jobId?: string;
  /**
   * When set, the job is also registered as a repeatable schedule.
   * `cron` is a standard 5-field cron expression. `key` uniquely identifies
   * the schedule within the queue for upserts and cancellation.
   */
  repeat?: {
    cron: string;
    key: string;
  };
}

/**
 * A durable unit of work stored in SQLite.
 *
 * @typeParam T - Shape of `payload`. Defaults to `unknown`.
 */
export interface Job<T = unknown> {
  /** Unique job id (caller-supplied or generated). */
  id: string;
  /** Queue name this job belongs to. */
  queue: string;
  /** Handler name used to route the job to a registered function. */
  name: string;
  /** Opaque payload delivered to the handler. */
  payload: T;
  /** Current lifecycle status. */
  status: JobStatus;
  /** Higher numbers are claimed first among runnable jobs. */
  priority: number;
  /** How many times this job has been started (including the current run). */
  attempts: number;
  /** Maximum number of starts allowed before the job moves to `dead`. */
  maxAttempts: number;
  /**
   * Earliest unix ms when a worker may claim this job.
   * For delayed jobs this is in the future; for pending it is `<= now`.
   */
  runAt: number;
  /** Creation time as unix ms. */
  createdAt: number;
  /** Last mutation time as unix ms. */
  updatedAt: number;
  /** Message from the most recent failure, if any. */
  lastError?: string;
  /** Cron expression when this job was produced by a repeatable schedule. */
  cron?: string;
  /** Repeatable schedule key when this job is tied to a repeat registration. */
  repeatKey?: string;
}

/**
 * Per-job runtime helpers passed to handlers.
 */
export interface JobContext {
  /**
   * Aborted when the worker is shutting down or the job is cancelled.
   * Handlers should check this (or listen for abort) for cooperative cancel.
   */
  signal: AbortSignal;
  /**
   * Refresh the job's heartbeat so the worker is not considered stalled.
   * Call this during long-running work.
   */
  touch(): void;
  /**
   * Emit a structured log line associated with this job.
   */
  log(msg: string): void;
}

/**
 * Job handler. Receives the job and a context; return value is stored as the
 * completion result by the worker layer (implementation detail of Agent B).
 *
 * @typeParam T - Expected payload type.
 */
export type Handler<T = unknown> = (job: Job<T>, ctx: JobContext) => Promise<unknown>;

/**
 * Options that configure a worker process.
 */
export interface WorkerOptions {
  /**
   * Max number of jobs processed in parallel. Defaults to 1.
   */
  concurrency?: number;
  /**
   * How often the worker polls storage for new work, in milliseconds.
   * Defaults are chosen by the worker implementation.
   */
  pollIntervalMs?: number;
  /**
   * Restrict claiming to these queue names. When omitted, the worker claims
   * from every queue.
   */
  queues?: string[];
}

/**
 * Counts of jobs grouped by status for one queue (or across queues).
 */
export interface JobCounts {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  dead: number;
}

/**
 * A registered repeatable schedule.
 */
export interface RepeatableJob {
  /** Queue the schedule belongs to. */
  queue: string;
  /** Handler name for produced jobs. */
  name: string;
  /** Cron expression (5-field). */
  cron: string;
  /** Unique key within the queue. */
  key: string;
  /** Template payload cloned into each produced job. */
  payload: unknown;
  /** Options applied when producing each occurrence. */
  options: Omit<EnqueueOptions, "repeat" | "delayMs" | "runAt" | "jobId">;
  /** Next planned fire time as unix ms, if known. */
  nextRunAt?: number;
  /** Creation time as unix ms. */
  createdAt: number;
  /** Last update time as unix ms. */
  updatedAt: number;
}

/**
 * Arguments for {@link Storage.enqueue}.
 */
export interface EnqueueInput<T = unknown> {
  queue: string;
  name: string;
  payload: T;
  options?: EnqueueOptions;
}

/**
 * Result of a successful claim: the job plus any storage-side metadata the
 * worker needs (for example lease tokens). Kept minimal for now.
 */
export interface ClaimedJob<T = unknown> {
  job: Job<T>;
}

/**
 * Arguments for {@link Storage.fail}.
 */
export interface FailInput {
  /** Job id. */
  id: string;
  /** Error message to persist as `lastError`. */
  error: string;
  /**
   * When true (and attempts remain), the job is rescheduled with backoff.
   * When false, or when maxAttempts is reached, the job moves to `dead`.
   */
  retryable?: boolean;
  /** Absolute unix ms for the next attempt. Storage may also compute this. */
  nextRunAt?: number;
}

/**
 * Typed event map for the public EventEmitter surface.
 * Values are the listener argument tuples.
 */
export interface VardiyaEvents {
  "job:added": [job: Job];
  "job:active": [job: Job];
  "job:completed": [job: Job, result: unknown];
  "job:failed": [job: Job, error: Error];
  "job:dead": [job: Job, error: Error];
  "worker:started": [];
  "worker:stopped": [];
  error: [error: Error];
}

/**
 * Options for constructing the top-level {@link Vardiya} client.
 */
export interface VardiyaOptions {
  /**
   * Path to the SQLite database file. Use `:memory:` for tests.
   */
  databasePath: string;
  /**
   * Default queue name used when enqueue/process omit an explicit queue.
   * Defaults to `"default"`.
   */
  defaultQueue?: string;
  /**
   * Default maxAttempts applied when enqueue options omit it.
   */
  defaultMaxAttempts?: number;
  /**
   * Default backoff applied when enqueue options omit it.
   */
  defaultBackoff?: BackoffOptions;
}

/**
 * Storage abstraction over SQLite. Owned by Agent A.
 *
 * Implementations must make {@link claimNext} atomic under concurrent workers
 * sharing the same database file (WAL mode + careful transactions).
 */
export interface Storage {
  /**
   * Open the database and apply migrations. Idempotent.
   */
  init(): void | Promise<void>;

  /**
   * Apply pending schema migrations. Usually called from {@link init}.
   */
  migrate(): void | Promise<void>;

  /**
   * Insert a job (or return the existing one when `options.jobId` already
   * exists for that queue). Jobs with a future `runAt` start as `delayed`;
   * otherwise as `pending`.
   */
  enqueue<T = unknown>(input: EnqueueInput<T>): Job<T> | Promise<Job<T>>;

  /**
   * Atomically claim the next runnable job from the given queues.
   * Runnable means `status` is `pending` (or delayed that has been promoted)
   * and `runAt <= now`. Prefer higher `priority`, then older `runAt` / `createdAt`.
   * Returns `null` when nothing is available.
   *
   * @param queues - Queue names to claim from. Empty means all queues.
   * @param now - Current time as unix ms (injected for tests).
   */
  claimNext(queues: string[], now: number): ClaimedJob | null | Promise<ClaimedJob | null>;

  /**
   * Mark a job completed and store an optional result.
   */
  complete(id: string, result?: unknown): void | Promise<void>;

  /**
   * Record a failure. May reschedule (failed/delayed) or move to dead based
   * on attempts and {@link FailInput.retryable}.
   */
  fail(input: FailInput): Job | Promise<Job>;

  /**
   * Force a job into `dead` status with the given error message.
   */
  moveToDead(id: string, error: string): void | Promise<void>;

  /**
   * Promote delayed jobs whose `runAt <= now` into `pending`.
   * Returns how many rows were promoted.
   */
  promoteDelayed(now: number): number | Promise<number>;

  /**
   * Create or replace a repeatable schedule identified by `(queue, key)`.
   */
  upsertRepeatable(
    repeatable: Omit<RepeatableJob, "createdAt" | "updatedAt" | "nextRunAt"> & {
      nextRunAt?: number;
    },
  ): RepeatableJob | Promise<RepeatableJob>;

  /**
   * List repeatable schedules, optionally filtered by queue.
   */
  listRepeatables(queue?: string): RepeatableJob[] | Promise<RepeatableJob[]>;

  /**
   * Refresh the heartbeat timestamp for an active job so stall detection
   * does not reclaim it.
   */
  heartbeat(id: string, now: number): void | Promise<void>;

  /**
   * Cancel a job by id. Pending/delayed jobs become `dead`. Active jobs are
   * marked for cooperative cancel (implementation may set a flag and abort
   * the handler signal). Returns the updated job, or `null` if not found.
   */
  cancel(id: string): Job | null | Promise<Job | null>;

  /**
   * Fetch a single job by id, or `null` if it does not exist.
   */
  getJob(id: string): Job | null | Promise<Job | null>;

  /**
   * Status histogram. When `queue` is omitted, counts across all queues.
   */
  counts(queue?: string): JobCounts | Promise<JobCounts>;

  /**
   * Delete terminal jobs (`completed`, `dead`) older than `olderThanMs`
   * relative to `now` (or relative to their `updatedAt`). Returns the number
   * of deleted rows.
   */
  cleanup(olderThanMs: number, now?: number): number | Promise<number>;

  /**
   * Close the database connection. Safe to call more than once.
   */
  close(): void | Promise<void>;
}
