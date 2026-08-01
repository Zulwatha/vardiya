/**
 * Throughput bench for vardiya.
 *
 * Measures enqueue/sec and end-to-end process/sec at concurrency 1 / 8 / 32
 * on a temp-file SQLite database. Prints a markdown table to stdout.
 *
 * Run: `npm run bench` (vite-node) or `npx vite-node bench/bench.ts`
 *
 * No external bench libraries. Numbers vary by disk and CPU; treat them as
 * ballpark, not a marketing claim.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { WorkerRuntime } from "../src/worker/worker.js";

const ENQUEUE_N = 20_000;
const E2E_N = 10_000;
const CONCURRENCIES = [1, 8, 32] as const;

function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vardiya-bench-"));
  return {
    path: join(dir, "bench.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

async function measureEnqueue(path: string, n: number): Promise<number> {
  const storage = new SqliteStorage(path);
  storage.init();
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    storage.enqueue({
      queue: "bench",
      name: "noop",
      payload: { i },
      options: { jobId: `enq-${i}` },
    });
  }
  const elapsed = (performance.now() - start) / 1000;
  storage.close();
  return n / elapsed;
}

async function measureE2E(path: string, n: number, concurrency: number): Promise<number> {
  const storage = new SqliteStorage(path);
  storage.init();

  for (let i = 0; i < n; i++) {
    storage.enqueue({
      queue: "bench",
      name: "noop",
      payload: { i },
      options: {
        jobId: `e2e-${concurrency}-${i}`,
        maxAttempts: 1,
      },
    });
  }

  const worker = new WorkerRuntime(storage, {
    concurrency,
    pollIntervalMs: 50,
    minPollIntervalMs: 1,
    drainTimeoutMs: 60_000,
    heartbeatIntervalMs: 1_000,
    queues: ["bench"],
  });
  worker.process("noop", async () => undefined);

  const start = performance.now();
  await worker.start();

  while (true) {
    const counts = storage.counts("bench");
    if (counts.completed >= n && counts.active === 0 && counts.pending === 0) {
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }

  const elapsed = (performance.now() - start) / 1000;
  await worker.stop();
  storage.close();
  return n / elapsed;
}

async function main(): Promise<void> {
  const tmp = tempDbPath();
  try {
    const enqueueJobsPerSec = await measureEnqueue(tmp.path, ENQUEUE_N);

    const e2eRows: Array<{ concurrency: number; jobsPerSec: number }> = [];
    for (const concurrency of CONCURRENCIES) {
      // Fresh file per concurrency so leftover rows do not skew the run.
      const run = tempDbPath();
      try {
        const jobsPerSec = await measureE2E(run.path, E2E_N, concurrency);
        e2eRows.push({ concurrency, jobsPerSec });
      } finally {
        run.cleanup();
      }
    }

    const lines = [
      "| Metric | Result |",
      "| --- | --- |",
      `| Enqueue throughput | ${fmt(enqueueJobsPerSec)} jobs/sec |`,
      ...e2eRows.map(
        (row) =>
          `| Process throughput (concurrency=${row.concurrency}) | ${fmt(row.jobsPerSec)} jobs/sec |`,
      ),
      "",
      `_Measured on this machine with ${ENQUEUE_N.toLocaleString("en-US")} enqueue ops`,
      `and ${E2E_N.toLocaleString("en-US")} end-to-end jobs on a temp-file SQLite DB._`,
    ];

    console.log(lines.join("\n"));
  } finally {
    tmp.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
