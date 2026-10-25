import { defineConfig } from "vite-plus";

import { ownerProjects, packageWorkersFor, sharedTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  test: {
    ...sharedTestConfig,
    maxWorkers: packageWorkersFor(),
    testTimeout: 120_000,
    projects: ownerProjects("package"),
  },
});
