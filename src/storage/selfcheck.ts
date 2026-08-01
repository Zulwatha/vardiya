/**
 * Concurrency self-check for SqliteStorage.claimNext.
 *
 * Not part of the public package export. Run with:
 *   npx tsx src/storage/selfcheck.ts
 *
 * Enqueues 10k jobs, claims them from 8 Promise-interleaved worker loops,
 * asserts zero double-claims and zero lost jobs, prints jobs/sec.
 */

import { SqliteStorage } from "./sqlite.js";

const JOB_COUNT = 10_000;
const WORKERS = 8;

async function main(): Promise<void> {
  const storage = new SqliteStorage(":memory:");
  storage.init();

  const queue = "selfcheck";

  for (let i = 0; i < JOB_COUNT; i++) {
    storage.enqueue({
      queue,
      name: "work",
      payload: { i },
      options: { jobId: `job-${i}`, priority: i % 10 },
    });
  }

  const pending = storage.counts(queue).pending;
  if (pending !== JOB_COUNT) {
    throw new Error(`expected ${JOB_COUNT} pending after enqueue, got ${pending}`);
  }

  const claimedIds: string[] = [];
  const seen = new Set<string>();
  let doubleClaims = 0;

  const t0 = performance.now();

  async function workerLoop(): Promise<void> {
    for (;;) {
      const claimed = storage.claimNext([queue], Date.now());
      if (!claimed) return;

      const id = claimed.job.id;
      if (seen.has(id)) {
        doubleClaims += 1;
      } else {
        seen.add(id);
      }
      claimedIds.push(id);

      // Yield so the 8 loops actually interleave on the event loop.
      await Promise.resolve();
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => workerLoop()));

  const elapsedMs = performance.now() - t0;
  const jobsPerSec = Math.round((claimedIds.length / elapsedMs) * 1000);

  const remaining = storage.counts(queue).pending;
  const active = storage.counts(queue).active;

  storage.close();

  const lost = JOB_COUNT - seen.size;
  const ok = doubleClaims === 0 && lost === 0 && remaining === 0 && active === JOB_COUNT;

  console.log(
    JSON.stringify(
      {
        enqueued: JOB_COUNT,
        workers: WORKERS,
        claimed: claimedIds.length,
        unique: seen.size,
        doubleClaims,
        lost,
        remainingPending: remaining,
        active,
        elapsedMs: Math.round(elapsedMs),
        jobsPerSec,
        ok,
      },
      null,
      2,
    ),
  );

  if (!ok) {
    throw new Error(
      `selfcheck failed: doubleClaims=${doubleClaims} lost=${lost} remaining=${remaining} active=${active}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
