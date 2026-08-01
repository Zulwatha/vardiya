import type { Handler, Job, JobContext, Storage, VardiyaEvents, WorkerOptions } from "../types.js";
import { TypedEmitter } from "../util/emitter.js";
import { sleep } from "../util/sleep.js";
import { AdaptivePoller } from "./poller.js";
import { Semaphore } from "./semaphore.js";

/**
 * Thrown from a handler when the job must not be retried.
 * The worker moves the job straight to dead letter.
 */
export class UnrecoverableError extends Error {
  override readonly name = "UnrecoverableError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Options for {@link WorkerRuntime} beyond the public {@link WorkerOptions}.
 */
export interface WorkerRuntimeOptions extends WorkerOptions {
  /**
   * Default handler timeout in milliseconds. When set, the job AbortSignal
   * is aborted after this duration. Per-handler overrides win when provided
   * to {@link WorkerRuntime.process}.
   */
  jobTimeoutMs?: number;
  /**
   * How often to refresh heartbeats for active jobs, in milliseconds.
   * Defaults to `Math.max(1000, Math.floor(pollIntervalMs / 2))`.
   */
  heartbeatIntervalMs?: number;
  /**
   * How long {@link WorkerRuntime.stop} waits for in-flight handlers before
   * aborting them and releasing leftovers. Defaults to 30_000.
   */
  drainTimeoutMs?: number;
  /**
   * Fast poll interval used while work is being found, in milliseconds.
   * Defaults to 10.
   */
  minPollIntervalMs?: number;
  /**
   * Optional sink for {@link JobContext.log} lines.
   */
  onLog?: (job: Job, msg: string) => void;
}

/** Per-handler registration options. */
export interface ProcessOptions {
  /** Override the default job timeout for this handler only. */
  timeoutMs?: number;
}

interface HandlerEntry {
  handler: Handler;
  timeoutMs: number | undefined;
}

type RuntimeState = "idle" | "running" | "stopping" | "stopped";

/** Options with defaults applied for required numeric knobs. */
export type ResolvedWorkerOptions = Readonly<{
  concurrency: number;
  pollIntervalMs: number;
  drainTimeoutMs: number;
  minPollIntervalMs: number;
  heartbeatIntervalMs: number;
  queues?: string[];
  jobTimeoutMs?: number;
  onLog?: (job: Job, msg: string) => void;
}>;

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_POLL_MS = 10;

/**
 * Pulls jobs from {@link Storage}, runs registered handlers, and emits
 * lifecycle events.
 *
 * This is the worker-owned implementation. The public {@link Worker} stub in
 * `vardiya.ts` wires storage into this runtime later.
 */
export class WorkerRuntime extends TypedEmitter<VardiyaEvents> {
  readonly #storage: Storage;
  readonly #options: ResolvedWorkerOptions;

  readonly #handlers = new Map<string, HandlerEntry>();
  readonly #semaphore: Semaphore;
  readonly #poller: AdaptivePoller;

  #state: RuntimeState = "idle";
  #loopAbort: AbortController | undefined;
  #loopPromise: Promise<void> | undefined;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #jobControllers = new Map<string, AbortController>();
  #signalDisposer: (() => void) | undefined;

  constructor(storage: Storage, options: WorkerRuntimeOptions = {}) {
    super();
    this.#storage = storage;

    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const concurrency = options.concurrency ?? 1;
    const minPollIntervalMs = options.minPollIntervalMs ?? DEFAULT_MIN_POLL_MS;
    const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(1000, Math.floor(pollIntervalMs / 2));

    const resolved: {
      concurrency: number;
      pollIntervalMs: number;
      minPollIntervalMs: number;
      drainTimeoutMs: number;
      heartbeatIntervalMs: number;
      queues?: string[];
      jobTimeoutMs?: number;
      onLog?: (job: Job, msg: string) => void;
    } = {
      concurrency,
      pollIntervalMs,
      minPollIntervalMs,
      drainTimeoutMs,
      heartbeatIntervalMs,
    };
    if (options.queues !== undefined) {
      resolved.queues = options.queues;
    }
    if (options.jobTimeoutMs !== undefined) {
      resolved.jobTimeoutMs = options.jobTimeoutMs;
    }
    if (options.onLog !== undefined) {
      resolved.onLog = options.onLog;
    }
    this.#options = Object.freeze(resolved);

    this.#semaphore = new Semaphore(concurrency);
    this.#poller = new AdaptivePoller({
      minMs: minPollIntervalMs,
      maxMs: pollIntervalMs,
    });
  }

  /** Resolved worker options (defaults applied). */
  get options(): ResolvedWorkerOptions {
    return this.#options;
  }

  /** Current lifecycle state. */
  get state(): RuntimeState {
    return this.#state;
  }

  /** Number of jobs currently executing handlers. */
  get activeCount(): number {
    return this.#inFlight.size;
  }

  /**
   * Register a handler for jobs named `name`. Chainable.
   *
   * @param name - Job name matched against {@link Job.name}.
   * @param handler - Async function that performs the work.
   * @param processOptions - Optional per-handler timeout override.
   */
  process<T = unknown>(name: string, handler: Handler<T>, processOptions?: ProcessOptions): this {
    if (this.#state === "running" || this.#state === "stopping") {
      throw new Error("Cannot register handlers while the worker is running");
    }
    this.#handlers.set(name, {
      handler: handler as Handler,
      timeoutMs: processOptions?.timeoutMs,
    });
    return this;
  }

  /**
   * Start the claim loop. Resolves once the loop is running.
   * Idempotent when already running.
   */
  async start(): Promise<void> {
    if (this.#state === "running") {
      return;
    }
    if (this.#state === "stopping") {
      throw new Error("Cannot start while stopping");
    }
    if (this.#handlers.size === 0) {
      throw new Error("No handlers registered; call process() before start()");
    }

    this.#state = "running";
    this.#loopAbort = new AbortController();
    this.#poller.reset();
    this.#loopPromise = this.#runLoop(this.#loopAbort.signal);
    this.emit("worker:started");
  }

  /**
   * Stop claiming, wait for in-flight jobs up to `drainTimeoutMs`, then abort
   * leftovers and release them back toward pending.
   *
   * Drain and abort run before awaiting the claim loop. The loop may be
   * blocked on the concurrency semaphore; aborting leftovers frees permits so
   * the loop can observe `stopping` and exit.
   */
  async stop(): Promise<void> {
    if (this.#state === "idle" || this.#state === "stopped") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopping") {
      await this.#loopPromise;
      return;
    }

    this.#state = "stopping";
    this.#loopAbort?.abort();

    await this.#waitForDrain(this.#options.drainTimeoutMs);

    // Force-abort anything still running past the drain window.
    for (const controller of this.#jobControllers.values()) {
      controller.abort();
    }

    // Give aborted handlers a moment to settle into release/fail.
    await this.#waitForDrain(this.#options.drainTimeoutMs);

    await this.#loopPromise;

    this.#uninstallSignalHandlers();
    this.#state = "stopped";
    this.emit("worker:stopped");
  }

  /**
   * Install process SIGINT/SIGTERM handlers that call {@link stop}.
   * Opt-in; returns a disposer. Safe to call once; subsequent calls no-op
   * until disposed.
   */
  installSignalHandlers(): () => void {
    if (this.#signalDisposer) {
      return this.#signalDisposer;
    }

    const onSignal = () => {
      void this.stop().catch((err: unknown) => {
        this.#emitInternalError(err);
      });
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    this.#signalDisposer = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      this.#signalDisposer = undefined;
    };
    return this.#signalDisposer;
  }

  #uninstallSignalHandlers(): void {
    this.#signalDisposer?.();
  }

  async #runLoop(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted && this.#state === "running") {
        await this.#semaphore.acquire();

        if (signal.aborted || this.#state !== "running") {
          this.#semaphore.release();
          break;
        }

        let claimed: Awaited<ReturnType<Storage["claimNext"]>>;
        try {
          const queues = this.#options.queues ?? [];
          claimed = await this.#storage.claimNext(queues, Date.now());
        } catch (err) {
          this.#semaphore.release();
          this.#emitInternalError(err);
          await this.#idleWait(signal);
          continue;
        }

        if (claimed === null) {
          this.#semaphore.release();
          await this.#idleWait(signal);
          continue;
        }

        this.#poller.onHit();
        const tracked = this.#runJob(claimed.job).finally(() => {
          this.#semaphore.release();
        });
        this.#track(tracked);
      }
    } catch (err) {
      this.#emitInternalError(err);
    }
  }

  async #idleWait(signal: AbortSignal): Promise<void> {
    const waitMs = this.#poller.onMiss();
    if (waitMs <= 0) {
      return;
    }
    try {
      await sleep(waitMs, signal);
    } catch {
      // Aborted by stop(); loop exits on next condition check.
    }
  }

  #track(promise: Promise<void>): void {
    this.#inFlight.add(promise);
    void promise.finally(() => {
      this.#inFlight.delete(promise);
    });
  }

  async #waitForDrain(timeoutMs: number): Promise<void> {
    if (this.#inFlight.size === 0) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled([...this.#inFlight]).then(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async #runJob(job: Job): Promise<void> {
    const entry = this.#handlers.get(job.name);
    const controller = new AbortController();
    this.#jobControllers.set(job.id, controller);

    const timeoutMs = entry?.timeoutMs ?? this.#options.jobTimeoutMs;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    // Latch abort if stop already raced past us. Later stop() aborts via
    // #jobControllers.
    if (this.#state === "stopping" || this.#state === "stopped") {
      controller.abort();
    }

    const heartbeatTimer = setInterval(() => {
      void this.#safeHeartbeat(job.id);
    }, this.#options.heartbeatIntervalMs);

    const ctx: JobContext = {
      signal: controller.signal,
      touch: () => {
        void this.#safeHeartbeat(job.id);
      },
      log: (msg: string) => {
        try {
          this.#options.onLog?.(job, msg);
        } catch (err) {
          this.#emitInternalError(err);
        }
      },
    };

    this.emit("job:active", job);

    try {
      if (!entry) {
        throw new UnrecoverableError(`No handler registered for job name "${job.name}"`);
      }

      const handlerPromise = entry.handler(job, ctx);
      const result = await this.#raceHandler(handlerPromise, controller.signal);

      try {
        await this.#storage.complete(job.id, result);
        this.emit("job:completed", job, result);
      } catch (err) {
        this.#emitInternalError(err);
      }
    } catch (err) {
      await this.#handleJobFailure(job, err, { timedOut, controller });
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      clearInterval(heartbeatTimer);
      this.#jobControllers.delete(job.id);
    }
  }

  /**
   * Race the handler against abort. When the signal fires first, reject so
   * the job can be failed/released; swallow later handler rejection.
   */
  async #raceHandler(handlerPromise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) {
      void handlerPromise.catch(() => undefined);
      throw abortAsError(signal);
    }

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        void handlerPromise.catch(() => undefined);
        reject(abortAsError(signal));
      };

      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };

      signal.addEventListener("abort", onAbort, { once: true });

      handlerPromise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (err: unknown) => {
          cleanup();
          reject(err);
        },
      );
    });
  }

  async #handleJobFailure(
    job: Job,
    err: unknown,
    meta: { timedOut: boolean; controller: AbortController },
  ): Promise<void> {
    const shuttingDown = this.#state === "stopping" || this.#state === "stopped";
    const aborted = meta.controller.signal.aborted;

    // Drain-timeout / stop path: release back toward pending without treating
    // the abort as a handler failure when we intentionally cancelled.
    if (shuttingDown && aborted && !meta.timedOut) {
      try {
        await this.#releaseToPending(job);
      } catch (releaseErr) {
        this.#emitInternalError(releaseErr);
      }
      return;
    }

    const error = toError(err, meta.timedOut ? "Job timed out" : "Job failed");

    if (error instanceof UnrecoverableError || isUnrecoverable(error)) {
      try {
        await this.#storage.moveToDead(job.id, error.message);
        this.emit("job:dead", job, error);
      } catch (storageErr) {
        this.#emitInternalError(storageErr);
      }
      return;
    }

    try {
      const updated = await this.#storage.fail({
        id: job.id,
        error: error.message,
        retryable: true,
      });
      if (updated.status === "dead") {
        this.emit("job:dead", updated, error);
      } else {
        this.emit("job:failed", updated, error);
      }
    } catch (storageErr) {
      this.#emitInternalError(storageErr);
    }
  }

  /** Return an aborted in-flight job to pending without burning an attempt. */
  async #releaseToPending(job: Job): Promise<void> {
    await this.#storage.release(job.id);
  }

  async #safeHeartbeat(id: string): Promise<void> {
    try {
      await this.#storage.heartbeat(id, Date.now());
    } catch (err) {
      this.#emitInternalError(err);
    }
  }

  #emitInternalError(err: unknown): void {
    this.emit("error", toError(err, "Internal worker error"));
  }
}

function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(fallback, { cause: err });
}

function isUnrecoverable(err: Error): boolean {
  return err.name === "UnrecoverableError";
}

function abortAsError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}
