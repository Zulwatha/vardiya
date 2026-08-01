import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Normalize root so Windows lowercase drive letters do not break suite discovery.
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    // better-sqlite3 is a native addon. Forks avoid tinypool thread IPC issues
    // (ERR_IPC_CHANNEL_CLOSED) seen on Node 20 with the threads pool.
    pool: "forks",
    poolOptions: {
      forks: {
        // One file per fork keeps native module state isolated and lets each
        // worker process exit after its afterEach cleanup closes DB handles.
        singleFork: false,
      },
    },
    // Give torture / dual-worker suites room; per-test timeouts still apply.
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
