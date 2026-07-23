import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, inject, it } from "vitest";

const fixture = inject("packageFixture");
const V2_PROJECT = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project");
const V2_APP_HOME = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-app-home");
const V2_RUNTIME = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-runtime-python");
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PLAN_ID = "plan:123e4567-e89b-42d3-a456-426614174000";

function run(command: string, args: string[], cwd: string, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function isolatedPackageEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete env.AGENTERA_HOME;
  return env;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

type BundleSurfaces = {
  directories: Array<{ path: string }>;
  files: Array<{ path: string }>;
  generated_files: Array<{ path: string }>;
};

const NPM_METADATA_FILES = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);

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
    if (allowedBundleDirectories.some((prefix) => file.startsWith(prefix))) return false;
    return true;
  });
}

function currentDescriptorPaths(files: Iterable<string>): string[] {
  return [...files].filter((file) => file.startsWith("bundle/skills/agentera/agents/"));
}

function git(root: string, ...args: string[]): void {
  const result = run("git", args, root);
  if (result.status !== 0) throw new Error(result.stderr);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) hashes[relative] = `link:${fs.readlinkSync(absolute)}`;
      else hashes[relative] = sha256(fs.readFileSync(absolute));
    }
  };
  visit(root);
  return hashes;
}

function entityEnvelopes(project: string): Array<{ id: string; artifact: string; record: Record<string, unknown> }> {
  const root = path.join(project, ".agentera/entities");
  const envelopes: Array<{ id: string; artifact: string; record: Record<string, unknown> }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith(".yaml")) envelopes.push(YAML.parse(fs.readFileSync(absolute, "utf8")));
    }
  };
  visit(root);
  return envelopes.sort((a, b) => a.id.localeCompare(b.id));
}

describe("npm distribution boundary", () => {
  it("contains only regular, singly linked files and directories under packaged dist and bundle", () => {
    let files = 0;
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
            files += 1;
          }
        }
      }
    }
    expect(files).toBeGreaterThan(0);
  });

  it("tests a packed and extracted installation built outside checkout outputs", () => {
    expect(isContained(fixture.root, fixture.constructionRoot)).toBe(true);
    expect(isContained(fixture.root, fixture.packageRoot)).toBe(true);
    expect(isContained(fixture.constructionRoot, fixture.packageRoot)).toBe(false);
    expect(isContained(CHECKOUT_ROOT, fixture.constructionRoot)).toBe(false);
    expect(fs.realpathSync(path.join(fixture.packageRoot, "dist/bin/agentera.js")))
      .toMatch(`${path.sep}package${path.sep}dist${path.sep}bin${path.sep}agentera.js`);
  });

  it("constructs one self-contained CLI and shared-skill package inventory", () => {
    const files = new Set(fixture.manifest.files.map((entry) => entry.path));
    for (const required of [
      "dist/bin/agentera.js",
      "bundle/.agentera-npx-bundle.json",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      "bundle/references/artifacts/state-storage-authority.yaml",
    ]) {
      expect(files.has(required), required).toBe(true);
    }
    expect([...files].some((file) => file.startsWith("src/"))).toBe(false);
    expect(currentDescriptorPaths(files)).toEqual([]);
    for (const retired of [
      "dist/registries/runtimeAdapterRegistry.js",
      "dist/registries/runtimeAdapterRegistry.js.map",
    ]) {
      expect(files.has(retired), retired).toBe(false);
      expect(fs.existsSync(path.join(fixture.packageRoot, retired)), retired).toBe(false);
    }

    const authority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/package-registry.yaml"),
      "utf8",
    )) as any;
    const surfaces = authority.records.find((record: any) => record.identity.id === "agentera")
      .bundle_surfaces as BundleSurfaces;
    expect(
      unclassifiedManifestPaths(files, surfaces),
      "package boundary found manifest paths outside npm metadata, compiled CLI, or bundle authority",
    )
      .toEqual([]);

    for (const relative of [
      "skills/agentera/SKILL.md",
      "references/adapters/runtime-lifecycle-authority.yaml",
      "references/adapters/runtime-lifecycle-adapters.yaml",
      "references/adapters/runtime-lifecycle-operation-contract.yaml",
      "references/adapters/runtime-retired-resources.yaml",
    ]) {
      expect(
        fs.readFileSync(path.join(fixture.packageRoot, "bundle", relative)),
        `package boundary bundled ${relative} from a source other than its declared repository surface`,
      ).toEqual(fs.readFileSync(path.join(CHECKOUT_ROOT, relative)));
    }
    const runtimeAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-lifecycle-adapters.yaml"),
      "utf8",
    ));
    expect(runtimeAuthority).toMatchObject({
      status: "migration_only_contract",
      native_policy: { execution: "forbidden" },
      shared_resources: [],
      managed_resources: [],
      adapters: [],
    });
    const lifecycleAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-lifecycle-authority.yaml"),
      "utf8",
    ));
    expect(lifecycleAuthority).toMatchObject({
      status: "migration_only_authority",
      active_runtimes: [],
    });
    const operationAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-lifecycle-operation-contract.yaml"),
      "utf8",
    ));
    expect(operationAuthority).toMatchObject({
      status: "migration_only_contract",
      native_policy: { install_update_auth_trust_operations: "forbidden" },
    });
    const cleanupAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-retired-resources.yaml"),
      "utf8",
    ));
    expect(cleanupAuthority).toMatchObject({
      status: "resource_retirement_contract",
      policy: {
        selection: "native_agentera_resource_only",
        preview: "strictly_read_only",
        apply_requires: "explicit_approval",
        ownership: "matching_whole_resource_ledger_identity_and_fingerprint",
      },
    });
    for (const staleReference of [
      "runtime-adapter-characterization.md",
      "runtime-adapter-interface-model.yaml",
      "runtime-adapter-registry.yaml",
      "runtime-feature-parity.md",
      "opencode.md",
      "cursor.md",
    ]) {
      expect(
        files.has(`bundle/references/adapters/${staleReference}`),
        staleReference,
      ).toBe(false);
    }
    expect([...files].some((file) => file.startsWith("test/") || file.includes("upgrade/fixtures/")))
      .toBe(false);
  });

  it("flags a reintroduced native descriptor path in the package inventory", () => {
    expect(currentDescriptorPaths([
      "bundle/skills/agentera/SKILL.md",
      "bundle/skills/agentera/agents/build.toml",
      "bundle/.agentera/archive/legacy/skills/agentera/agents/build.toml",
    ])).toEqual(["bundle/skills/agentera/agents/build.toml"]);
  });

  it("rejects retired and otherwise unclassified top-level package surfaces", () => {
    const surfaces: BundleSurfaces = {
      directories: [{ path: "skills" }, { path: "references" }],
      files: [{ path: "registry.json" }],
      generated_files: [{ path: ".agentera-npx-bundle.json" }],
    };
    expect(unclassifiedManifestPaths([
      "package.json",
      "README.md",
      "dist/bin/agentera.js",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      ".opencode/package.json",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ], surfaces)).toEqual([
      ".opencode/package.json",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ]);
  });

  it("installs and invokes the extracted package without a repository checkout", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = run(process.execPath, [bin, "--help"], fixture.root, isolatedPackageEnv({
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: CHECKOUT_ROOT,
    }));
    expect(result.status, `package boundary invocation failed:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("agentera");
  });

  it("routes a structured request from the extracted package without exposing it in diagnostics", () => {
    const request = "help me decide: private package-boundary topic";
    const input = path.join(fixture.root, "route-request.yaml");
    fs.writeFileSync(input, YAML.stringify({ version: "agentera.route_request.v1", request }));
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = run(process.execPath, [bin, "route", "request", "--input", input, "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(result.status, `package boundary route failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain(request);
    expect(result.stdout).not.toContain(request);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "deterministic_selection",
      tier: "phrase",
      capability: "discuss",
    });
  });

  it("validates a semantic receipt from the extracted package and exposes only startup authorization", () => {
    const request = "private package semantic selection";
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const requestInput = path.join(fixture.root, "route-request.json");
    fs.writeFileSync(requestInput, JSON.stringify({ version: "agentera.route_request.v1", request }));
    const phaseOne = run(process.execPath, [bin, "route", "request", "--input", requestInput, "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(phaseOne.status, `package boundary phase one failed:\n${phaseOne.stdout}\n${phaseOne.stderr}`).toBe(0);
    expect(phaseOne.stderr).not.toContain(request);
    expect(phaseOne.stdout).not.toContain(request);
    const response = JSON.parse(phaseOne.stdout);
    expect(response).toMatchObject({ outcome: "semantic_required", semantic_capsule_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const receipt = {
      version: "agentera.route_receipt.v1",
      request_sha256: sha256(request),
      semantic_capsule_sha256: response.semantic_capsule_sha256,
      outcome: "select",
      capability: "plan",
      compound: "none",
      question: null,
      remainder_span: null,
    };
    const input = path.join(fixture.root, "route-receipt.json");
    fs.writeFileSync(input, JSON.stringify({ request, receipt }));
    const result = run(process.execPath, [bin, "route", "receipt", "--input", input, "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(result.status, `package boundary receipt failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain(request);
    expect(result.stdout).not.toContain(request);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "selected", capability: "plan", route_provenance: { startup_command: "agentera prime --context plan --format json" } });
  });

  it("evaluates the frozen routing corpus from byte-identical packed authorities", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = run(process.execPath, [bin, "route", "evaluate", "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(result.status, `package routing evaluation failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout) as { authority: Record<string, string>; corpus: Record<string, string>; status: string };
    expect(report.status).toBe("pass");
    for (const [reportKey, sourcePath, bundledPath] of [
      ["protocol_sha256", "references/cli/hybrid-route-contract.yaml", "bundle/references/cli/hybrid-route-contract.yaml"],
      ["phrase_authority_sha256", "skills/agentera/route-phrases.yaml", "bundle/skills/agentera/route-phrases.yaml"],
      ["shared_skill_sha256", "skills/agentera/SKILL.md", "bundle/skills/agentera/SKILL.md"],
    ] as const) {
      const sourceHash = sha256(fs.readFileSync(path.join(CHECKOUT_ROOT, sourcePath)));
      const bundledHash = sha256(fs.readFileSync(path.join(fixture.packageRoot, bundledPath)));
      expect(bundledHash, bundledPath).toBe(sourceHash);
      expect(report.authority[reportKey]).toBe(sourceHash);
    }
    const corpusHash = sha256(fs.readFileSync(path.join(CHECKOUT_ROOT, "fixtures/routing/hybrid-corpus.yaml")));
    expect(sha256(fs.readFileSync(path.join(fixture.packageRoot, "bundle/fixtures/routing/hybrid-corpus.yaml")))).toBe(corpusHash);
    expect(report.corpus.content_sha256).toBe(corpusHash);
  });

  it("upgrades one managed v2 fixture and converges on a same-install rerun", () => {
    const project = path.join(fixture.root, "project $(touch shell-expansion-trap) `touch backtick-trap`");
    fs.cpSync(V2_PROJECT, project, { recursive: true });
    const planPath = path.join(project, ".agentera/plan.yaml");
    const plan = YAML.parse(fs.readFileSync(planPath, "utf8"));
    plan.header.id = PLAN_ID;
    plan.tasks = [
      { number: 1, name: "Preserve packed records", depends_on: [], status: "pending", acceptance: ["records remain addressable"] },
      { number: 2, name: "Preserve packed relationships", depends_on: ["Task 1"], status: "pending", acceptance: ["dependency remains resolved"] },
    ];
    fs.writeFileSync(planPath, YAML.stringify(plan));
    const sourceBefore = new Map([
      [planPath, fs.readFileSync(planPath)],
      [path.join(project, ".agentera/progress.yaml"), fs.readFileSync(path.join(project, ".agentera/progress.yaml"))],
    ]);
    git(project, "init", "--quiet");
    git(project, "config", "user.name", "Package Verification Test");
    git(project, "config", "user.email", "package-verification@example.invalid");
    git(project, "config", "commit.gpgsign", "false");
    git(project, "add", ".");
    git(project, "commit", "--quiet", "-m", "tracked v2 fixture");

    const home = path.join(fixture.root, "home");
    fs.cpSync(V2_RUNTIME, home, { recursive: true });
    const appHome = path.join(home, ".local/share/agentera");
    fs.cpSync(V2_APP_HOME, appHome, { recursive: true });
    const preservedAppState = fs.readFileSync(path.join(appHome, ".agentera/progress.yaml"));
    const env = isolatedPackageEnv({
      HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: CHECKOUT_ROOT,
    });
    expect(env.AGENTERA_BOOTSTRAP_SOURCE_ROOT).toBeUndefined();
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const blocked = run(process.execPath, [bin, "prime", "--format", "json"], project, env);
    expect(blocked.status).toBe(1);
    const failure = JSON.parse(blocked.stdout) as { error: { recovery: string } };
    expect(failure.error.recovery).toMatch(/^npx -y agentera@next upgrade /);

    const migrationPreview = run(process.execPath, [
      bin, "state", "migrate", "entities", "--project", project, "--dry-run", "--limit", "100", "--format", "json",
    ], fixture.root, env);
    expect(migrationPreview.status, `package boundary entity preview failed:\n${migrationPreview.stdout}\n${migrationPreview.stderr}`).toBe(0);
    const migration = JSON.parse(migrationPreview.stdout) as any;
    const planEntries = migration.entries.filter((entry: any) => entry.artifact === "plan");
    expect(planEntries).toHaveLength(3);
    expect(migration.counts).toMatchObject({ publishable_entities: 3, relationships: 3, unresolved_relationships: 0 });
    for (const entry of planEntries) {
      expect(entry.source_paths).toEqual([".agentera/plan.yaml"]);
      expect(entry.provenance).toContain("current_canonical");
      expect(entry.migration_provenance).toContainEqual(expect.objectContaining({
        kind: "legacy_plan_normalization",
        source_path: ".agentera/plan.yaml",
      }));
    }
    const previewPlanEntity = planEntries.find((entry: any) => entry.boundary === "plan");
    const previewEntityIds = planEntries.map((entry: any) => entry.proposed_target.id).sort();

    const baseUpgradeArgs = [
      bin, "upgrade", "--channel", "development", "--project", project,
      "--install-root", appHome, "--force", "--format", "json",
    ];
    const preview = run(process.execPath, [...baseUpgradeArgs, "--dry-run"], fixture.root, env);
    expect(preview.status, `package boundary upgrade preview failed:\n${preview.stdout}\n${preview.stderr}`).toBe(1);
    const previewPlan = JSON.parse(preview.stdout) as any;
    expect(previewPlan.phases.map((phase: any) => phase.name)).toEqual([
      "detect", "artifacts", "entities", "runtime", "cleanup",
    ]);
    const runtimePhase = previewPlan.phases.find((phase: any) => phase.name === "runtime");
    const legacyRewires = runtimePhase.items.filter((item: any) =>
      item.status === "pending" && ["rewire-runtime", "retire-hooks"].includes(item.action));
    expect(legacyRewires.map((item: any) => item.source).sort()).toEqual([
      path.join(home, ".codex/config.toml"),
      path.join(home, ".codex/hooks/codex-hooks.json"),
      path.join(home, ".cursor/hooks.json"),
    ].sort());
    expect(JSON.stringify(previewPlan)).not.toContain(path.join(home, ".agents/skills/agentera"));

    const upgraded = run(process.execPath, [...baseUpgradeArgs, "--yes"], fixture.root, env);
    expect(upgraded.status, `package boundary upgrade failed:\n${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
    expect(JSON.parse(upgraded.stdout)).toMatchObject({
      phase: "complete",
      status: "success",
      state_validation: { status: "passed", entity_count: 3, issue_count: 0 },
      startup_validation: { status: "passed" },
    });
    expect(fs.existsSync(path.join(fixture.root, "shell-expansion-trap"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, "backtick-trap"))).toBe(false);
    expect(YAML.parse(fs.readFileSync(path.join(project, ".agentera/state-mode.yaml"), "utf8")))
      .toMatchObject({ mode: "entities" });
    for (const [source, bytes] of sourceBefore) expect(fs.readFileSync(source)).toEqual(bytes);

    const entities = entityEnvelopes(project);
    expect(entities).toHaveLength(3);
    expect(entities.map(({ id }) => id)).toEqual(previewEntityIds);
    const planEntity = entities.find((entity) => entity.id === previewPlanEntity.proposed_target.id)!;
    const tasks = entities.filter((entity) => entity.record.plan === planEntity.id)
      .sort((a, b) => String(a.record.name).localeCompare(String(b.record.name)));
    expect(planEntity.record).toMatchObject({ header: { title: "Supported legacy plan", status: "open" } });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].record).toMatchObject({ name: "Preserve packed records", plan: planEntity.id, depends_on: [] });
    expect(tasks[1].record).toMatchObject({ name: "Preserve packed relationships", plan: planEntity.id, depends_on: [tasks[0].id] });

    expect(fs.readFileSync(path.join(appHome, ".agentera/progress.yaml"))).toEqual(preservedAppState);
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).not.toContain("AGENTERA_HOME");
    for (const rewired of [path.join(home, ".codex/hooks/codex-hooks.json"), path.join(home, ".cursor/hooks.json")]) {
      const text = fs.readFileSync(rewired, "utf8");
      expect(text).toContain("npx -y agentera");
      expect(text).not.toMatch(/validate_artifact\.py|cursor_session_start\.py/);
    }
    expect(fs.existsSync(path.join(home, ".agents/skills/agentera"))).toBe(false);

    const projectAfterFirst = treeHashes(project);
    const homeAfterFirst = treeHashes(home);
    const rerunPreview = run(process.execPath, [...baseUpgradeArgs, "--dry-run"], fixture.root, env);
    expect(rerunPreview.status, `package boundary rerun preview failed:\n${rerunPreview.stdout}\n${rerunPreview.stderr}`).toBe(0);
    const rerunPlan = JSON.parse(rerunPreview.stdout) as any;
    expect(rerunPlan.phases.some((phase: any) => phase.name === "lifecycle")).toBe(false);
    expect(rerunPlan.phases.flatMap((phase: any) => phase.items).filter((item: any) => item.status === "pending"))
      .toEqual([]);

    const rerun = run(process.execPath, [...baseUpgradeArgs, "--yes"], fixture.root, env);
    expect(rerun.status, `package boundary rerun failed:\n${rerun.stdout}\n${rerun.stderr}`).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({
      mode: "apply",
      status: "noop",
      summary: { pending: 0, failed: 0, blocked: 0 },
    });
    expect(treeHashes(project)).toEqual(projectAfterFirst);
    expect(treeHashes(home)).toEqual(homeAfterFirst);
    expect(entityEnvelopes(project).map(({ id }) => id)).toEqual(entities.map(({ id }) => id));

    const primed = run(process.execPath, [bin, "prime", "--format", "json"], project, env);
    expect(primed.status, `package boundary prime failed:\n${primed.stderr}`).toBe(0);
    const payload = JSON.parse(primed.stdout) as {
      command: string;
      status: string;
      app_home: { home: string; source: string };
      app: { sourceRoot: string };
    };
    expect(payload).toMatchObject({
      command: "prime",
      status: "ok",
      app_home: { home: expect.any(String), source: "bundled app" },
      app: { sourceRoot: expect.any(String) },
    });
    const bundleRoot = fs.realpathSync(path.join(fixture.packageRoot, "bundle"));
    for (const reportedSource of [payload.app_home.home, payload.app.sourceRoot]) {
      const appSource = fs.realpathSync(reportedSource);
      expect(
        isContained(bundleRoot, appSource),
        `package boundary escaped extracted bundle: source=${appSource} bundle=${bundleRoot}`,
      ).toBe(true);
    }
  });
});
