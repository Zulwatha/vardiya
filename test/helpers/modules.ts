import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** True when a file under `src/` exists (agents may still be landing code). */
export function srcFile(...parts: string[]): boolean {
  return existsSync(join(repoRoot, "src", ...parts));
}

export const hasCron = srcFile("scheduler", "cron.ts");
export const hasSqlite = srcFile("storage", "sqlite.ts");
export const hasSemaphore = srcFile("worker", "semaphore.ts");
export const hasWorkerRuntime = srcFile("worker", "worker.ts");
export const hasMaintenanceLoop = srcFile("scheduler", "scheduler.ts");

/** Backoff math is exported from SqliteStorage's module today. */
export const hasBackoff = hasSqlite;
