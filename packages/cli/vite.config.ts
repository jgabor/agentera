import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/packaging/**"],
    globalSetup: ["./test/sourceSetup.ts"],
    ...sharedTestConfig,
  },
});
