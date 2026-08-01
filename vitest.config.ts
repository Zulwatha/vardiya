import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Normalize root so Windows lowercase drive letters do not break suite discovery.
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    // better-sqlite3 is a native addon. Forks avoid tinypool thread IPC issues
    // with the threads pool.
    pool: "forks",
    poolOptions: {
      forks: {
        // Serialize forks so teardown cannot race IPC against a sibling
        // worker. Keep singleFork false so each file still gets a fresh
        // process (native module + SQLite handle isolation).
        singleFork: false,
        maxForks: 1,
      },
    },
    // Give torture / dual-worker suites and fork exit room.
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
