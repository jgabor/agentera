import { defineConfig } from "vite-plus";
import { ownerProjects, sharedTestConfig } from "./packages/cli/vitest.shared.ts";

export default defineConfig({
  staged: {
    "*.{ts,tsx,js,jsx,mjs,cjs,json,jsonc}": "./node_modules/.bin/vp check --fix",
    "*.md": "./node_modules/.bin/markdownlint --dot --fix",
  },
  lint: {
    ignorePatterns: ["/*", "!/vite.config.ts", "!/scripts/", "!/packages/", "/packages/*", "!/packages/cli/", "packages/cli/dist/**", "packages/cli/bundle/**", "**/node_modules/**", "**/*.generated.*", "packages/cli/test/**/fixtures/**", "packages/cli/test/evidence/**"],
    options: { maxWarnings: 8 },
  },
  fmt: {
    ignorePatterns: [
      "/*",
      "!/vite.config.ts",
      "!/package.json",
      "!/.markdownlint.json",
      "!/packages/",
      "/packages/*",
      "!/packages/cli/",
      "packages/cli/dist/**",
      "packages/cli/bundle/**",
      "**/node_modules/**",
      "packages/cli/test/**/fixtures/**",
      "packages/cli/test/evidence/**",
      "packages/cli/scripts/verify-all-test-typecheck-evidence.mjs",
      "packages/cli/test/validate/allTestTypecheckViability.test.ts",
      "**/*.generated.*",
    ],
    printWidth: 320,
    overrides: [
      {
        files: ["packages/cli/src/state/entityMigrationPreview.ts", "packages/cli/src/state/entityStorage.ts", "packages/cli/src/state/planEntities.ts", "packages/cli/src/state/todoDocsEntities.ts", "packages/cli/src/validate/activationArtifactEvidence.ts", "packages/cli/src/validate/activationConjunction.ts"],
        options: { printWidth: 320, objectWrap: "collapse" },
      },
    ],
  },
  test: {
    ...sharedTestConfig,
    maxWorkers: 2,
    projects: ownerProjects("source", 2),
  },
});
