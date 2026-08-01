import { nextRun } from "./scheduler/cron.js";
import { MaintenanceLoop } from "./scheduler/scheduler.js";
import { SqliteStorage } from "./storage/sqlite.js";
import type {
  EnqueueOptions,
  Handler,
  Job,
  JobCounts,
  RepeatableJob,
  Storage,
  VardiyaEvents,
  VardiyaOptions,
  WorkerOptions,
} from "./types.js";
import { TypedEmitter } from "./util/emitter.js";
import { UnrecoverableError, WorkerRuntime } from "./worker/worker.js";

function forwardWorkerEvents(
  from: TypedEmitter<VardiyaEvents>,
  to: TypedEmitter<VardiyaEvents>,
): void {
  from.on("job:active", (job) => {
    to.emit("job:active", job);
  });
  from.on("job:completed", (job, result) => {
    to.emit("job:completed", job, result);
  });
  from.on("job:failed", (job, error) => {
    to.emit("job:failed", job, error);
  });
  from.on("job:dead", (job, error) => {
    to.emit("job:dead", job, error);
  });
  from.on("worker:started", () => {
    to.emit("worker:started");
  });
  from.on("worker:stopped", () => {
    to.emit("worker:stopped");
  });
  from.on("error", (error) => {
    to.emit("error", error);
  });
}

/**
 * Top-level client for a vardiya queue backed by one SQLite file.
 *
 * Construct, call {@link init}, then enqueue work and attach workers.
 */
export class Vardiya extends TypedEmitter<VardiyaEvents> {
  readonly options: Readonly<VardiyaOptions>;

  #storage: SqliteStorage | undefined;
  #maintenance: MaintenanceLoop | undefined;
  #workers: Worker[] = [];
  #embeddedWorker: Worker | undefined;
  #embeddedStartScheduled = false;

  constructor(options: VardiyaOptions) {
    super();
    this.options = Object.freeze({ ...options });
  }

  /**
   * Open storage and run migrations. Must be called before other methods.
   */
  async init(): Promise<void> {
    if (this.#storage) {
      return;
    }

    const storage = new SqliteStorage(this.options.databasePath);
    await Promise.resolve(storage.init());
    this.#storage = storage;

    this.#maintenance = new MaintenanceLoop(storage, {
      onError: (error) => {
        this.emit("error", error);
      },
    });
    this.#maintenance.start();
  }

  /**
   * Close storage and stop any resources owned by this client.
   */
  async close(): Promise<void> {
    this.#maintenance?.stop();
    if (this.#maintenance) {
      await this.#maintenance.waitForIdle();
    }
    this.#maintenance = undefined;

    const workers = this.#workers.splice(0, this.#workers.length);
    this.#embeddedWorker = undefined;
    this.#embeddedStartScheduled = false;
    for (const worker of workers) {
      await worker.stop();
    }

    if (this.#storage) {
      await Promise.resolve(this.#storage.close());
      this.#storage = undefined;
    }
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
    const storage = this.#requireStorage();
    const queue = options?.queue ?? this.options.defaultQueue ?? "default";
    const { queue: _q, ...rest } = options ?? {};
    void _q;

    const merged: EnqueueOptions = { ...rest };
    const maxAttempts = rest.maxAttempts ?? this.options.defaultMaxAttempts;
    const backoff = rest.backoff ?? this.options.defaultBackoff;
    if (maxAttempts !== undefined) {
      merged.maxAttempts = maxAttempts;
    }
    if (backoff !== undefined) {
      merged.backoff = backoff;
    }

    const job = await Promise.resolve(storage.enqueue({ queue, name, payload, options: merged }));
    this.emit("job:added", job);
    return job;
  }

  /**
   * Register a handler for jobs with the given name on this client.
   * Used when the client also runs an embedded worker.
   *
   * Handlers registered in the same synchronous turn are batched, then the
   * embedded worker starts on a microtask.
   */
  process<T = unknown>(name: string, handler: Handler<T>): this {
    this.#requireStorage();
    if (!this.#embeddedWorker) {
      this.#embeddedWorker = this.createWorker();
    }
    this.#embeddedWorker.process(name, handler);

    if (!this.#embeddedStartScheduled) {
      this.#embeddedStartScheduled = true;
      const worker = this.#embeddedWorker;
      queueMicrotask(() => {
        void worker.start().catch((err: unknown) => {
          const error =
            err instanceof Error
              ? err
              : new Error("Embedded worker failed to start", { cause: err });
          this.emit("error", error);
        });
      });
    }
    return this;
  }

  /**
   * Create a worker bound to this client's database.
   */
  createWorker(options?: WorkerOptions): Worker {
    const storage = this.#requireStorage();
    const worker = new Worker({
      databasePath: this.options.databasePath,
      storage,
      ...options,
    });
    forwardWorkerEvents(worker, this);
    this.#workers.push(worker);
    return worker;
  }

  /** Fetch a job by id. */
  async getJob(id: string): Promise<Job | null> {
    return Promise.resolve(this.#requireStorage().getJob(id));
  }

  /** Cancel a job by id. */
  async cancel(id: string): Promise<Job | null> {
    return Promise.resolve(this.#requireStorage().cancel(id));
  }

  /** Status histogram for one queue, or all queues when omitted. */
  async counts(queue?: string): Promise<JobCounts> {
    return Promise.resolve(this.#requireStorage().counts(queue));
  }

  /** Delete old terminal jobs. Returns deleted row count. */
  async cleanup(olderThanMs: number): Promise<number> {
    return Promise.resolve(this.#requireStorage().cleanup(olderThanMs));
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
    const storage = this.#requireStorage();
    const queue = input.queue ?? this.options.defaultQueue ?? "default";
    const nextRunAt = nextRun(input.cron, new Date()).getTime();
    return Promise.resolve(
      storage.upsertRepeatable({
        queue,
        name: input.name,
        cron: input.cron,
        key: input.key,
        payload: input.payload ?? {},
        options: input.options ?? {},
        nextRunAt,
      }),
    );
  }

  /** List repeatable schedules, optionally filtered by queue. */
  async listRepeatables(queue?: string): Promise<RepeatableJob[]> {
    return Promise.resolve(this.#requireStorage().listRepeatables(queue));
  }

  #requireStorage(): SqliteStorage {
    if (!this.#storage) {
      throw new Error("Vardiya.init() must be called before use");
    }
    return this.#storage;
  }
}

/**
 * Polls storage, claims jobs, and runs registered handlers.
 *
 * Wraps {@link WorkerRuntime}. When constructed via {@link Vardiya.createWorker},
 * storage is shared with the client. A standalone Worker opens its own
 * SqliteStorage on {@link start} and closes it on {@link stop}.
 */
export class Worker extends TypedEmitter<VardiyaEvents> {
  /** Path to the SQLite file shared with the producer. */
  readonly databasePath: string;
  readonly options: Readonly<WorkerOptions>;

  #storage: Storage | undefined;
  #ownsStorage = false;
  #runtime: WorkerRuntime | undefined;
  readonly #pendingHandlers: Array<{ name: string; handler: Handler }> = [];

  constructor(
    options: WorkerOptions & {
      /** Path to the SQLite file shared with the producer. */
      databasePath: string;
      /**
       * Optional shared storage from {@link Vardiya}. When omitted, this worker
       * opens its own connection to {@link databasePath} on {@link start}.
       */
      storage?: Storage;
    },
  ) {
    super();
    this.databasePath = options.databasePath;
    const { databasePath: _, storage, ...workerOptions } = options;
    void _;
    this.options = Object.freeze({ ...workerOptions });
    if (storage) {
      this.#storage = storage;
      this.#ownsStorage = false;
    }
  }

  /**
   * Register a handler for `name`. Chainable.
   */
  process<T = unknown>(name: string, handler: Handler<T>): this {
    if (this.#runtime) {
      this.#runtime.process(name, handler);
    } else {
      this.#pendingHandlers.push({ name, handler: handler as Handler });
    }
    return this;
  }

  /**
   * Start polling and processing. Resolves once the worker loop is running.
   */
  async start(): Promise<void> {
    if (!this.#runtime) {
      if (!this.#storage) {
        const storage = new SqliteStorage(this.databasePath);
        await Promise.resolve(storage.init());
        this.#storage = storage;
        this.#ownsStorage = true;
      }

      const runtime = new WorkerRuntime(this.#storage, { ...this.options });
      for (const entry of this.#pendingHandlers) {
        runtime.process(entry.name, entry.handler);
      }
      this.#pendingHandlers.length = 0;

      forwardWorkerEvents(runtime, this);
      this.#runtime = runtime;
    }

    await this.#runtime.start();
  }

  /**
   * Stop claiming new work and wait for in-flight handlers (or abort them
   * via JobContext.signal, depending on the stop grace policy).
   */
  async stop(): Promise<void> {
    if (this.#runtime) {
      await this.#runtime.stop();
    }
    if (this.#ownsStorage && this.#storage) {
      await Promise.resolve(this.#storage.close());
      this.#storage = undefined;
      this.#ownsStorage = false;
    }
  }
}

export { UnrecoverableError };
