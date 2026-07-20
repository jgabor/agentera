import { defineConfig } from "vite-plus";

import { sharedTestConfig } from "./vitest.shared.js";

export default defineConfig({
  test: {
    include: ["test/packaging/*.test.ts"],
    globalSetup: ["./test/packaging/packageSetup.ts"],
    ...sharedTestConfig,
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
