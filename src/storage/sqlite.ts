import Database from "better-sqlite3";
import type {
  BackoffOptions,
  ClaimedJob,
  EnqueueInput,
  EnqueueOptions,
  FailInput,
  Job,
  JobCounts,
  JobStatus,
  RepeatableJob,
  Storage,
} from "../types.js";
import { createId } from "../util/id.js";
import { SCHEMA_VERSION, migrate as runMigrations } from "./schema.js";

type Statement = Database.Statement;

/** Default busy wait before SQLite returns SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5000;

/** Fallback backoff when a job has none stored and fail() omits nextRunAt. */
const DEFAULT_BACKOFF: BackoffOptions = {
  type: "exponential",
  delayMs: 1000,
  maxDelayMs: 60_000,
  jitter: true,
};

type JobRow = {
  id: string;
  queue: string;
  name: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  cron: string | null;
  repeat_key: string | null;
  heartbeat_at: number | null;
  backoff_json: string | null;
  result_json: string | null;
  cancel_requested: number;
};

type RepeatableRow = {
  queue: string;
  key: string;
  name: string;
  cron: string;
  payload: string;
  options_json: string;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type Prepared = {
  insertJob: Statement;
  getJob: Statement;
  complete: Statement;
  moveToDead: Statement;
  reschedule: Statement;
  promoteDelayed: Statement;
  heartbeat: Statement;
  reclaimStale: Statement;
  cancelTerminal: Statement;
  cancelActive: Statement;
  countsAll: Statement;
  countsQueue: Statement;
  cleanup: Statement;
  upsertRepeatable: Statement;
  getRepeatable: Statement;
  listRepeatablesAll: Statement;
  listRepeatablesQueue: Statement;
  /** claimNext with no queue filter. */
  claimAll: Statement;
  /** claimNext keyed by queue-count for dynamic IN lists. */
  claimByQueueCount: Map<number, Statement>;
};

/**
 * Run `fn`, and if SQLite still reports SQLITE_BUSY after busy_timeout,
 * retry once. The timeout already spun; this covers the rare case where the
 * lock is released in the gap before we give up entirely.
 */
function withBusyRetry<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (isSqliteBusy(err)) {
      return fn();
    }
    throw err;
  }
}

function isSqliteBusy(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "SQLITE_BUSY"
  );
}

/**
 * Compute retry delay in ms from {@link BackoffOptions}.
 * Exponential uses `delayMs * 2^(attempt - 1)`, capped by `maxDelayMs`.
 * Full jitter (when `jitter` is true): uniform pick in `[0, delay]`.
 */
export function computeBackoffMs(backoff: BackoffOptions, attempt: number): number {
  const safeAttempt = Math.max(1, attempt);
  let delay: number;
  if (backoff.type === "fixed") {
    delay = backoff.delayMs;
  } else {
    delay = backoff.delayMs * 2 ** (safeAttempt - 1);
    if (backoff.maxDelayMs !== undefined) {
      delay = Math.min(delay, backoff.maxDelayMs);
    }
  }
  if (backoff.jitter) {
    delay = Math.floor(Math.random() * (delay + 1));
  }
  return Math.max(0, delay);
}

function rowToJob<T = unknown>(row: JobRow): Job<T> {
  const job: Job<T> = {
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: JSON.parse(row.payload) as T,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.last_error != null) job.lastError = row.last_error;
  if (row.cron != null) job.cron = row.cron;
  if (row.repeat_key != null) job.repeatKey = row.repeat_key;
  return job;
}

function rowToRepeatable(row: RepeatableRow): RepeatableJob {
  const repeatable: RepeatableJob = {
    queue: row.queue,
    name: row.name,
    cron: row.cron,
    key: row.key,
    payload: JSON.parse(row.payload) as unknown,
    options: JSON.parse(row.options_json) as RepeatableJob["options"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.next_run_at != null) repeatable.nextRunAt = row.next_run_at;
  return repeatable;
}

function emptyCounts(): JobCounts {
  return {
    pending: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    dead: 0,
  };
}

/**
 * SQLite-backed {@link Storage}.
 *
 * better-sqlite3 is synchronous on purpose. Queue operations are short
 * SQL statements (microseconds to low milliseconds). Wrapping them in async
 * would only add Promise overhead and still block the event loop during the
 * native call. Callers that need concurrency yield between claims (see
 * `selfcheck.ts`); multi-process safety comes from WAL + atomic UPDATE claim.
 */
export class SqliteStorage implements Storage {
  readonly path: string;
  private readonly db: Database.Database;
  private prepared: Prepared | null = null;
  private closed = false;

  /**
   * Open a database at `path` (`:memory:` for ephemeral). Applies PRAGMAs
   * immediately; call {@link init} before other methods.
   */
  constructor(path: string) {
    this.path = path;
    this.db = new Database(path);

    // WAL: readers do not block writers and writers do not block readers.
    // Multiple worker processes can claim while producers enqueue.
    this.db.pragma("journal_mode = WAL");

    // busy_timeout: wait this long for a lock instead of failing immediately
    // under concurrent writers (SQLite is still single-writer at a time).
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // NORMAL with WAL: fsync on checkpoints, not every commit. Big throughput
    // win; durability is still fine for a job queue (lose at most one frame
    // of WAL on power loss, not the whole DB).
    this.db.pragma("synchronous = NORMAL");

    // Enforce FK constraints if we add them later; cheap and correct by default.
    this.db.pragma("foreign_keys = ON");
  }

  /**
   * Open path is already opened in the constructor; this runs migrations and
   * prepares statements. Idempotent.
   */
  init(): void {
    this.assertOpen();
    this.migrate();
    this.prepared = this.prepareStatements();
  }

  /**
   * Apply pending schema migrations via `PRAGMA user_version`.
   */
  migrate(): void {
    this.assertOpen();
    withBusyRetry(() => runMigrations(this.db));
  }

  /**
   * Insert a job. When `options.jobId` already exists, returns the existing
   * row (INSERT OR IGNORE). Future `runAt` starts as `delayed`.
   */
  enqueue<T = unknown>(input: EnqueueInput<T>): Job<T> {
    this.assertReady();
    const stmts = this.stmts;
    const now = Date.now();
    const options = input.options;
    const id = options?.jobId ?? createId(now);

    let runAt = now;
    if (options?.runAt !== undefined) {
      runAt = options.runAt;
    } else if (options?.delayMs !== undefined) {
      runAt = now + options.delayMs;
    }

    const status: JobStatus = runAt > now ? "delayed" : "pending";
    const priority = options?.priority ?? 0;
    const maxAttempts = options?.maxAttempts ?? 1;
    const backoffJson = options?.backoff !== undefined ? JSON.stringify(options.backoff) : null;
    const cron = options?.repeat?.cron ?? null;
    const repeatKey = options?.repeat?.key ?? null;
    const payloadJson = JSON.stringify(input.payload ?? null);

    const insertAndMaybeRepeat = this.db.transaction(() => {
      const result = stmts.insertJob.run({
        id,
        queue: input.queue,
        name: input.name,
        payload: payloadJson,
        status,
        priority,
        attempts: 0,
        max_attempts: maxAttempts,
        run_at: runAt,
        created_at: now,
        updated_at: now,
        last_error: null,
        cron,
        repeat_key: repeatKey,
        heartbeat_at: null,
        backoff_json: backoffJson,
        result_json: null,
        cancel_requested: 0,
      });

      if (options?.repeat) {
        this.upsertRepeatableInTxn({
          queue: input.queue,
          name: input.name,
          cron: options.repeat.cron,
          key: options.repeat.key,
          payload: input.payload,
          options: omitRepeatFields(options),
          nextRunAt: runAt,
        });
      }

      return result.changes > 0;
    });

    const inserted = withBusyRetry(() => insertAndMaybeRepeat());
    if (!inserted) {
      const existing = this.getJob(id);
      if (existing) return existing as Job<T>;
      // Race: row vanished between IGNORE and get; treat as fresh miss.
      throw new Error(`enqueue: job id ${id} was not inserted and could not be loaded`);
    }
    return this.getJob(id) as Job<T>;
  }

  /**
   * Atomically claim the next runnable job.
   *
   * Single statement: `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`.
   * Two workers cannot both win the same row; SQLite serializes the writes
   * and only one UPDATE matches.
   */
  claimNext(queues: string[], now: number): ClaimedJob | null {
    this.assertReady();
    const stmts = this.stmts;

    const row = withBusyRetry(() => {
      if (queues.length === 0) {
        return stmts.claimAll.get(now, now, now) as JobRow | undefined;
      }
      const stmt = this.claimStmtForQueues(queues.length);
      // updated_at, heartbeat_at, run_at bound, then IN (...) queues
      return stmt.get(now, now, now, ...queues) as JobRow | undefined;
    });

    if (!row) return null;
    return { job: rowToJob(row) };
  }

  /**
   * Mark a job completed and optionally persist a JSON result.
   */
  complete(id: string, result?: unknown): void {
    this.assertReady();
    const now = Date.now();
    const resultJson = result === undefined ? null : JSON.stringify(result);
    withBusyRetry(() =>
      this.stmts.complete.run({
        id,
        updated_at: now,
        result_json: resultJson,
      }),
    );
  }

  /**
   * Record a failure. Reschedules with backoff when retryable and attempts
   * remain; otherwise moves the job to `dead`.
   */
  fail(input: FailInput): Job {
    this.assertReady();
    const now = Date.now();

    const run = this.db.transaction(() => {
      const row = this.stmts.getJob.get(input.id) as JobRow | undefined;
      if (!row) {
        throw new Error(`fail: job not found: ${input.id}`);
      }

      const retryable = input.retryable !== false;
      const attemptsRemain = row.attempts < row.max_attempts;

      if (!retryable || !attemptsRemain) {
        this.stmts.moveToDead.run({
          id: input.id,
          error: input.error,
          updated_at: now,
        });
        return this.stmts.getJob.get(input.id) as JobRow;
      }

      let nextRunAt: number;
      if (input.nextRunAt !== undefined) {
        nextRunAt = input.nextRunAt;
      } else {
        const backoff = parseBackoff(row.backoff_json) ?? DEFAULT_BACKOFF;
        nextRunAt = now + computeBackoffMs(backoff, row.attempts);
      }

      const status: JobStatus = nextRunAt > now ? "delayed" : "pending";
      this.stmts.reschedule.run({
        id: input.id,
        status,
        run_at: nextRunAt,
        last_error: input.error,
        updated_at: now,
      });

      return this.stmts.getJob.get(input.id) as JobRow;
    });

    const row = withBusyRetry(() => run());
    return rowToJob(row);
  }

  /**
   * Force a job into `dead` with the given error message.
   */
  moveToDead(id: string, error: string): void {
    this.assertReady();
    const now = Date.now();
    withBusyRetry(() =>
      this.stmts.moveToDead.run({
        id,
        error,
        updated_at: now,
      }),
    );
  }

  /**
   * Promote delayed jobs with `run_at <= now` to `pending` in one statement.
   */
  promoteDelayed(now: number): number {
    this.assertReady();
    const result = withBusyRetry(() => this.stmts.promoteDelayed.run(now, now));
    return result.changes;
  }

  /**
   * Create or replace a repeatable schedule identified by `(queue, key)`.
   */
  upsertRepeatable(
    repeatable: Omit<RepeatableJob, "createdAt" | "updatedAt" | "nextRunAt"> & {
      nextRunAt?: number;
    },
  ): RepeatableJob {
    this.assertReady();
    const now = Date.now();
    withBusyRetry(() => this.upsertRepeatableInTxn(repeatable, now));
    const saved = this.getRepeatable(repeatable.queue, repeatable.key);
    if (!saved) {
      throw new Error(
        `upsertRepeatable: row missing after write (${repeatable.queue}/${repeatable.key})`,
      );
    }
    return saved;
  }

  /**
   * List repeatable schedules, optionally filtered by queue.
   */
  listRepeatables(queue?: string): RepeatableJob[] {
    this.assertReady();
    const rows = withBusyRetry(() => {
      if (queue === undefined) {
        return this.stmts.listRepeatablesAll.all() as RepeatableRow[];
      }
      return this.stmts.listRepeatablesQueue.all(queue) as RepeatableRow[];
    });
    return rows.map(rowToRepeatable);
  }

  /**
   * Refresh heartbeat_at for an active job (stall detection).
   */
  heartbeat(id: string, now: number): void {
    this.assertReady();
    withBusyRetry(() => this.stmts.heartbeat.run(now, now, id));
  }

  /*
   * PROPOSED-CHANGE:
   * What: add Storage.reclaimStale(now, staleAfterMs)
   * Why: workers die mid-job and active rows need reclaim
   * Suggested shape: reclaimStale(now: number, staleAfterMs: number): number
   */

  /**
   * Return active jobs whose heartbeat is older than `staleAfterMs` to
   * `pending`. Attempts are preserved (they were incremented on claim).
   * Returns how many rows were reclaimed.
   */
  reclaimStale(now: number, staleAfterMs: number): number {
    this.assertReady();
    const threshold = now - staleAfterMs;
    const result = withBusyRetry(() => this.stmts.reclaimStale.run(now, threshold));
    return result.changes;
  }

  /**
   * Cancel a job. Pending/delayed become `dead`. Active jobs get
   * `cancel_requested` set for cooperative abort. Returns null if missing.
   */
  cancel(id: string): Job | null {
    this.assertReady();
    const now = Date.now();

    const run = this.db.transaction(() => {
      const row = this.stmts.getJob.get(id) as JobRow | undefined;
      if (!row) return null;

      if (row.status === "pending" || row.status === "delayed") {
        this.stmts.cancelTerminal.run({
          id,
          updated_at: now,
          error: "cancelled",
        });
      } else if (row.status === "active") {
        this.stmts.cancelActive.run({ id, updated_at: now });
      }

      return this.stmts.getJob.get(id) as JobRow;
    });

    const row = withBusyRetry(() => run());
    return row ? rowToJob(row) : null;
  }

  /**
   * Fetch a single job by id, or null.
   */
  getJob(id: string): Job | null {
    this.assertReady();
    const row = withBusyRetry(() => this.stmts.getJob.get(id) as JobRow | undefined);
    return row ? rowToJob(row) : null;
  }

  /**
   * Status histogram for one queue, or all queues when omitted.
   */
  counts(queue?: string): JobCounts {
    this.assertReady();
    const rows = withBusyRetry(() => {
      if (queue === undefined) {
        return this.stmts.countsAll.all() as Array<{ status: JobStatus; n: number }>;
      }
      return this.stmts.countsQueue.all(queue) as Array<{ status: JobStatus; n: number }>;
    });

    const out = emptyCounts();
    for (const row of rows) {
      if (row.status in out) {
        out[row.status] = row.n;
      }
    }
    return out;
  }

  /**
   * Delete terminal jobs (`completed`, `dead`) older than `olderThanMs`
   * relative to `now` (defaults to Date.now()), compared against `updated_at`.
   */
  cleanup(olderThanMs: number, now: number = Date.now()): number {
    this.assertReady();
    const cutoff = now - olderThanMs;
    const result = withBusyRetry(() => this.stmts.cleanup.run(cutoff));
    return result.changes;
  }

  /**
   * Close the database connection. Safe to call more than once.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.prepared = null;
    this.db.close();
  }

  /** Current schema version this build expects. */
  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  /** Prepared statements; throws if {@link init} was not called. */
  private get stmts(): Prepared {
    if (!this.prepared) {
      throw new Error("SqliteStorage.init() must be called before use");
    }
    return this.prepared;
  }

  private getRepeatable(queue: string, key: string): RepeatableJob | null {
    const row = this.stmts.getRepeatable.get(queue, key) as RepeatableRow | undefined;
    return row ? rowToRepeatable(row) : null;
  }

  private upsertRepeatableInTxn(
    repeatable: Omit<RepeatableJob, "createdAt" | "updatedAt" | "nextRunAt"> & {
      nextRunAt?: number;
    },
    now: number = Date.now(),
  ): void {
    this.stmts.upsertRepeatable.run({
      queue: repeatable.queue,
      key: repeatable.key,
      name: repeatable.name,
      cron: repeatable.cron,
      payload: JSON.stringify(repeatable.payload ?? null),
      options_json: JSON.stringify(repeatable.options ?? {}),
      next_run_at: repeatable.nextRunAt ?? null,
      created_at: now,
      updated_at: now,
    });
  }

  private claimStmtForQueues(count: number): Statement {
    const stmts = this.stmts;
    let stmt = stmts.claimByQueueCount.get(count);
    if (!stmt) {
      const placeholders = Array.from({ length: count }, () => "?").join(", ");
      stmt = this.db.prepare(`
        UPDATE jobs
        SET status = 'active',
            attempts = attempts + 1,
            updated_at = ?,
            heartbeat_at = ?,
            cancel_requested = 0
        WHERE id = (
          SELECT id FROM jobs
          WHERE status = 'pending'
            AND run_at <= ?
            AND queue IN (${placeholders})
          ORDER BY priority DESC, run_at ASC, id ASC
          LIMIT 1
        )
        RETURNING *
      `);
      stmts.claimByQueueCount.set(count, stmt);
    }
    return stmt;
  }

  private prepareStatements(): Prepared {
    return {
      insertJob: this.db.prepare(`
        INSERT OR IGNORE INTO jobs (
          id, queue, name, payload, status, priority, attempts, max_attempts,
          run_at, created_at, updated_at, last_error, cron, repeat_key,
          heartbeat_at, backoff_json, result_json, cancel_requested
        ) VALUES (
          @id, @queue, @name, @payload, @status, @priority, @attempts, @max_attempts,
          @run_at, @created_at, @updated_at, @last_error, @cron, @repeat_key,
          @heartbeat_at, @backoff_json, @result_json, @cancel_requested
        )
      `),
      getJob: this.db.prepare("SELECT * FROM jobs WHERE id = ?"),
      complete: this.db.prepare(`
        UPDATE jobs
        SET status = 'completed',
            updated_at = @updated_at,
            result_json = @result_json,
            heartbeat_at = NULL
        WHERE id = @id
      `),
      moveToDead: this.db.prepare(`
        UPDATE jobs
        SET status = 'dead',
            last_error = @error,
            updated_at = @updated_at,
            heartbeat_at = NULL
        WHERE id = @id
      `),
      reschedule: this.db.prepare(`
        UPDATE jobs
        SET status = @status,
            run_at = @run_at,
            last_error = @last_error,
            updated_at = @updated_at,
            heartbeat_at = NULL,
            cancel_requested = 0
        WHERE id = @id
      `),
      promoteDelayed: this.db.prepare(`
        UPDATE jobs
        SET status = 'pending', updated_at = ?
        WHERE status = 'delayed' AND run_at <= ?
      `),
      heartbeat: this.db.prepare(`
        UPDATE jobs
        SET heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `),
      reclaimStale: this.db.prepare(`
        UPDATE jobs
        SET status = 'pending',
            updated_at = ?,
            heartbeat_at = NULL,
            cancel_requested = 0
        WHERE status = 'active'
          AND heartbeat_at IS NOT NULL
          AND heartbeat_at < ?
      `),
      cancelTerminal: this.db.prepare(`
        UPDATE jobs
        SET status = 'dead',
            last_error = @error,
            updated_at = @updated_at,
            heartbeat_at = NULL
        WHERE id = @id
      `),
      cancelActive: this.db.prepare(`
        UPDATE jobs
        SET cancel_requested = 1,
            updated_at = @updated_at
        WHERE id = @id AND status = 'active'
      `),
      countsAll: this.db.prepare(`
        SELECT status, COUNT(*) AS n FROM jobs GROUP BY status
      `),
      countsQueue: this.db.prepare(`
        SELECT status, COUNT(*) AS n FROM jobs WHERE queue = ? GROUP BY status
      `),
      cleanup: this.db.prepare(`
        DELETE FROM jobs
        WHERE status IN ('completed', 'dead') AND updated_at < ?
      `),
      upsertRepeatable: this.db.prepare(`
        INSERT INTO repeatables (
          queue, key, name, cron, payload, options_json,
          next_run_at, created_at, updated_at
        ) VALUES (
          @queue, @key, @name, @cron, @payload, @options_json,
          @next_run_at, @created_at, @updated_at
        )
        ON CONFLICT(queue, key) DO UPDATE SET
          name = excluded.name,
          cron = excluded.cron,
          payload = excluded.payload,
          options_json = excluded.options_json,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at
      `),
      getRepeatable: this.db.prepare(`
        SELECT * FROM repeatables WHERE queue = ? AND key = ?
      `),
      listRepeatablesAll: this.db.prepare(`
        SELECT * FROM repeatables ORDER BY queue, key
      `),
      listRepeatablesQueue: this.db.prepare(`
        SELECT * FROM repeatables WHERE queue = ? ORDER BY key
      `),
      claimAll: this.db.prepare(`
        UPDATE jobs
        SET status = 'active',
            attempts = attempts + 1,
            updated_at = ?,
            heartbeat_at = ?,
            cancel_requested = 0
        WHERE id = (
          SELECT id FROM jobs
          WHERE status = 'pending'
            AND run_at <= ?
          ORDER BY priority DESC, run_at ASC, id ASC
          LIMIT 1
        )
        RETURNING *
      `),
      claimByQueueCount: new Map(),
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteStorage is closed");
    }
  }

  private assertReady(): void {
    this.assertOpen();
    if (!this.prepared) {
      throw new Error("SqliteStorage.init() must be called before use");
    }
  }
}

function parseBackoff(json: string | null): BackoffOptions | null {
  if (json == null) return null;
  try {
    return JSON.parse(json) as BackoffOptions;
  } catch {
    return null;
  }
}

function omitRepeatFields(
  options: EnqueueOptions,
): Omit<EnqueueOptions, "repeat" | "delayMs" | "runAt" | "jobId"> {
  const out: Omit<EnqueueOptions, "repeat" | "delayMs" | "runAt" | "jobId"> = {};
  if (options.priority !== undefined) out.priority = options.priority;
  if (options.maxAttempts !== undefined) out.maxAttempts = options.maxAttempts;
  if (options.backoff !== undefined) out.backoff = options.backoff;
  return out;
}
