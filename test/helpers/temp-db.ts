import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temp directory + sqlite path for file-backed integration tests.
 * Call `cleanup()` in afterEach / afterAll.
 */
export function createTempDbPath(prefix = "vardiya-"): {
  dir: string;
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    path: join(dir, "jobs.sqlite"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
