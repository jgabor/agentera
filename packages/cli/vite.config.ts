import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  // Vite+ reads this for lint/fmt/check; `vp test` reads the test block below.
  // The CLI uses scripts/precommit-vitest.sh for pre-commit (no `staged` block
  // here — that's a web/mobile concern). Lint findings captured at task-3
  // cutover live in `.lint-baseline.txt`; non-regression is the gate, not
  // zero-findings (pre-existing cleanup is a deferred [chore:3.0.0]).
  lint: {
    ignorePatterns: ["dist/**", "bundle/**", "node_modules/**", "**/*.generated.*"],
  },
  fmt: {
    ignorePatterns: ["dist/**", "bundle/**", "node_modules/**", "**/*.generated.*"],
  },
  test: {
    include:
      process.env.AGENTERA_PERFORMANCE_OUTPUT_FIXTURE === "1"
        ? ["test/fixtures/performanceOwnerOutput.fixture.ts"]
        : ["test/**/*.test.ts"],
    exclude: ["test/packaging/**"],
    globalSetup: ["./test/sourceSetup.ts"],
    ...sharedTestConfig,
  },
});
