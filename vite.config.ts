import fs from "node:fs";
import { defineConfig } from "vite-plus";
import { ownerProjects, sharedTestConfig } from "./packages/cli/vitest.shared.ts";

// Required owners stay fresh: per-task cache:false also resists --cache.
// Keep the existing package owners and argument forwarding, without vp recursion.
const managedNode = `"$VP_CLI_BIN" env exec --node ${fs.readFileSync(new URL(".node-version", import.meta.url), "utf8").trim()}`;
const freshCommands = {
  bootstrap: "VP_GIT_HOOKS=0 vp install --frozen-lockfile",
  test: "pnpm -C packages/cli test",
  // Explicit developer diagnostic, not the complete source owner.
  "test:local": "vp test run --project local",
  build: "pnpm -C packages/cli build",
  verify: "pnpm -C packages/cli run verify:release",
  "verify:development": "pnpm -C packages/cli run verify:development",
  typecheck: "pnpm -C packages/cli run typecheck",
  "typecheck:fresh": "pnpm -C packages/cli run typecheck",
  "cli:prepare:dev": "pnpm -C packages/cli run release:prepare",
  "cli:prepare:stable": "pnpm -C packages/cli/shim run release:prepare",
  "cli:qualify:source": "pnpm -C packages/cli run release:qualify:source",
  "cli:ready:dev": "pnpm -C packages/cli run release:ready",
  "cli:qualify:dev": "pnpm -C packages/cli run release:qualify:candidate",
  "cli:benchmark:qualification": "pnpm -C packages/cli run release:benchmark:qualification",
  "cli:publish:qualified:dev": "pnpm -C packages/cli run release:publish:qualified",
  "cli:publish:qualified:stable": "pnpm -C packages/cli/shim run release:publish:qualified",
  "cli:approve:dev": "pnpm -C packages/cli run release:approve",
  "cli:stage:dev": "pnpm -C packages/cli run release:stage",
  "cli:promote:dev": "pnpm -C packages/cli run release:promote",
  "cli:stage:stable": "pnpm -C packages/cli/shim run release:stage",
  "cli:promote:stable": "pnpm -C packages/cli/shim run release:promote",
};

export default defineConfig({
  run: {
    cache: { scripts: false, tasks: true },
    // Native run does not activate the managed Node runtime for task children.
    // Explicit managed exec preserves vp run aliases and forwarded arguments.
    tasks: {
      ...Object.fromEntries(
        Object.entries(freshCommands).map(([name, command]) => [
          name,
          {
            command: command.startsWith("pnpm ") || command.startsWith("vp test ") ? `${managedNode} ${command}` : command,
            cache: false,
          },
        ]),
      ),
      // Opt-in read-only feedback only. A real Node boundary prevents native
      // nested-run inlining from moving the guard inside the cached lookup.
      "typecheck:cached": {
        command: `${managedNode} node packages/cli/scripts/guard-native-cache.mjs "$VP_CLI_BIN" run _typecheck:cached`,
        cache: false,
      },
      "_typecheck:cached": {
        command: `${managedNode} pnpm -C packages/cli run typecheck`,
        cache: {
          input: [{ auto: true }, "packages/cli/src/**", "packages/cli/test/**", "packages/cli/tsconfig.json", "packages/cli/package.json", ".node-version", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "references/analysis/toolchain-baseline.yaml"],
          env: ["NODE_OPTIONS", "NODE_PATH", "NODE_ENV", "PATH", "VP_HOME", "VP_CLI_BIN", "VP_NODE_VERSION", "VP_PACKAGE_MANAGER", "VP_PNPM_VERSION"],
          output: [],
        },
      },
    },
  },
  staged: {
    // One sequential task keeps every reader inside the native staged snapshot.
    "*": ["./node_modules/.bin/vp check --fix", "node packages/cli/scripts/pre-commit-checks.mjs"],
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
      "!/*.md",
      "!/docs/",
      "/docs/**",
      "!/docs/**/",
      "!/docs/**/*.md",
      "!/skills/",
      "/skills/**",
      "!/skills/**/",
      "!/skills/**/*.md",
      "!/.opencode/",
      "/.opencode/**",
      "!/.opencode/skills/",
      "!/.opencode/skills/**/",
      "!/.opencode/skills/**/*.md",
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
      ".agentera/**",
      "TODO.md",
      "CHANGELOG.md",
      "references/**",
      "docs/plans/**",
      "skills/*/references/contract.md",
      // Published projection and line/digest-bound protocol surfaces are not prose.
      "skills/agentera/SKILL.md",
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
    projects: ownerProjects("source", 2, { partitionSource: true }),
  },
});
