/**
 * Minimal enqueue + worker example.
 *
 * Run: npx tsx examples/basic.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vardiya } from "../src/vardiya.js";

const dir = mkdtempSync(join(tmpdir(), "vardiya-example-basic-"));
const databasePath = join(dir, "jobs.sqlite");

const v = new Vardiya({ databasePath });
await v.init();

v.on("job:completed", (job, result) => {
  console.log(`completed ${job.name} id=${job.id} result=${JSON.stringify(result)}`);
});

await v.enqueue("email", { to: "a@b.com" });
await v.enqueue("email", { to: "c@d.com" }, { priority: 10 });

const worker = v.createWorker({ concurrency: 2, pollIntervalMs: 50 });
worker.process("email", async (job) => {
  console.log(`sending email to ${(job.payload as { to: string }).to}`);
  return { sent: true };
});
await worker.start();

// Wait until both jobs finish.
while (true) {
  const counts = await v.counts();
  if (counts.completed >= 2 && counts.active === 0 && counts.pending === 0) {
    break;
  }
  await new Promise((r) => setTimeout(r, 20));
}

await v.close();
rmSync(dir, { recursive: true, force: true });
console.log("basic example done");
