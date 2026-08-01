import type {
  EnqueueOptions,
  Handler,
  Job,
  JobCounts,
  RepeatableJob,
  VardiyaEvents,
  VardiyaOptions,
  WorkerOptions,
} from "./types.js";
import { TypedEmitter } from "./util/emitter.js";

/**
 * Top-level client for a vardiya queue backed by one SQLite file.
 *
 * Construct, call {@link init}, then enqueue work and attach workers.
 * Bodies are stubbed in this foundation pass; Agent B/C wire them up.
 */
export class Vardiya extends TypedEmitter<VardiyaEvents> {
  readonly options: Readonly<VardiyaOptions>;

  constructor(options: VardiyaOptions) {
    super();
    this.options = Object.freeze({ ...options });
  }

  /**
   * Open storage and run migrations. Must be called before other methods.
   */
  async init(): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Close storage and stop any resources owned by this client.
   */
  async close(): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Enqueue a job on `queue` (or the default queue when omitted via options).
   *
   * @param name - Handler name workers use to route the job.
   * @param payload - Data delivered to the handler.
   * @param options - Delay, priority, retries, idempotency, and repeat.
   */
  async enqueue<T = unknown>(
    name: string,
    payload: T,
    options?: EnqueueOptions & { queue?: string },
  ): Promise<Job<T>> {
    void name;
    void payload;
    void options;
    throw new Error("not implemented");
  }

  /**
   * Register a handler for jobs with the given name on this client.
   * Used when the client also runs an embedded worker.
   */
  process<T = unknown>(name: string, handler: Handler<T>): this {
    void name;
    void handler;
    throw new Error("not implemented");
  }

  /**
   * Create a worker bound to this client's database.
   */
  createWorker(options?: WorkerOptions): Worker {
    void options;
    throw new Error("not implemented");
  }

  /** Fetch a job by id. */
  async getJob(id: string): Promise<Job | null> {
    void id;
    throw new Error("not implemented");
  }

  /** Cancel a job by id. */
  async cancel(id: string): Promise<Job | null> {
    void id;
    throw new Error("not implemented");
  }

  /** Status histogram for one queue, or all queues when omitted. */
  async counts(queue?: string): Promise<JobCounts> {
    void queue;
    throw new Error("not implemented");
  }

  /** Delete old terminal jobs. Returns deleted row count. */
  async cleanup(olderThanMs: number): Promise<number> {
    void olderThanMs;
    throw new Error("not implemented");
  }

  /**
   * Create or replace a repeatable cron schedule.
   */
  async upsertRepeatable(input: {
    queue?: string;
    name: string;
    cron: string;
    key: string;
    payload?: unknown;
    options?: Omit<EnqueueOptions, "repeat" | "delayMs" | "runAt" | "jobId">;
  }): Promise<RepeatableJob> {
    void input;
    throw new Error("not implemented");
  }

  /** List repeatable schedules, optionally filtered by queue. */
  async listRepeatables(queue?: string): Promise<RepeatableJob[]> {
    void queue;
    throw new Error("not implemented");
  }
}

/**
 * Polls storage, claims jobs, and runs registered handlers.
 *
 * Owned by Agent B. Signatures here are final; implementations fill the body.
 */
export class Worker extends TypedEmitter<VardiyaEvents> {
  /** Path to the SQLite file shared with the producer. */
  readonly databasePath: string;
  readonly options: Readonly<WorkerOptions>;

  constructor(
    options: WorkerOptions & {
      /** Path to the SQLite file shared with the producer. */
      databasePath: string;
    },
  ) {
    super();
    this.databasePath = options.databasePath;
    const { databasePath: _, ...workerOptions } = options;
    void _;
    this.options = Object.freeze({ ...workerOptions });
  }

  /**
   * Register a handler for `name`. Chainable.
   */
  process<T = unknown>(name: string, handler: Handler<T>): this {
    void name;
    void handler;
    throw new Error("not implemented");
  }

  /**
   * Start polling and processing. Resolves once the worker loop is running.
   */
  async start(): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Stop claiming new work and wait for in-flight handlers (or abort them
   * via JobContext.signal, depending on the stop grace policy).
   */
  async stop(): Promise<void> {
    throw new Error("not implemented");
  }
}
