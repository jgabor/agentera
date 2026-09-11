import { defineConfig } from "vite-plus";

import { ownerProjects, sharedTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  test: {
    ...sharedTestConfig,
    maxWorkers: 1,
    testTimeout: 120_000,
    projects: ownerProjects("package"),
  },
});
