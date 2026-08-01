import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceLoop, repeatOccurrenceJobId } from "../../src/scheduler/scheduler.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { createTempDbPath } from "../helpers/temp-db.js";

function openMemory(): SqliteStorage {
  const storage = new SqliteStorage(":memory:");
  storage.init();
  return storage;
}

function openFile(path: string): SqliteStorage {
  const storage = new SqliteStorage(path);
  storage.init();
  return storage;
}

describe("SqliteStorage integration", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  describe("enqueue / claim / complete happy path", () => {
    it("works on :memory:", () => {
      const storage = openMemory();
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "default",
        name: "ping",
        payload: { n: 1 },
      });
      expect(job.status).toBe("pending");
      expect(job.payload).toEqual({ n: 1 });

      const claimed = storage.claimNext(["default"], Date.now());
      expect(claimed).not.toBeNull();
      if (!claimed) throw new Error("expected a claimed job");
      expect(claimed.job.id).toBe(job.id);
      expect(claimed.job.status).toBe("active");
      expect(claimed.job.attempts).toBe(1);

      storage.complete(claimed.job.id, { ok: true });
      const done = storage.getJob(job.id);
      expect(done?.status).toBe("completed");
      expect(storage.counts("default")).toMatchObject({
        pending: 0,
        active: 0,
        completed: 1,
      });
    });

    it("works on a temp file", () => {
      const tmp = createTempDbPath();
      cleanups.push(tmp.cleanup);

      const storage = openFile(tmp.path);
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "file-q",
        name: "work",
        payload: "x",
      });
      const claimed = storage.claimNext(["file-q"], Date.now());
      expect(claimed?.job.id).toBe(job.id);
      storage.complete(job.id);
      expect(storage.getJob(job.id)?.status).toBe("completed");
    });
  });

  describe("retry with exponential backoff", () => {
    it("schedules delays as delayMs * 2^(attempt - 1)", () => {
      vi.useFakeTimers();
      const t0 = new Date("2024-06-01T12:00:00.000Z").getTime();
      vi.setSystemTime(t0);

      const storage = openMemory();
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "retry",
        name: "flaky",
        payload: {},
        options: {
          maxAttempts: 3,
          backoff: { type: "exponential", delayMs: 1000, jitter: false },
        },
      });

      const c1 = storage.claimNext(["retry"], Date.now());
      expect(c1?.job.attempts).toBe(1);
      const f1 = storage.fail({ id: job.id, error: "fail-1", retryable: true });
      expect(f1.status).toBe("delayed");
      expect(f1.runAt).toBe(t0 + 1000);
      expect(f1.lastError).toBe("fail-1");

      vi.setSystemTime(t0 + 999);
      expect(storage.promoteDelayed(Date.now())).toBe(0);
      vi.setSystemTime(t0 + 1000);
      expect(storage.promoteDelayed(Date.now())).toBe(1);

      const c2 = storage.claimNext(["retry"], Date.now());
      expect(c2?.job.attempts).toBe(2);
      const f2 = storage.fail({ id: job.id, error: "fail-2", retryable: true });
      expect(f2.status).toBe("delayed");
      expect(f2.runAt).toBe(t0 + 1000 + 2000);

      vi.setSystemTime(f2.runAt);
      expect(storage.promoteDelayed(Date.now())).toBe(1);
      const c3 = storage.claimNext(["retry"], Date.now());
      expect(c3?.job.attempts).toBe(3);
      const dead = storage.fail({ id: job.id, error: "fail-3", retryable: true });
      expect(dead.status).toBe("dead");
    });
  });

  describe("dead letter after maxAttempts", () => {
    it("moves to dead when attempts are exhausted", () => {
      const storage = openMemory();
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "dlq",
        name: "once",
        payload: {},
        options: { maxAttempts: 1 },
      });
      expect(storage.claimNext(["dlq"], Date.now())).not.toBeNull();
      const dead = storage.fail({ id: job.id, error: "boom", retryable: true });
      expect(dead.status).toBe("dead");
      expect(dead.lastError).toBe("boom");
      expect(storage.claimNext(["dlq"], Date.now())).toBeNull();
    });

    it("moves to dead when retryable is false", () => {
      const storage = openMemory();
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "dlq",
        name: "hard",
        payload: {},
        options: { maxAttempts: 5 },
      });
      storage.claimNext(["dlq"], Date.now());
      const dead = storage.fail({ id: job.id, error: "fatal", retryable: false });
      expect(dead.status).toBe("dead");
    });
  });

  describe("delayed job promotion", () => {
    it("keeps future jobs unclaimable until promoteDelayed", () => {
      vi.useFakeTimers();
      const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
      vi.setSystemTime(t0);

      const storage = openMemory();
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "delay",
        name: "later",
        payload: {},
        options: { delayMs: 5_000 },
      });
      expect(job.status).toBe("delayed");
      expect(storage.claimNext(["delay"], Date.now())).toBeNull();

      vi.setSystemTime(t0 + 4_999);
      expect(storage.promoteDelayed(Date.now())).toBe(0);
      expect(storage.claimNext(["delay"], Date.now())).toBeNull();

      vi.setSystemTime(t0 + 5_000);
      expect(storage.promoteDelayed(Date.now())).toBe(1);
      const claimed = storage.claimNext(["delay"], Date.now());
      expect(claimed?.job.id).toBe(job.id);
    });
  });

  describe("priority ordering", () => {
    it("claims higher priority first", () => {
      const storage = openMemory();
      cleanups.push(() => storage.close());
      const now = Date.now();

      const low = storage.enqueue({
        queue: "prio",
        name: "n",
        payload: "low",
        options: { priority: 1 },
      });
      const high = storage.enqueue({
        queue: "prio",
        name: "n",
        payload: "high",
        options: { priority: 10 },
      });
      const mid = storage.enqueue({
        queue: "prio",
        name: "n",
        payload: "mid",
        options: { priority: 5 },
      });

      expect(storage.claimNext(["prio"], now)?.job.id).toBe(high.id);
      expect(storage.claimNext(["prio"], now)?.job.id).toBe(mid.id);
      expect(storage.claimNext(["prio"], now)?.job.id).toBe(low.id);
    });
  });

  describe("jobId dedup", () => {
    it("returns the existing job and does not insert a second row", () => {
      const storage = openMemory();
      cleanups.push(() => storage.close());

      const a = storage.enqueue({
        queue: "dedup",
        name: "n",
        payload: { v: 1 },
        options: { jobId: "same-id" },
      });
      const b = storage.enqueue({
        queue: "dedup",
        name: "n",
        payload: { v: 2 },
        options: { jobId: "same-id" },
      });

      expect(b.id).toBe(a.id);
      expect(b.payload).toEqual({ v: 1 });
      expect(storage.counts("dedup").pending).toBe(1);
    });
  });

  describe("stalled-job recovery", () => {
    it("reclaims active jobs with a stale heartbeat", () => {
      vi.useFakeTimers();
      const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
      vi.setSystemTime(t0);

      const storage = openMemory();
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "stall",
        name: "n",
        payload: {},
        options: { maxAttempts: 3 },
      });
      const claimed = storage.claimNext(["stall"], Date.now());
      expect(claimed).not.toBeNull();
      // Heartbeat at claim time is t0. After 30s without refresh, reclaim.
      vi.setSystemTime(t0 + 30_001);
      expect(storage.reclaimStale(Date.now(), 30_000)).toBe(1);

      const again = storage.getJob(job.id);
      expect(again?.status).toBe("pending");
      expect(again?.attempts).toBe(1);

      const reclaimed = storage.claimNext(["stall"], Date.now());
      expect(reclaimed?.job.id).toBe(job.id);
      expect(reclaimed?.job.attempts).toBe(2);
    });
  });

  describe("release", () => {
    it("returns an active job to pending without burning an attempt", () => {
      const storage = openMemory();
      cleanups.push(() => storage.close());

      const job = storage.enqueue({
        queue: "rel",
        name: "n",
        payload: {},
        options: { maxAttempts: 3 },
      });
      expect(storage.claimNext(["rel"], Date.now())?.job.attempts).toBe(1);

      const released = storage.release(job.id);
      expect(released.status).toBe("pending");
      expect(released.attempts).toBe(0);
      expect(released.lastError).toBeUndefined();

      const again = storage.claimNext(["rel"], Date.now());
      expect(again?.job.id).toBe(job.id);
      expect(again?.job.attempts).toBe(1);
    });
  });

  describe("repeatable materialization idempotency", () => {
    it("does not create duplicate jobs for the same occurrence", async () => {
      vi.useFakeTimers();
      const t0 = Date.UTC(2024, 0, 1, 12, 0, 0);
      vi.setSystemTime(t0);

      const storage = openMemory();
      cleanups.push(() => storage.close());

      storage.upsertRepeatable({
        queue: "cron-q",
        name: "tick",
        cron: "0 * * * *",
        key: "hourly",
        payload: { kind: "tick" },
        options: {},
        nextRunAt: t0,
      });

      const loop = new MaintenanceLoop(storage, {
        now: () => Date.now(),
        stalledTimeoutMs: 60_000,
      });

      const r1 = await loop.tick();
      expect(r1.materialized).toBeGreaterThanOrEqual(1);
      const countsAfterFirst = storage.counts("cron-q");
      const totalAfterFirst =
        countsAfterFirst.pending +
        countsAfterFirst.delayed +
        countsAfterFirst.active +
        countsAfterFirst.completed;

      const r2 = await loop.tick();
      expect(r2.materialized).toBe(0);
      const countsAfterSecond = storage.counts("cron-q");
      const totalAfterSecond =
        countsAfterSecond.pending +
        countsAfterSecond.delayed +
        countsAfterSecond.active +
        countsAfterSecond.completed;
      expect(totalAfterSecond).toBe(totalAfterFirst);

      const expectedId = repeatOccurrenceJobId("cron-q", "hourly", t0);
      expect(storage.getJob(expectedId)).not.toBeNull();
    });
  });
});
