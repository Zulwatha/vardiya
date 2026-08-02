import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_V1_SQL } from "../../src/storage/schema.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { runCleanups } from "../helpers/cleanup.js";
import { createTempDbPath } from "../helpers/temp-db.js";

/** Collapse whitespace so CREATE SQL from sqlite_master compares stably. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function schemaSnapshot(path: string): Map<string, string> {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(`${row.type}:${row.name}`, normalizeSql(row.sql));
    }
    return map;
  } finally {
    db.close();
  }
}

function buildSchemaV1Database(path: string): {
  pendingId: string;
  userJobId: string;
  expected: Array<{
    id: string;
    status: string;
    attempts: number;
    run_at: number;
    payload: string;
  }>;
} {
  const db = new Database(path);
  try {
    db.exec(SCHEMA_V1_SQL);
    db.pragma("user_version = 1");
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run({ key: "schema_version", value: "1" });

    const now = Date.UTC(2024, 5, 1, 12, 0, 0);
    const future = now + 3_600_000;

    const insert = db.prepare(`
      INSERT INTO jobs (
        id, queue, name, payload, status, priority, attempts, max_attempts,
        run_at, created_at, updated_at, last_error, cron, repeat_key,
        heartbeat_at, backoff_json, result_json, cancel_requested
      ) VALUES (
        @id, @queue, @name, @payload, @status, @priority, @attempts, @max_attempts,
        @run_at, @created_at, @updated_at, @last_error, @cron, @repeat_key,
        @heartbeat_at, @backoff_json, @result_json, @cancel_requested
      )
    `);

    const rows = [
      {
        id: "job-pending",
        queue: "mig",
        name: "work",
        payload: JSON.stringify({ kind: "pending" }),
        status: "pending",
        priority: 0,
        attempts: 0,
        max_attempts: 3,
        run_at: now,
        created_at: now,
        updated_at: now,
        last_error: null,
        cron: null,
        repeat_key: null,
        heartbeat_at: null,
        backoff_json: null,
        result_json: null,
        cancel_requested: 0,
      },
      {
        id: "job-active",
        queue: "mig",
        name: "work",
        payload: JSON.stringify({ kind: "active" }),
        status: "active",
        priority: 0,
        attempts: 1,
        max_attempts: 3,
        run_at: now,
        created_at: now,
        updated_at: now,
        last_error: null,
        cron: null,
        repeat_key: null,
        heartbeat_at: now,
        backoff_json: null,
        result_json: null,
        cancel_requested: 0,
      },
      {
        id: "job-delayed",
        queue: "mig",
        name: "work",
        payload: JSON.stringify({ kind: "delayed" }),
        status: "delayed",
        priority: 0,
        attempts: 0,
        max_attempts: 2,
        run_at: future,
        created_at: now,
        updated_at: now,
        last_error: null,
        cron: null,
        repeat_key: null,
        heartbeat_at: null,
        backoff_json: null,
        result_json: null,
        cancel_requested: 0,
      },
      {
        id: "job-completed",
        queue: "mig",
        name: "work",
        payload: JSON.stringify({ kind: "completed" }),
        status: "completed",
        priority: 0,
        attempts: 1,
        max_attempts: 1,
        run_at: now,
        created_at: now,
        updated_at: now,
        last_error: null,
        cron: null,
        repeat_key: null,
        heartbeat_at: null,
        backoff_json: null,
        result_json: JSON.stringify({ ok: true }),
        cancel_requested: 0,
      },
      {
        id: "job-dead",
        queue: "mig",
        name: "work",
        payload: JSON.stringify({ kind: "dead" }),
        status: "dead",
        priority: 0,
        attempts: 2,
        max_attempts: 2,
        run_at: now,
        created_at: now,
        updated_at: now,
        last_error: "boom",
        cron: null,
        repeat_key: null,
        heartbeat_at: null,
        backoff_json: null,
        result_json: null,
        cancel_requested: 0,
      },
      {
        // Old-style user-supplied id (was both PK and jobId).
        id: "user-supplied-job-id",
        queue: "mig",
        name: "work",
        payload: JSON.stringify({ kind: "user-jobId" }),
        status: "pending",
        priority: 0,
        attempts: 0,
        max_attempts: 1,
        run_at: now + 1,
        created_at: now,
        updated_at: now,
        last_error: null,
        cron: null,
        repeat_key: null,
        heartbeat_at: null,
        backoff_json: null,
        result_json: null,
        cancel_requested: 0,
      },
    ] as const;

    for (const row of rows) {
      insert.run(row);
    }

    db.prepare(`
      INSERT INTO repeatables (
        queue, key, name, cron, payload, options_json,
        next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "mig",
      "hourly",
      "tick",
      "0 * * * *",
      JSON.stringify({ cron: true }),
      JSON.stringify({}),
      future,
      now,
      now,
    );

    return {
      pendingId: "job-pending",
      userJobId: "user-supplied-job-id",
      expected: rows.map((r) => ({
        id: r.id,
        status: r.status,
        attempts: r.attempts,
        run_at: r.run_at,
        payload: r.payload,
      })),
    };
  } finally {
    db.close();
  }
}

describe("schema v1 -> v2 migration", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    await runCleanups(cleanups);
  });

  it("migrates a real v1 database and preserves rows, indexes, and claim", () => {
    const tmp = createTempDbPath("vardiya-mig-v1-");
    cleanups.push(tmp.cleanup);

    const built = buildSchemaV1Database(tmp.path);

    const rawBefore = new Database(tmp.path, { readonly: true });
    expect(Number(rawBefore.pragma("user_version", { simple: true }))).toBe(1);
    rawBefore.close();

    const storage = new SqliteStorage(tmp.path);
    storage.init();
    cleanups.push(() => storage.close());

    const db = new Database(tmp.path, { readonly: true });
    cleanups.push(() => {
      db.close();
    });

    expect(Number(db.pragma("user_version", { simple: true }))).toBe(2);
    expect(storage.schemaVersion).toBe(2);

    for (const expected of built.expected) {
      const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(expected.id) as
        | {
            id: string;
            status: string;
            attempts: number;
            run_at: number;
            payload: string;
            dedup_key: string | null;
          }
        | undefined;
      expect(row).toBeDefined();
      if (!row) throw new Error(`missing job ${expected.id}`);
      expect(row.status).toBe(expected.status);
      expect(row.attempts).toBe(expected.attempts);
      expect(row.run_at).toBe(expected.run_at);
      expect(row.payload).toBe(expected.payload);
      // Migration copies id into dedup_key so old jobIds keep working.
      expect(row.dedup_key).toBe(expected.id);
    }

    const userJob = storage.getJob(built.userJobId);
    expect(userJob?.dedupKey).toBe(built.userJobId);
    expect(userJob?.status).toBe("pending");

    const repeatables = storage.listRepeatables("mig");
    expect(repeatables).toHaveLength(1);
    expect(repeatables[0]?.key).toBe("hourly");
    expect(repeatables[0]?.cron).toBe("0 * * * *");

    expect(storage.counts("mig")).toEqual({
      pending: 2,
      active: 1,
      completed: 1,
      delayed: 1,
      dead: 1,
    });

    const indexNames = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name IN (
             'idx_jobs_claim', 'idx_jobs_promote', 'idx_jobs_stale', 'idx_jobs_cleanup'
           )
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexNames).toEqual([
      "idx_jobs_claim",
      "idx_jobs_cleanup",
      "idx_jobs_promote",
      "idx_jobs_stale",
    ]);

    // claimNext should pick the pending row with earlier run_at / lower priority tie-break.
    const claimed = storage.claimNext(["mig"], Date.UTC(2024, 5, 1, 12, 0, 0));
    expect(claimed?.job.id).toBe(built.pendingId);
    expect(claimed?.job.status).toBe("active");
  });

  it("fresh and migrated databases share the same schema objects", () => {
    const migratedTmp = createTempDbPath("vardiya-mig-cmp-");
    const freshTmp = createTempDbPath("vardiya-fresh-cmp-");
    cleanups.push(migratedTmp.cleanup, freshTmp.cleanup);

    buildSchemaV1Database(migratedTmp.path);
    const migrated = new SqliteStorage(migratedTmp.path);
    migrated.init();
    cleanups.push(() => migrated.close());

    const fresh = new SqliteStorage(freshTmp.path);
    fresh.init();
    cleanups.push(() => fresh.close());

    const migratedDb = new Database(migratedTmp.path, { readonly: true });
    const freshDb = new Database(freshTmp.path, { readonly: true });
    cleanups.push(
      () => {
        migratedDb.close();
      },
      () => {
        freshDb.close();
      },
    );

    expect(Number(migratedDb.pragma("user_version", { simple: true }))).toBe(2);
    expect(Number(freshDb.pragma("user_version", { simple: true }))).toBe(2);

    const migratedSchema = schemaSnapshot(migratedTmp.path);
    const freshSchema = schemaSnapshot(freshTmp.path);

    expect([...migratedSchema.keys()].sort()).toEqual([...freshSchema.keys()].sort());
    for (const [key, sql] of migratedSchema) {
      expect(freshSchema.get(key)).toBe(sql);
    }

    // New dedup index is present on both.
    expect(migratedSchema.has("index:idx_jobs_dedup")).toBe(true);
    expect(freshSchema.has("index:idx_jobs_dedup")).toBe(true);
  });
});
