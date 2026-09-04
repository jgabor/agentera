import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: [
      "/*",
      "!/packages/",
      "/packages/*",
      "!/packages/cli/",
      "packages/cli/dist/**",
      "packages/cli/bundle/**",
      "**/node_modules/**",
      "**/*.generated.*",
    ],
    options: { maxWarnings: 431 },
  },
  fmt: {
    ignorePatterns: [
      "/*",
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
        files: [
          "packages/cli/src/state/entityMigrationPreview.ts",
          "packages/cli/src/state/entityStorage.ts",
          "packages/cli/src/state/planEntities.ts",
          "packages/cli/src/state/todoDocsEntities.ts",
          "packages/cli/src/validate/activationArtifactEvidence.ts",
          "packages/cli/src/validate/activationConjunction.ts",
        ],
        options: { printWidth: 320, objectWrap: "collapse" },
      },
    ],
  },
  test: {
    // Source verification is owned by `vp run test`, not Vite+'s built-in runner.
    include: ["__vp_test_is_not_an_owner__/**/*.test.ts"],
  },
});
