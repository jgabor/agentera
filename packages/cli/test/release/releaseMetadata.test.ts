import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RELEASE_METADATA_ADVISORY_FILES,
  RELEASE_METADATA_AUTHORITY_FILES,
  readReleaseMetadata,
  releaseMetadataMain,
  validateReleaseMetadata,
} from "../../src/release/releaseMetadata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const VALID_REGISTRY = (version: string) => ({
  version: "1",
  skills: [
    {
      name: "agentera",
      version,
      description: "test",
      path: "skills/agentera",
      capabilities: [],
      tags: [],
      added: "2026-06-04",
    },
  ],
});

const VALID_PACKAGE = (overrides: Record<string, unknown> = {}) => ({
  name: "agentera",
  version: "3.0.0-dev.5",
  description: "test",
  type: "module",
  license: "Apache-2.0",
  author: "test",
  homepage: "https://github.com/jgabor/agentera",
  repository: {
    type: "git",
    url: "git+https://github.com/jgabor/agentera.git",
    directory: "packages/cli",
  },
  keywords: ["agentera"],
  engines: { node: ">=22" },
  bin: { agentera: "dist/bin/agentera.js" },
  files: ["dist", "bundle"],
  scripts: { build: "tsc -p tsconfig.json" },
  agentera: {
    suiteVersion: "3.0.0",
    gitRef: "dd3ea28813c6c787104519d41ec478c67488050e",
  },
  publishConfig: { access: "public", tag: "next" },
  dependencies: { "smol-toml": "^1.3.1", yaml: "^2.8.3" },
  devDependencies: {
    "@types/node": "^22.10.0",
    typescript: "^5.7.2",
    vitest: "^2.1.8",
  },
  ...overrides,
});

const VALID_CHANNELS = (dev = "3.0.0", stable = "2.7.7") => ({
  schema_version: "agentera.update_channels.v1",
  status: "active_authority",
  purpose: "test",
  sources: { prose: ["references/cli/vocabulary.md#update-channels"] },
  scope: { includes: [], excludes: [] },
  compatibility_boundary: "test",
  default_channel: "stable",
  channel_order: ["stable", "development"],
  channels: {
    stable: {
      concept: "v2_support_line",
      definition: "test",
      distribution_major: 2,
      resolution: {
        npm: { dist_tag: "latest", update_command: "npx -y agentera@latest" },
        git: { ref: "main", update_command: "uvx --from git+https://github.com/jgabor/agentera@main agentera" },
      },
    },
    development: {
      concept: "v3_pre_release_line",
      definition: "test",
      distribution_major: 3,
      resolution: {
        npm: { dist_tag: "next", update_command: "npx -y agentera@next" },
        git: { supported: false, reason: "test" },
      },
    },
  },
  override_precedence: ["cli_flag", "env_var", "config_file", "default"],
  override_keys: { cli: { flag: "--channel", values: ["stable", "development"] } },
  consumer_order: ["upgrade", "doctor", "prime", "docs", "tests"],
  consumers: {
    upgrade: { owns: [], may_resolve_channels: ["stable", "development"] },
    doctor: { owns: [], may_resolve_channels: ["stable", "development"] },
    prime: { owns: [], may_resolve_channels: ["stable", "development"] },
    docs: { owns: [], may_resolve_channels: ["stable", "development"] },
    tests: { owns: [], may_resolve_channels: ["stable", "development"] },
  },
  version_resolution: {
    running_version: { priority: ["bundle_marker", "npm_package_version", "suite_registry"] },
    latest_on_channel: {
      resolver: "npm_dist_tag_with_offline_defaults",
      offline_defaults: { stable, development: dev },
    },
    irreversibility: { downgrade_to_v2: "permanently_blocked", supported_downgrade_lines: [] },
    forward_major_gate: { mechanism: "semver_compare", apply_requires: ["dry_run_preview", "yes_flag"] },
    outcome_concepts: ["same_major_update", "forward_major_upgrade"],
  },
  docs_delegation: {
    document: "references/cli/vocabulary.md",
    required_anchor: "Update channels",
    authority_path: "references/cli/update-channels.yaml",
    must_not_duplicate_large_table: true,
  },
});

function writeFile(root: string, relative: string, body: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

function writeJson(root: string, relative: string, value: unknown): void {
  writeFile(root, relative, JSON.stringify(value, null, 2));
}

function makeFixtureRoot(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-metadata-"));
  writeJson(tmp, "registry.json", VALID_REGISTRY("3.0.0"));
  writeJson(tmp, "packages/cli/package.json", VALID_PACKAGE());
  writeFile(tmp, "references/cli/update-channels.yaml", JSON.stringify(VALID_CHANNELS("3.0.0")));
  return tmp;
}

describe("release-metadata", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeFixtureRoot();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when all source surfaces agree on a single release train", () => {
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toEqual([]);
  });

  it("exposes a snapshot that mirrors registry.json as the authoritative source", () => {
    const snap = readReleaseMetadata(tmp);
    expect(snap.authoritativeVersion).toBe("3.0.0");
    expect(snap.authoritativeSource).toBe("registry.json");
    expect(snap.packageVersion).toBe("3.0.0-dev.5");
    expect(snap.packageSuiteVersion).toBe("3.0.0");
    expect(snap.packageGitRef).toBe("dd3ea28813c6c787104519d41ec478c67488050e");
    expect(snap.developmentChannelDefault).toBe("3.0.0");
    expect(snap.stableChannelDefault).toBe("2.7.7");
    expect(snap.bundleSuiteVersion).toBeNull();
  });

  it("treats registry.json as the authoritative source of truth", () => {
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toEqual([]);
    expect(RELEASE_METADATA_AUTHORITY_FILES).toContain("registry.json");
    expect(RELEASE_METADATA_AUTHORITY_FILES).toContain("packages/cli/package.json");
    expect(RELEASE_METADATA_AUTHORITY_FILES).toContain("references/cli/update-channels.yaml");
  });

  it("fails when registry.json skills[0].version is missing", () => {
    fs.writeFileSync(path.join(tmp, "registry.json"), JSON.stringify({ skills: [] }));
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContain("registry.json: skills[0].version is required for release-metadata validation");
  });

  it("fails when registry.json skills[0].version is not a valid semver", () => {
    writeJson(tmp, "registry.json", VALID_REGISTRY("not-a-version"));
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContainEqual(
      expect.stringContaining("registry.json: skills[0].version \"not-a-version\" is not a valid semver"),
    );
  });

  it("forbids pre-release suffixes on the authoritative registry version", () => {
    writeJson(tmp, "registry.json", VALID_REGISTRY("3.0.0-dev.5"));
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContainEqual(
      expect.stringContaining("registry.json: skills[0].version must be a released core version"),
    );
  });

  it("fails when packages/cli/package.json top-level version drifts from registry core", () => {
    const pkg = VALID_PACKAGE();
    pkg.version = "3.1.0-dev.1";
    writeJson(tmp, "packages/cli/package.json", pkg);
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContainEqual(
      expect.stringContaining("release-metadata divergence: registry.json skills[0].version core is \"3.0.0\""),
    );
  });

  it("fails when packages/cli/package.json agentera.suiteVersion drifts from registry version", () => {
    const pkg = VALID_PACKAGE();
    pkg.agentera = { ...(pkg.agentera as Record<string, unknown>), suiteVersion: "3.0.1" };
    writeJson(tmp, "packages/cli/package.json", pkg);
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContainEqual(
      expect.stringContaining(
        "release-metadata divergence: registry.json skills[0].version is \"3.0.0\" but packages/cli/package.json agentera.suiteVersion is \"3.0.1\"",
      ),
    );
  });

  it("fails when packages/cli/package.json agentera.gitRef is not a 40-character hex SHA", () => {
    const cases: Array<[string, string]> = [
      ["missing", ""],
      ["empty whitespace", "   "],
      ["short SHA", "dd3ea28"],
      ["branch name", "main"],
      ["non-hex characters", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ];
    for (const [label, gitRef] of cases) {
      const pkg = VALID_PACKAGE();
      pkg.agentera = { ...(pkg.agentera as Record<string, unknown>), gitRef };
      writeJson(tmp, "packages/cli/package.json", pkg);
      const errors = validateReleaseMetadata(tmp);
      // Missing is its own error; everything else fails the hex-shape check.
      if (label === "missing") {
        expect(errors).toContain("packages/cli/package.json: `agentera.gitRef` is required for release-metadata validation");
      } else {
        expect(errors).toContainEqual(
          expect.stringContaining(
            `packages/cli/package.json: agentera.gitRef ${JSON.stringify(gitRef)} must be a 40-character hex SHA`,
          ),
        );
      }
    }
  });

  it("fails when update-channels.yaml development default drifts from registry version", () => {
    writeFile(tmp, "references/cli/update-channels.yaml", JSON.stringify(VALID_CHANNELS("3.0.1", "2.7.7")));
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContainEqual(
      expect.stringContaining(
        "release-metadata divergence: registry.json skills[0].version is \"3.0.0\" but update-channels.yaml offline_defaults.development is \"3.0.1\"",
      ),
    );
  });

  it("reports an advisory drift when the local bundle sentinel lags registry.json", () => {
    writeJson(tmp, "packages/cli/bundle/.agentera-npx-bundle.json", {
      kind: "agentera-npx-bundle",
      suiteVersion: "2.7.7",
    });
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("release-metadata drift (advisory)");
    expect(errors[0]).toContain("run `npm run bundle:data`");
    expect(RELEASE_METADATA_ADVISORY_FILES).toContain("packages/cli/bundle/.agentera-npx-bundle.json");
  });

  it("passes when the local bundle sentinel is in sync with registry.json", () => {
    writeJson(tmp, "packages/cli/bundle/.agentera-npx-bundle.json", {
      kind: "agentera-npx-bundle",
      suiteVersion: "3.0.0",
    });
    expect(validateReleaseMetadata(tmp)).toEqual([]);
  });

  it("fails when packages/cli/package.json is missing", () => {
    fs.rmSync(path.join(tmp, "packages/cli/package.json"));
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContain("packages/cli/package.json: missing or unreadable; cannot validate release-metadata");
  });

  it("fails when update-channels.yaml is missing", () => {
    fs.rmSync(path.join(tmp, "references/cli/update-channels.yaml"));
    const errors = validateReleaseMetadata(tmp);
    expect(errors).toContain(
      "references/cli/update-channels.yaml: version_resolution.latest_on_channel.offline_defaults.development is required",
    );
  });

  it("passes for a 2.x stable release train with @next pre-release on the development line", () => {
    // Stable-line shape: registry 2.7.7, package 2.7.7, channel dev default 2.7.7
    // (the 2.x line is on @latest; the dev default mirrors until retirement).
    writeJson(tmp, "registry.json", VALID_REGISTRY("2.7.7"));
    const pkg = VALID_PACKAGE({
      version: "2.7.7",
    });
    pkg.agentera = { suiteVersion: "2.7.7", gitRef: "abcdef0123456789abcdef0123456789abcdef01" };
    writeJson(tmp, "packages/cli/package.json", pkg);
    writeFile(tmp, "references/cli/update-channels.yaml", JSON.stringify(VALID_CHANNELS("2.7.7", "2.7.7")));
    expect(validateReleaseMetadata(tmp)).toEqual([]);
  });
});

describe("releaseMetadataMain", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeFixtureRoot();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 0 and prints 'release-metadata ok' on a coherent repo", () => {
    const lines: string[] = [];
    const rc = releaseMetadataMain({ root: tmp, out: (l) => lines.push(l) });
    expect(rc).toBe(0);
    expect(lines).toContain("release-metadata ok");
  });

  it("returns 1 and lists each violation on a divergent repo", () => {
    const pkg = VALID_PACKAGE();
    pkg.version = "3.1.0-dev.1";
    pkg.agentera = { suiteVersion: "3.1.0", gitRef: "deadbeef" };
    writeJson(tmp, "packages/cli/package.json", pkg);
    writeFile(tmp, "references/cli/update-channels.yaml", JSON.stringify(VALID_CHANNELS("3.1.0")));

    const lines: string[] = [];
    const rc = releaseMetadataMain({ root: tmp, out: (l) => lines.push(l) });
    expect(rc).toBe(1);
    const joined = lines.join("\n");
    expect(joined).toContain("release-metadata validation failed:");
    expect(joined).toContain("release-metadata divergence");
    expect(joined).toContain("40-character hex SHA");
  });
});

describe("release-metadata live repo", () => {
  it("validates the current feat/v3 working tree without drift", () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "packages/cli/package.json"))) {
      return;
    }
    const errors = validateReleaseMetadata(REPO_ROOT);
    // The current @next package.json is 3.0.0-dev.5 and registry.json
    // skills[0].version is 3.0.0; if this test fails after a future bump
    // the divergence is a real release-metadata regression.
    if (errors.length > 0) {
      throw new Error(
        `release-metadata drift in live repo: ${errors.join("; ")}. ` +
          `Bump registry.json skills[0].version and re-run \`pnpm -C packages/cli run bundle:data\`.`,
      );
    }
  });
});
