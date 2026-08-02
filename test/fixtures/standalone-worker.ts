/**
 * Minimal dedicated-worker script for the keep-alive integration test.
 *
 * Args: <databasePath> <markerPath>
 * Enqueues a delayed job, starts a worker, writes the marker when the job
 * runs, then stops and closes. Relies on WorkerRuntime to keep the process
 * alive; this file must not install its own ref'd timers after start().
 */

import { writeFile } from "node:fs/promises";
import { Vardiya } from "../../src/vardiya.js";

const databasePath = process.argv[2];
const markerPath = process.argv[3];

if (!databasePath || !markerPath) {
  console.error("usage: standalone-worker <databasePath> <markerPath>");
  process.exit(2);
}

const v = new Vardiya({ databasePath });
await v.init();

await v.enqueue(
  "ping",
  { ok: true },
  {
    queue: "standalone",
    delayMs: 400,
  },
);

const worker = v.createWorker({
  concurrency: 1,
  pollIntervalMs: 50,
  queues: ["standalone"],
});

worker.process("ping", async (job) => {
  await writeFile(markerPath, JSON.stringify({ id: job.id, ok: true }), "utf8");
  return "done";
});

worker.on("job:completed", () => {
  void (async () => {
    try {
      await worker.stop();
      await v.close();
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
  })();
});

worker.on("error", (err) => {
  console.error(err);
  process.exitCode = 1;
});

await worker.start();
