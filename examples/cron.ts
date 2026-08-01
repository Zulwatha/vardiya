/**
 * Repeatable cron schedule example against the built package.
 *
 * Run: npm run build && npx tsx examples/cron.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vardiya } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "vardiya-example-cron-"));
const databasePath = join(dir, "jobs.sqlite");

const v = new Vardiya({ databasePath });
await v.init();

const repeatable = await v.upsertRepeatable({
  name: "report",
  cron: "0 9 * * MON-FRI",
  key: "weekday-report",
  payload: { type: "daily" },
});
console.log(
  `registered repeatable key=${repeatable.key} cron=${repeatable.cron} nextRunAt=${repeatable.nextRunAt}`,
);

const listed = await v.listRepeatables();
console.log(`listRepeatables count=${listed.length}`);

// Eager first run so the example does not wait for the next weekday 09:00.
await v.enqueue("report", { type: "daily", reason: "eager-demo" });

const worker = v.createWorker({ concurrency: 1, pollIntervalMs: 50 });
worker.process("report", async (job) => {
  console.log(`ran report payload=${JSON.stringify(job.payload)}`);
  return { ok: true };
});
await worker.start();

while (true) {
  const counts = await v.counts();
  if (counts.completed >= 1 && counts.active === 0 && counts.pending === 0) {
    break;
  }
  await new Promise((r) => setTimeout(r, 20));
}

await v.close();
rmSync(dir, { recursive: true, force: true });
console.log("cron example done");
