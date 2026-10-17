import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
