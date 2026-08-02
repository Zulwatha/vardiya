import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanups } from "../helpers/cleanup.js";
import { createTempDbPath } from "../helpers/temp-db.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/standalone-worker.ts");

describe("standalone worker process keep-alive", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    await runCleanups(cleanups);
  });

  it("stays alive long enough to process a delayed job, then exits after stop", async () => {
    const tmp = createTempDbPath("vardiya-standalone-");
    cleanups.push(tmp.cleanup);
    const markerPath = join(tmp.dir, "processed.json");

    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, tmp.path, markerPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve(code);
      });
    });

    const elapsed = Date.now() - startedAt;

    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    // Delayed 400ms; an empty-loop exit would finish in tens of ms.
    expect(elapsed).toBeGreaterThanOrEqual(350);

    await access(markerPath);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { ok: boolean };
    expect(marker.ok).toBe(true);
  }, 15_000);
});
