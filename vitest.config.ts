import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Normalize root so Windows lowercase drive letters do not break suite discovery.
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
