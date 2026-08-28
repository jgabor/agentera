import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, inject, it } from "vitest";

import {
  EXPECTED_PRODUCER_READINESS,
  runProducerReadinessWorkflow,
} from "../helpers/producerReadinessWorkflow.js";
import { runProductionGlossaryWorkflow } from "../helpers/profileFullGlossaryWorkflow.js";

const fixture = inject("packageFixture");
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EMPTY_PERSONAL_GLOSSARY = [
  "<!-- agentera:personal-glossary:start -->",
  "## Glossary",
  "",
  "```json",
  '{"schema_version":"agentera.personalGlossarySection.v1","as_of":"2026-07-30","confidence_basis":{},"entries":[]}',
  "```",
  "<!-- agentera:personal-glossary:end -->",
].join("\n");

type BundleSurfaces = {
  directories: Array<{ path: string }>;
  files: Array<{ path: string }>;
  generated_files: Array<{ path: string }>;
};

const NPM_METADATA_FILES = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function unclassifiedManifestPaths(files: Iterable<string>, surfaces: BundleSurfaces): string[] {
  const allowedBundleFiles = new Set([
    ...surfaces.files.map(({ path: ownedPath }) => `bundle/${ownedPath}`),
    ...surfaces.generated_files.map(({ path: ownedPath }) => `bundle/${ownedPath}`),
  ]);
  const allowedBundleDirectories = surfaces.directories
    .map(({ path: ownedPath }) => `bundle/${ownedPath}/`);
  return [...files].filter((file) => {
    if (NPM_METADATA_FILES.has(file) || file.startsWith("dist/")) return false;
    if (allowedBundleFiles.has(file)) return false;
    return !allowedBundleDirectories.some((prefix) => file.startsWith(prefix));
  });
}

function validateDistributionInventory(files: Set<string>, surfaces: BundleSurfaces): void {
  const required = [
    "dist/bin/agentera.js",
    "bundle/.agentera-npx-bundle.json",
    "bundle/registry.json",
    "bundle/skills/agentera/SKILL.md",
    "bundle/references/artifacts/state-storage-authority.yaml",
  ];
  const missing = required.filter((file) => !files.has(file));
  const unclassified = unclassifiedManifestPaths(files, surfaces);
  if (missing.length > 0 || unclassified.length > 0) {
    throw new Error(`invalid distribution inventory: missing=${missing.join(",")} unclassified=${unclassified.join(",")}`);
  }
}

function packageEnvironment(
  home = path.join(fixture.root, "isolated-home"),
  profile?: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete env.AGENTERA_HOME;
  env.HOME = home;
  if (profile) env.AGENTERA_PROFILE_DIR = profile;
  else delete env.AGENTERA_PROFILE_DIR;
  return env;
}

function selectedTermObservation(
  bin: string,
  root: string,
  termBytes: Buffer | string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
) {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "PROFILE.md"), `# Profile\n\n${EMPTY_PERSONAL_GLOSSARY}\n`);
  const term = path.join(root, "term");
  fs.writeFileSync(term, termBytes);
  const result = spawnSync(
    process.execPath,
    [bin, "prime", "--context", "plan", "--term-input", term, "--format", "json"],
    { cwd: root, env: packageEnvironment(path.join(root, "home"), profile, sourceEnvironment), encoding: "utf8" },
  );
  const output = result.stdout + result.stderr;
  const payload = JSON.parse(result.stdout || result.stderr) as Record<string, any>;
  return {
    status: result.status,
    advice: payload.capability_context?.glossary_advice,
    instructions: payload.capability_context?.instructions,
    error: payload.error && {
      class: payload.error.class,
      syntax: payload.error.syntax,
      recovery: payload.error.recovery,
    },
    bytes: Buffer.byteLength(output),
    echoed: output.includes("package-private-selected-term"),
    files: fs.readdirSync(path.join(root, ".agentera")),
  };
}

function runResetWorkflow(bin: string, root: string) {
  const project = path.join(root, "project");
  const install = path.join(root, "install");
  const home = path.join(root, "home");
  const profile = path.join(root, "profile");
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(project, ".agentera", "PROGRESS.md"), "# Product v1 progress\n");
  fs.writeFileSync(path.join(project, ".agentera", "progress.yaml"), "schemaVersion: agentera.progress.v1\ncycles: []\n");
  fs.writeFileSync(path.join(project, "keep.txt"), "user owned\n");
  fs.writeFileSync(path.join(profile, "state"), "legacy profile\n");
  spawnSync("git", ["init", "-q", project], { encoding: "utf8" });

  const common = ["upgrade", "--reset-product-v1", "--project", project, "--install-root", install, "--home", home];
  const previewResult = spawnSync(process.execPath, [bin, ...common, "--dry-run", "--format", "json"], {
    cwd: project,
    env: packageEnvironment(home, profile),
    encoding: "utf8",
  });
  expect(previewResult.status, `reset preview failed:\n${previewResult.stdout}\n${previewResult.stderr}`).toBe(0);
  const preview = JSON.parse(previewResult.stdout);
  const applyResult = spawnSync(
    process.execPath,
    [bin, ...common, "--yes", "--authorization", preview.authorization, "--format", "json"],
    { cwd: project, env: packageEnvironment(home, profile), encoding: "utf8" },
  );
  expect(applyResult.status, `reset apply failed:\n${applyResult.stdout}\n${applyResult.stderr}`).toBe(0);
  const applied = JSON.parse(applyResult.stdout);

  return {
    preview: {
      schemaVersion: preview.schemaVersion,
      status: preview.status,
      mutation_performed: preview.mutation_performed,
      deletionIds: preview.deletions.map((item: { id: string }) => item.id),
      recreationIds: preview.recreations.map((item: { id: string }) => item.id),
      irreversibleLossCount: preview.irreversible_loss.length,
    },
    applied: { status: applied.status, effects_performed: applied.effects_performed },
    result: {
      productV1Removed: !fs.existsSync(path.join(project, ".agentera", "PROGRESS.md")),
      currentSchemaRemoved: !fs.existsSync(path.join(project, ".agentera", "progress.yaml")),
      unrelatedPreserved: fs.readFileSync(path.join(project, "keep.txt"), "utf8"),
      profileRemoved: !fs.existsSync(profile),
      canonicalSkillInstalled: fs.existsSync(path.join(install, "skills", "agentera", "SKILL.md")),
      canonicalSkillLinked: fs.realpathSync(path.join(home, ".agents", "skills", "agentera"))
        === fs.realpathSync(path.join(install, "skills", "agentera")),
    },
  };
}

describe("npm distribution boundary", () => {
  it("records deterministic, path-independent package construction from two roots", () => {
    expect(fixture.deterministicBytes).toMatchObject({
      packRuns: 2,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      secondSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fixture.deterministicBytes.secondSha256).toBe(fixture.deterministicBytes.sha256);
    expect(fixture.pathIndependence.constructionRoots).toHaveLength(2);
    expect(new Set(fixture.pathIndependence.constructionRoots).size).toBe(2);
    expect(fixture.pathIndependence.extractedRoots).toEqual([fixture.packageRoot]);
    expect(fixture.pathIndependence.regularFiles).toBeGreaterThan(0);
    expect(fixture.pathIndependence.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.pathIndependence.forbiddenPathMatches).toEqual([]);
    expect(fixture.pathIndependence.pathNeedleClasses).toContain("checkout-root:raw");
    expect(fixture.pathIndependence.secondManifest).toEqual(fixture.manifest);

    const tarball = fs.readFileSync(path.join(fixture.root, fixture.manifest.filename));
    expect(createHash("sha256").update(tarball).digest("hex")).toBe(fixture.deterministicBytes.sha256);
    expect(createHash("sha1").update(tarball).digest("hex")).toBe(fixture.manifest.shasum);
    expect(`sha512-${createHash("sha512").update(tarball).digest("base64")}`).toBe(fixture.manifest.integrity);
  });

  it("uses the fixture's isolated construction and extracted roots", () => {
    const constructedBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const extractedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    expect(isContained(fixture.root, fixture.constructionRoot)).toBe(true);
    expect(isContained(fixture.root, fixture.packageRoot)).toBe(true);
    expect(isContained(fixture.constructionRoot, fixture.packageRoot)).toBe(false);
    expect(isContained(CHECKOUT_ROOT, fixture.constructionRoot)).toBe(false);
    expect(fs.realpathSync(constructedBin)).toBe(constructedBin);
    expect(fs.realpathSync(extractedBin)).toBe(extractedBin);
    for (const surface of ["dist", "bundle"]) {
      expect(JSON.parse(fs.readFileSync(
        path.join(fixture.packageRoot, surface, ".agentera-build-source.json"),
        "utf8",
      ))).toEqual(fixture.sourceIdentity);
    }
  });

  it("keeps development version and source identity aligned through extraction", () => {
    const roots = [
      path.join(CHECKOUT_ROOT, "packages/cli"),
      fixture.constructionRoot,
      fixture.packageRoot,
    ];
    const manifests = roots.map((root) => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")));
    expect(manifests.map(({ version }) => version)).toEqual(Array(3).fill("3.0.0-dev.84"));
    expect(manifests.map(({ agentera }) => agentera.gitRef)).toEqual(Array(3).fill(manifests[0].agentera.gitRef));

    const versions = roots.map((root) => spawnSync(
      process.execPath,
      [path.join(root, "dist/bin/agentera.js"), "--version"],
      { encoding: "utf8" },
    ));
    expect(versions.every(({ status }) => status === 0)).toBe(true);
    expect(versions.map(({ stdout }) => stdout.trim())).toEqual(Array(3).fill("3.0.0-dev.84"));
  });

  it("extracts the manifest as regular files with the executable mode and no source maps", () => {
    const manifestFiles = new Map(fixture.manifest.files.map((entry) => [entry.path, entry]));
    let diskFiles = 0;
    for (const surface of ["dist", "bundle"]) {
      const pending = [path.join(fixture.packageRoot, surface)];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const name of fs.readdirSync(directory)) {
          const candidate = path.join(directory, name);
          const stat = fs.lstatSync(candidate);
          expect(stat.isSymbolicLink(), candidate).toBe(false);
          if (stat.isDirectory()) pending.push(candidate);
          else {
            expect(stat.isFile(), candidate).toBe(true);
            expect(stat.nlink, candidate).toBe(1);
            const relative = path.relative(fixture.packageRoot, candidate).split(path.sep).join("/");
            expect(manifestFiles.has(relative), relative).toBe(true);
            expect(stat.mode & 0o777, relative).toBe(manifestFiles.get(relative)!.mode);
            diskFiles += 1;
          }
        }
      }
    }
    expect(diskFiles).toBe([...manifestFiles.keys()].filter((file) => file.startsWith("dist/") || file.startsWith("bundle/")).length);
    expect([...manifestFiles.keys()].some((file) => file.endsWith(".map"))).toBe(false);
    expect(manifestFiles.get("dist/bin/agentera.js")!.mode & 0o111).not.toBe(0);
  });

  it("rejects incomplete or unclassified inventory before accepting the extracted inventory", () => {
    const authority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/package-registry.yaml"),
      "utf8",
    )) as any;
    const surfaces = authority.records.find((record: any) => record.identity.id === "agentera")
      .bundle_surfaces as BundleSurfaces;
    const files = new Set(fixture.manifest.files.map((entry) => entry.path));
    const incomplete = new Set(files);
    incomplete.delete("dist/bin/agentera.js");
    incomplete.add("plugin.json");

    expect(() => validateDistributionInventory(incomplete, surfaces))
      .toThrow("invalid distribution inventory: missing=dist/bin/agentera.js unclassified=plugin.json");
    expect(() => validateDistributionInventory(files, surfaces)).not.toThrow();
    expect([...files].some((file) => file.startsWith("src/") || file.startsWith("test/"))).toBe(false);
    expect([...files].some((file) => file.endsWith(".map"))).toBe(false);
    expect([...files].some((file) => file.startsWith("bundle/skills/agentera/agents/"))).toBe(false);
    for (const retired of [
      "dist/cli/commands/prime/v1Migration.js",
      "dist/registries/runtimeAdapterRegistry.js",
      "bundle/references/adapters/runtime-adapter-registry.yaml",
      "bundle/references/adapters/opencode.md",
      "bundle/references/adapters/cursor.md",
    ]) {
      expect(files.has(retired), retired).toBe(false);
    }
  });

  it("runs one status smoke from the extracted package", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = spawnSync(
      process.execPath,
      [bin, "prime", "--context", "status", "--format", "json"],
      { cwd: fixture.root, env: packageEnvironment(), encoding: "utf8" },
    );
    expect(result.status, `extracted status smoke failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      capability_context: { capability: string };
    };
    expect(payload.capability_context.capability).toBe("status");
  });

  it("matches selected-term startup across source, bundled, and extracted runtimes", () => {
    const bins = [
      path.join(CHECKOUT_ROOT, "packages/cli/dist/bin/agentera.js"),
      path.join(fixture.constructionRoot, "dist/bin/agentera.js"),
      path.join(fixture.packageRoot, "dist/bin/agentera.js"),
    ];
    const observations = bins.map((bin, index) => selectedTermObservation(
      bin,
      path.join(fixture.root, `term-parity-${index}`),
      "package-private-selected-term",
    ));

    const withoutBytes = observations.map(({ bytes: _bytes, ...observation }) => observation);
    expect(withoutBytes[1]).toEqual(withoutBytes[0]);
    expect(withoutBytes[2]).toEqual(withoutBytes[0]);
    expect(observations[0]).toMatchObject({
      status: 0,
      advice: { outcome: "no_applicable_entry" },
      echoed: false,
      files: ["state-mode.yaml"],
    });
    expect(observations.every(({ bytes }) => bytes <= 32_768)).toBe(true);

    const helps = bins.map((bin) => spawnSync(process.execPath, [bin, "prime", "--help"], { encoding: "utf8" }).stdout);
    expect(helps[1]).toBe(helps[0]);
    expect(helps[2]).toBe(helps[0]);
    expect(helps[0]).toContain("--term-input FILE|-");

    for (const relative of [
      "skills/agentera/capabilities/plan/schemas/validation.yaml",
      "skills/agentera/protocol.yaml",
    ]) {
      const contents = [
        fs.readFileSync(path.join(CHECKOUT_ROOT, relative), "utf8"),
        fs.readFileSync(path.join(fixture.constructionRoot, "bundle", relative), "utf8"),
        fs.readFileSync(path.join(fixture.packageRoot, "bundle", relative), "utf8"),
      ];
      expect(contents[1], relative).toBe(contents[0]);
      expect(contents[2], relative).toBe(contents[0]);
    }
  });

  it("isolates selected-term startup from an empty inherited XDG profile root", () => {
    const inheritedData = path.join(fixture.root, "empty-inherited-xdg");
    fs.mkdirSync(inheritedData);
    const observation = selectedTermObservation(
      path.join(fixture.packageRoot, "dist/bin/agentera.js"),
      path.join(fixture.root, "term-empty-xdg"),
      "package-private-selected-term",
      { ...process.env, XDG_DATA_HOME: inheritedData },
    );

    expect(observation).toMatchObject({
      status: 0,
      advice: { outcome: "no_applicable_entry" },
      echoed: false,
      files: ["state-mode.yaml"],
    });
    expect(fs.readdirSync(inheritedData)).toEqual([]);
  });

  it("matches structured, mutation-free scalar failures across all runtimes", () => {
    const bins = [
      path.join(CHECKOUT_ROOT, "packages/cli/dist/bin/agentera.js"),
      path.join(fixture.constructionRoot, "dist/bin/agentera.js"),
      path.join(fixture.packageRoot, "dist/bin/agentera.js"),
    ];
    const observations = bins.map((bin, index) => selectedTermObservation(
      bin,
      path.join(fixture.root, `term-failure-parity-${index}`),
      Buffer.from([0xc3, 0x28]),
    ));

    expect(observations[1]).toEqual(observations[0]);
    expect(observations[2]).toEqual(observations[0]);
    expect(observations[0]).toMatchObject({
      status: 2,
      error: { class: "invalid_selected_term" },
      echoed: false,
      files: ["state-mode.yaml"],
    });
  });

  it("serves and isolates the bundled Profile contract", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const authorityPath = path.join(
      fixture.packageRoot,
      "bundle/references/artifacts/glossary-entry-contract.yaml",
    );
    const projectRoot = path.join(fixture.root, "profile-contract");
    fs.mkdirSync(path.join(projectRoot, ".agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".agentera", "state-mode.yaml"),
      "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
    );
    const originalAuthority = fs.readFileSync(authorityPath);
    const runPrime = (capability: string) => spawnSync(
      process.execPath,
      [bin, "prime", "--context", capability, "--format", "json"],
      { cwd: projectRoot, env: packageEnvironment(), encoding: "utf8" },
    );

    const profile = runPrime("profile");
    expect(profile.status, profile.stderr || profile.stdout).toBe(0);
    expect(JSON.parse(profile.stdout)).toMatchObject({
      capability_context: { capability: "profile" },
    });

    try {
      const authority = YAML.parse(originalAuthority.toString("utf8")) as Record<string, any>;
      authority.personal_mining_authority.profile_full.existing_generation.list_limit = 0;
      fs.writeFileSync(authorityPath, YAML.stringify(authority), "utf8");

      const malformed = runPrime("profile");
      expect(malformed.status).not.toBe(0);
      expect(malformed.stderr + malformed.stdout).toContain(
        "personal glossary Profile Full contract is unavailable",
      );

      const build = runPrime("build");
      expect(build.status, build.stderr || build.stdout).toBe(0);
      expect(JSON.parse(build.stdout)).toMatchObject({
        capability_context: { capability: "build" },
      });
    } finally {
      fs.writeFileSync(authorityPath, originalAuthority);
    }
    expect(fs.readFileSync(authorityPath).equals(originalAuthority)).toBe(true);
  });

  it("matches the source personal glossary production workflow", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    expect(runProductionGlossaryWorkflow(bin, path.join(fixture.root, "glossary-production"))).toEqual({
      generationBound: true,
      outcome: "review_required",
      privacyBounded: true,
      recovery: "agentera report refresh --consent local-history",
    });
  });

  it("runs producer readiness publication and replay from the extracted package", { timeout: 120_000 }, async () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    await expect(runProducerReadinessWorkflow(bin, path.join(fixture.root, "producer-readiness")))
      .resolves.toEqual(EXPECTED_PRODUCER_READINESS);
  });

  it("matches source preview and destructive fresh reset behavior", () => {
    const sourceBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const packageBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const source = runResetWorkflow(sourceBin, path.join(fixture.root, "source-reset"));
    const packed = runResetWorkflow(packageBin, path.join(fixture.root, "packed-reset"));

    expect(packed).toEqual(source);
    expect(packed.result).toEqual({
      productV1Removed: true,
      currentSchemaRemoved: true,
      unrelatedPreserved: "user owned\n",
      profileRemoved: true,
      canonicalSkillInstalled: true,
      canonicalSkillLinked: true,
    });
  });
});
