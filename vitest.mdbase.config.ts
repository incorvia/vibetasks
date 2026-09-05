import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/mdbaseCompatibility.test.ts"],
    pool: "forks",
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
    },
  },
});
