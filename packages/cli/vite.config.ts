import { defineConfig } from "vite-plus";
import { ownerProjects, sharedTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  test: {
    ...sharedTestConfig,
    projects: ownerProjects(),
  },
});
