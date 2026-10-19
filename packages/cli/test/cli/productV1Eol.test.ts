import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { main } from "../../src/cli/dispatch/index.js";
import { resolveSourceRoot } from "../../src/core/sourceRoot.js";
import { loadNativeResourceCleanupContract } from "../../src/runtime/nativeResourceCleanup.js";
import { PROFILE_FILE_MEMBERS, USER_DATA_CATALOG_DIRS } from "../../src/migrate/v2HandoffManifest.js";
import { ROOT_USER_STATE_DIR_NAMES, ROOT_USER_STATE_FILE_NAMES } from "../../src/upgrade/doctor.js";
import { PRODUCT_V1_RESET_USER_DATA_NAMES, applyProductV1Reset, authorizeProductV1Reset, previewProductV1Reset } from "../../src/upgrade/productV1Reset.js";
import { classifyProjectState } from "../../src/state/stateMode.js";
import { applyAppContentRefresh } from "../../src/upgrade/appContentRefresh.js";
import { shellCommandArgs } from "../helpers/shellCommand.js";

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-eol-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera", "PROGRESS.md"), "# Product v1 progress\n");
  fs.writeFileSync(path.join(root, "keep.txt"), "user owned\n");
  execFileSync("git", ["init", "-q", root]);
  return root;
}

function snapshot(root: string, ignored: string[] = []): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (ignored.includes(path.relative(root, target))) continue;
      hash.update(path.relative(root, target)).update(entry.isDirectory() ? "directory" : "file");
      if (entry.isDirectory()) visit(target);
      else hash.update(fs.readFileSync(target));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function run(root: string, args: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

const ROOT_ENV_KEYS = ["AGENTERA_PROFILE_DIR", "PROFILERA_PROFILE_DIR", "AGENTERA_HOME", "AGENTERA_DEFAULT_INSTALL_ROOT"] as const;

function withRootEnv<T>(profile: string | null, body: () => T): T {
  const previous = Object.fromEntries(ROOT_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ROOT_ENV_KEYS) delete process.env[key];
  if (profile !== null) process.env.AGENTERA_PROFILE_DIR = profile;
  try {
    return body();
  } finally {
    for (const key of ROOT_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function writeFile(target: string, content = "x\n"): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const USER_DATA_NAMES = ["PROFILE.md", "USAGE.md", "benchmarks", "corpus", "corpus.json", "history", "intermediate", "sessions"];

function populateDataRoot(root: string): void {
  writeFile(path.join(root, "PROFILE.md"), "# Profile\n");
  writeFile(path.join(root, "USAGE.md"), "# Usage\n");
  writeFile(path.join(root, "corpus.json"));
  writeFile(path.join(root, "intermediate", "corpus.json"));
  for (let i = 0; i < 60; i++) writeFile(path.join(root, "history", `PROFILE-${i}.md`));
  for (let i = 0; i < 200; i++) writeFile(path.join(root, "sessions", `session-${String(i).padStart(4, "0")}-with-a-longer-name.jsonl`));
  for (let i = 0; i < 40; i++) writeFile(path.join(root, "benchmarks", `bench-${i}.json`));
  for (let i = 0; i < 30; i++) writeFile(path.join(root, "corpus", `c-${i}.json`));
  for (const top of ["skills", "references", "scripts", "agents", "docs", "schemas", "templates", "commands", "plugins", "bin", "lib", "share", "vendor", "examples"]) for (let i = 0; i < 25; i++) writeFile(path.join(root, top, `sub-${i % 5}`, `file-${i}.md`));
  for (const name of ["TODO.md", "CHANGELOG.md", "DESIGN.md", "README.md", "LICENSE", "VERSION", "package.json", "notes.txt", "config.yaml"]) writeFile(path.join(root, name));
}

/**
 * A v1 home with user data, many top-level entries and every host resource family present.
 * By default the profile root is the installation root; `split` gives the profile its own root with its own user data.
 * `long` pads every root by that many characters, nesting directories so no name exceeds 200 characters.
 */
function worstCaseHome(options: { split?: boolean; long?: number } = {}): { project: string; home: string; install: string; profile: string | null; userData: string[] } {
  let project: string;
  let home: string;
  let profile: string | null = null;
  if (options.long) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-long-"));
    roots.push(base);
    const padded = (name: string, fill: string): string => {
      const parts = [name];
      for (let left = options.long; left > 0; left -= 200) parts.push(fill.repeat(Math.min(200, left)));
      return path.join(base, ...parts);
    };
    project = padded("project", "p");
    home = padded("home", "h");
    if (options.split) profile = padded("profile", "r");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera", "PROGRESS.md"), "# Product v1 progress\n");
    execFileSync("git", ["init", "-q", project]);
  } else {
    project = fixture();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-worst-"));
    roots.push(home);
    if (options.split) {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-worst-profile-"));
      roots.push(profile);
    }
  }
  const install = path.join(home, ".local", "share", "agentera");
  writeFile(path.join(install, "registry.json"), JSON.stringify({ skills: [{ version: "1.4.0" }] }));
  writeFile(path.join(project, "TODO.md"));
  populateDataRoot(install);
  if (profile !== null) populateDataRoot(profile);
  const runtime = withRootEnv(profile, () => previewProductV1Reset({ project, home, installRoot: install })).deletions.find(({ id }) => id === "runtime.resources")!;
  for (const target of runtime.targets) {
    if (!target.path) continue;
    if (target.declared === "{home}/.agents/skills/agentera") writeFile(path.join(target.path, "SKILL.md"), "old\n");
    else if (target.operation === "remove_in_file_selector") {
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      fs.appendFileSync(target.path, `${target.selector!.value}\n`);
    } else if (!fs.existsSync(target.path)) writeFile(path.extname(target.path) ? target.path : path.join(target.path, "SKILL.md"));
  }
  const userData = [...(profile === null ? [] : USER_DATA_NAMES.map((name) => path.join(profile!, name))), ...USER_DATA_NAMES.map((name) => path.join(install, name))];
  return { project, home, install, profile, userData };
}

/** Absolute paths of a summary's root-relative user-data rows. */
function userDataPaths(value: { roots: Record<string, string>; user_data: Array<{ root: string; path: string }> }): string[] {
  return value.user_data.map((entry) => path.join(value.roots[entry.root]!, entry.path));
}

function resetPreview(project: string, home: string, install: string, extra: string[] = []) {
  const result = run(project, ["upgrade", "--reset-product-v1", "--project", project, "--install-root", install, "--home", home, "--dry-run", ...extra, "--format", "json"]);
  return { ...result, value: JSON.parse(result.out), bytes: Buffer.byteLength(result.out) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("product v1 EOL execution gate", () => {
  it("binds reset host removal and one-file delivery to broad approval without traversing the old link", () => {
    const project = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-host-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-app-"));
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-legacy-"));
    roots.push(home, install, legacy);
    fs.writeFileSync(path.join(legacy, "SKILL.md"), "old runtime");
    fs.writeFileSync(path.join(legacy, "user-data"), "retain");
    const host = path.join(home, ".agents/skills/agentera");
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.symlinkSync(legacy, host);
    const options = { project, home, installRoot: install, env: {} };
    const preview = previewProductV1Reset(options);
    expect(preview.deletions.flatMap((item) => item.targets)).toContainEqual(
      expect.objectContaining({
        path: host,
        entries: [
          expect.objectContaining({
            type: "symlink",
            link_target: legacy,
            identity: expect.any(Object),
          }),
        ],
      }),
    );
    expect(preview.recreations.find((item) => item.id === "runtime.canonical-skill")?.targets[0]).toMatchObject({ path: host, delivery: { files: ["SKILL.md"] } });
    fs.unlinkSync(host);
    fs.symlinkSync(path.join(legacy, "other"), host);
    expect(() => applyProductV1Reset(options, preview.authorization)).toThrow(/scope changed/);
    expect(fs.existsSync(path.join(project, ".agentera/PROGRESS.md"))).toBe(true);
    fs.unlinkSync(host);
    fs.symlinkSync(legacy, host);
    const approved = previewProductV1Reset(options);
    expect(applyProductV1Reset(options, approved.authorization).status).toBe("complete");
    expect(fs.lstatSync(host).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(host)).toEqual(["SKILL.md"]);
    expect(fs.readFileSync(path.join(legacy, "user-data"), "utf8")).toBe("retain");
    expect(fs.readFileSync(path.join(legacy, "SKILL.md"), "utf8")).toBe("old runtime");
  });

  it("reset refuses copied host extras before any reset effects", () => {
    const project = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-extras-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-app-"));
    roots.push(home, install);
    const host = path.join(home, ".agents/skills/agentera");
    fs.mkdirSync(host, { recursive: true });
    fs.writeFileSync(path.join(host, "SKILL.md"), "legacy");
    fs.writeFileSync(path.join(host, "private-extra"), "retain");
    const before = [snapshot(project), snapshot(home), snapshot(install)];
    expect(() => previewProductV1Reset({ project, home, installRoot: install, env: {} })).toThrow(/preserves full copied host trees/);
    expect([snapshot(project), snapshot(home), snapshot(install)]).toEqual(before);
  });
  it("blocks ordinary read-only and stateful commands with the future reset workflow without mutation", () => {
    const root = fixture();
    const before = snapshot(root);

    for (const args of [
      ["state", "query", "--list-artifacts", "--format", "json"],
      ["state", "plan", "create", "--input", "-", "--format", "json"],
    ]) {
      const result = run(root, args);
      expect(result.rc).toBe(1);
      expect(JSON.parse(result.out).error).toMatchObject({
        class: "product_v1_eol",
        message: expect.stringContaining("end-of-life"),
        reset_workflow: expect.arrayContaining([expect.stringContaining("Explicitly approve apply")]),
        recovery: expect.stringContaining("did not change state"),
      });
      expect(snapshot(root)).toBe(before);
    }
  });

  it("keeps help and version available without mutation", () => {
    const root = fixture();
    const before = snapshot(root);

    const help = run(root, ["state", "plan", "--help"]);
    const version = run(root, ["--version"]);

    expect(help).toMatchObject({ rc: 0, err: "" });
    expect(help.out).toContain("agentera state plan");
    expect(version).toMatchObject({ rc: 0, err: "" });
    expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(snapshot(root)).toBe(before);
  });

  it("also gates declared product-v1 installation evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-eol-clean-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    roots.push(root, install);
    fs.writeFileSync(path.join(install, "registry.json"), JSON.stringify({ skills: [{ version: "1.9.0" }] }));
    const previous = process.env.AGENTERA_HOME;
    process.env.AGENTERA_HOME = install;
    try {
      const before = snapshot(root);
      const result = run(root, ["state", "query", "--list-artifacts", "--format", "json"]);
      expect(result.rc).toBe(1);
      expect(JSON.parse(result.out).error).toMatchObject({
        class: "product_v1_eol",
        evidence: [path.join(install, "registry.json")],
      });
      expect(snapshot(root)).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.AGENTERA_HOME;
      else process.env.AGENTERA_HOME = previous;
    }
  });

  it.each([
    { name: "a v1 installation selected past an empty AGENTERA_HOME", project: false, version: "1.27.1", expected: ["install"] },
    { name: "a v1 project with a v3 installation", project: true, version: "3.0.0-dev.72", expected: ["project"] },
    { name: "a v1 project and a v1 installation", project: true, version: "1.4.0", expected: ["install", "project"] },
    { name: "a non-semver 1.x registry selected by AGENTERA_HOME", project: false, version: "1.beta", expected: [], viaHome: true },
    { name: "v3 state", project: false, version: "3.0.0-dev.72", expected: [] },
  ])("the end-of-life gate and the reset preview find the same evidence for $name", ({ project, version, expected, viaHome }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-parity-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-parity-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-parity-install-"));
    roots.push(root, home, install);
    fs.mkdirSync(path.join(root, ".agentera"));
    if (project) fs.writeFileSync(path.join(root, ".agentera", "PROGRESS.md"), "# Product v1 progress\n");
    fs.writeFileSync(path.join(install, "registry.json"), JSON.stringify({ version: "1", skills: [{ version }] }));
    const evidence = { install: path.join(install, "registry.json"), project: path.join(root, ".agentera", "PROGRESS.md") };
    const want = expected.map((key) => evidence[key as keyof typeof evidence]).sort();

    const [gate, preview] = withRootEnv(null, () => {
      process.env.AGENTERA_HOME = viaHome ? install : "";
      process.env.AGENTERA_DEFAULT_INSTALL_ROOT = install;
      return [run(root, ["state", "query", "--list-artifacts", "--format", "json"]), run(root, ["upgrade", "--reset-product-v1", "--project", root, "--home", home, "--dry-run", "--full-detail", "--format", "json"])];
    });
    const gateError = JSON.parse(gate.out).error;
    const gateEvidence = gateError?.class === "product_v1_eol" ? gateError.evidence : [];
    const previewValue = JSON.parse(preview.out);
    const previewEvidence = preview.rc === 0 ? previewValue.evidence : [];
    if (preview.rc !== 0) expect(previewValue.error.message).toContain("requires declared product-v1 generation evidence");
    expect(gateEvidence).toEqual(want);
    expect(previewEvidence).toEqual(want);
  });

  it("previews every bounded reset effect and authorizes only the unchanged reviewed scope", () => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-profile-"));
    roots.push(home, install, profile);
    const previousProfile = process.env.AGENTERA_PROFILE_DIR;
    process.env.AGENTERA_PROFILE_DIR = profile;
    try {
      const args = ["upgrade", "--reset-product-v1", "--project", root, "--install-root", install, "--home", home, "--dry-run", "--format", "json"];
      const before = [snapshot(root), snapshot(home), snapshot(install), snapshot(profile)];
      const previewResult = run(root, args);
      expect(previewResult.rc).toBe(0);
      const preview = JSON.parse(previewResult.out);
      expect(preview).toMatchObject({
        schemaVersion: "agentera.productV1ResetPreview.v1",
        status: "review_required",
        mutation_performed: false,
        roots: { project: root, profile_root: profile, install_root: install, runtime_home: home },
      });
      expect(preview.deletions.map((item: { id: string }) => item.id)).toEqual(["project.state", "profile.state", "installation.state", "runtime.resources"]);
      expect(preview.recreations.map((item: { id: string }) => item.id)).toEqual(["project.fresh-v3", "installation.current-package", "runtime.canonical-skill"]);
      expect(preview.detail).toBe("summary");
      expect(preview.deletions.every((item: { entries: object; omitted_count: number }) => typeof item.entries === "object" && item.omitted_count === 0)).toBe(true);
      expect(preview.irreversible_loss).toHaveLength(4);
      expect(preview.authorization).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(preview).toMatchObject({
        approval: "explicit_yes_only",
        question: expect.stringContaining("no backup or undo"),
        apply_command: expect.stringContaining(`--project ${root}`),
      });
      expect(preview.apply_command).toContain(`--home ${home} --install-root ${install} --yes --authorization ${preview.authorization} --format json`);
      expect(preview.apply_command).not.toContain("--channel");
      expect([snapshot(root), snapshot(home), snapshot(install), snapshot(profile)]).toEqual(before);
      // Host No/silence does not invoke apply; preview alone never changes state.

      fs.writeFileSync(path.join(root, ".agentera", "new-state.yaml"), "changed: true\n");
      const changed = snapshot(root);
      const stale = run(root, shellCommandArgs(preview.apply_command.replace(/^npx -y agentera@next /, "agentera ")));
      expect(stale.rc).toBe(2);
      expect(JSON.parse(stale.out).error.message).toContain("scope changed after preview");
      expect(snapshot(root)).toBe(changed);

      const freshPreview = JSON.parse(run(root, args).out);
      const authorized = run(root, shellCommandArgs(freshPreview.apply_command.replace(/^npx -y agentera@next /, "agentera ")));
      expect(authorized.rc).toBe(0);
      expect(JSON.parse(authorized.out)).toMatchObject({
        status: "complete",
        effects_performed: true,
      });
      expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("user owned\n");
      expect(fs.existsSync(path.join(root, ".agentera"))).toBe(false);
      expect(classifyProjectState(root).state).toBe("fresh_uninitialized");
      expect(fs.existsSync(profile)).toBe(false);
      expect(fs.existsSync(path.join(install, "skills", "agentera", "SKILL.md"))).toBe(true);
      expect(fs.lstatSync(path.join(home, ".agents", "skills", "agentera")).isSymbolicLink()).toBe(false);
      expect(fs.readdirSync(path.join(home, ".agents", "skills", "agentera"))).toEqual(["SKILL.md"]);
    } finally {
      if (previousProfile === undefined) delete process.env.AGENTERA_PROFILE_DIR;
      else process.env.AGENTERA_PROFILE_DIR = previousProfile;
    }
  });

  it("never follows scoped symlinks and rejects an aliased declared root", () => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-external-"));
    const installAlias = path.join(path.dirname(install), `${path.basename(install)}-alias`);
    roots.push(home, install, external, installAlias);
    fs.writeFileSync(path.join(external, "keep.txt"), "external\n");
    fs.symlinkSync(external, path.join(root, ".agentera", "external-link"));
    fs.symlinkSync(install, installAlias);

    const preview = run(root, ["upgrade", "--reset-product-v1", "--project", root, "--install-root", install, "--home", home, "--dry-run", "--full-detail", "--format", "json"]);
    expect(preview.rc).toBe(0);
    const serialized = preview.out;
    expect(serialized).toContain(path.join(root, ".agentera", "external-link"));
    expect(serialized).not.toContain(path.join(external, "keep.txt"));

    const alias = run(root, ["upgrade", "--reset-product-v1", "--project", root, "--install-root", installAlias, "--home", home, "--dry-run", "--format", "json"]);
    expect(alias.rc).toBe(2);
    expect(JSON.parse(alias.out).error.message).toContain("must not be a symbolic link");
    expect(fs.readFileSync(path.join(external, "keep.txt"), "utf8")).toBe("external\n");
  });

  it("refuses a changed reset destination and unrelated upgrade/cleanup flags under the old approval", () => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-other-"));
    roots.push(home, install, other);
    const preview = JSON.parse(run(root, ["upgrade", "--reset-product-v1", "--project", root, "--install-root", install, "--home", home, "--dry-run", "--format", "json"]).out);
    const offered = shellCommandArgs(preview.apply_command.replace(/^npx -y agentera@next /, "agentera "));
    const before = [snapshot(root), snapshot(home), snapshot(install), snapshot(other)];
    const changed = run(
      root,
      offered.map((arg: string) => (arg === install ? other : arg)),
    );
    expect(changed.rc).toBe(2);
    expect(JSON.parse(changed.out).error.message).toContain("scope changed");
    for (const flag of [["--channel", "development"], ["--legacy-cleanup", "codex.agent-descriptor.build"], ["--only", "cleanup"], ["--force"]]) {
      const denied = run(root, [...offered, ...flag]);
      expect(denied.rc).toBe(2);
      expect(JSON.parse(denied.out).error.message).toContain("without other upgrade modes");
    }
    expect([snapshot(root), snapshot(home), snapshot(install), snapshot(other)]).toEqual(before);
  });

  it.each(["v2", "v3"])("does not offer a product-v1 reset for %s project state", (generation) => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    roots.push(home, install);
    fs.rmSync(path.join(root, ".agentera/PROGRESS.md"));
    fs.writeFileSync(path.join(root, ".agentera", generation === "v3" ? "state-mode.yaml" : "progress.yaml"), generation === "v3" ? "schemaVersion: agentera.stateMode.v1\nmode: entities\n" : "schemaVersion: agentera.progress.v2\ncycles: []\n");
    const before = [snapshot(root), snapshot(home), snapshot(install)];
    const result = run(root, ["upgrade", "--reset-product-v1", "--project", root, "--install-root", install, "--home", home, "--dry-run", "--format", "json"]);
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out).error.message).toContain("requires declared product-v1 generation evidence");
    expect([snapshot(root), snapshot(home), snapshot(install)]).toEqual(before);
  });

  it("authorizes only Agentera selectors inside shared Codex configuration", () => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-profile-"));
    roots.push(home, install, profile);
    const codex = path.join(home, ".codex");
    fs.mkdirSync(codex);
    const config = path.join(codex, "config.toml");
    fs.writeFileSync(config, ["[plugins.unrelated]", 'command = "keep-me"', "", '[plugins."agentera@agentera"]', 'command = "legacy-agentera"', ""].join("\n"));
    const options = {
      project: root,
      installRoot: install,
      home,
      env: { ...process.env, AGENTERA_PROFILE_DIR: profile },
    };

    const preview = previewProductV1Reset(options);
    const runtime = preview.deletions.find(({ id }) => id === "runtime.resources")!;
    const configTargets = runtime.targets.filter((target) => target.path === config);
    expect(configTargets.length).toBeGreaterThan(0);
    expect(configTargets.every((target) => target.operation === "remove_in_file_selector" && target.selector !== undefined && target.entries === undefined && target.file_state?.type === "file")).toBe(true);
    expect(configTargets).toContainEqual(
      expect.objectContaining({
        selector: { kind: "contains", value: '[plugins."agentera@agentera"]' },
      }),
    );
    expect(JSON.stringify(configTargets)).not.toContain("keep-me");

    fs.appendFileSync(config, "[plugins.still_unrelated]\nenabled = true\n");
    expect(() => authorizeProductV1Reset(options, preview.authorization)).toThrow("scope changed after preview");

    const reviewed = previewProductV1Reset(options);
    const changedContract = structuredClone(loadNativeResourceCleanupContract());
    const selected = changedContract.diagnosticResources.find((resource) => resource.contains !== null)!;
    selected.contains = `${selected.contains}.changed`;
    expect(() =>
      authorizeProductV1Reset(options, reviewed.authorization, {
        runtimeContract: changedContract,
      }),
    ).toThrow("scope changed after preview");

    const authorized = authorizeProductV1Reset(options, reviewed.authorization);
    const validatedRuntime = authorized.validated_scope.deletions.find(({ id }) => id === "runtime.resources")!;
    expect(validatedRuntime.targets.filter((target) => target.path === config)).toEqual(
      configTargets.map((target) => ({
        ...target,
        file_state: expect.objectContaining({ type: "file" }),
      })),
    );
    expect(authorized.effects_performed).toBe(false);
  });

  it("removes only approved shared-file selectors and converges after interruption", () => {
    for (const interruptedEffect of ["journal", "delete:project.state:.agentera", "selector-staged", "initialize:fresh-v3"]) {
      const root = fixture();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
      const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-profile-"));
      roots.push(home, install, profile);
      fs.writeFileSync(path.join(root, "TODO.md"), "legacy todo\n");
      fs.writeFileSync(path.join(root, "VISION.md"), "legacy vision\n");
      fs.writeFileSync(path.join(profile, "profile-state"), "legacy\n");
      fs.writeFileSync(path.join(install, "registry.json"), JSON.stringify({ skills: [{ version: "1.2.3" }] }));
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      const config = path.join(home, ".codex", "config.toml");
      const originalConfig = [
        "[plugins.unrelated]",
        'command = "keep-me"',
        "",
        '  [plugins."agentera@agentera"]   # approved Agentera section',
        'command = "legacy-agentera"',
        "",
        "[plugins.after] # adjacent unrelated section",
        'command = "keep-after"',
        "",
        "[shell_environment_policy.set]",
        'AGENTERA_HOME = "/legacy"',
        'KEEP = "yes"',
        "",
      ].join("\n");
      fs.writeFileSync(config, originalConfig);
      fs.chmodSync(config, 0o640);
      const selectorStaging = `${config}.agentera-product-v1-reset.staging`;
      const options = {
        project: root,
        installRoot: install,
        home,
        env: { ...process.env, AGENTERA_PROFILE_DIR: profile },
      };
      const preview = previewProductV1Reset(options);
      let interrupted = false;
      expect(() =>
        applyProductV1Reset(options, preview.authorization, {
          afterEffect(effect) {
            if (!interrupted && (effect === interruptedEffect || (interruptedEffect === "selector-staged" && effect === `selector-staged:${config}`))) {
              interrupted = true;
              throw new Error(`interrupted after ${interruptedEffect}`);
            }
          },
        }),
      ).toThrow(`interrupted after ${interruptedEffect}`);

      if (interruptedEffect === "selector-staged") {
        expect(fs.readFileSync(config, "utf8")).toBe(originalConfig);
        expect(fs.statSync(config).mode & 0o7777).toBe(0o640);
        expect(fs.existsSync(selectorStaging)).toBe(true);
      }

      const result = applyProductV1Reset(options, preview.authorization);
      expect(result).toMatchObject({ status: "complete", effects_performed: true });
      expect(classifyProjectState(root).state).toBe("fresh_uninitialized");
      expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("user owned\n");
      expect(fs.existsSync(path.join(root, "TODO.md"))).toBe(false);
      expect(fs.existsSync(path.join(root, "VISION.md"))).toBe(false);
      expect(fs.existsSync(profile)).toBe(false);
      expect(fs.existsSync(path.join(root, ".agentera-product-v1-reset.json"))).toBe(false);
      expect(fs.existsSync(selectorStaging)).toBe(false);
      expect(fs.statSync(config).mode & 0o7777).toBe(0o640);
      expect(fs.readFileSync(config, "utf8")).toBe(["[plugins.unrelated]", 'command = "keep-me"', "", "[plugins.after] # adjacent unrelated section", 'command = "keep-after"', "", "[shell_environment_policy.set]", 'KEEP = "yes"', ""].join("\n"));
      expect(fs.existsSync(path.join(install, "skills", "agentera", "SKILL.md"))).toBe(true);
      expect(fs.lstatSync(path.join(home, ".agents", "skills", "agentera")).isSymbolicLink()).toBe(false);
      expect(fs.readdirSync(path.join(home, ".agents", "skills", "agentera"))).toEqual(["SKILL.md"]);
      if (interruptedEffect === "initialize:fresh-v3") {
        const canonicalInstall = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-fresh-install-"));
        roots.push(canonicalInstall);
        applyAppContentRefresh(canonicalInstall, resolveSourceRoot());
        expect(fs.readdirSync(path.join(install, ".agentera"))).toEqual(["runtime-lifecycle"]);
        expect(snapshot(install, [".agentera"])).toBe(snapshot(canonicalInstall, [".agentera"]));
      }
    }
  });

  it.each([
    ["addition", (install: string) => fs.writeFileSync(path.join(install, "added-after-interruption.txt"), "new\n")],
    ["change", (install: string) => fs.writeFileSync(path.join(install, "owned.txt"), "changed\n")],
  ])("rejects a target %s after interruption before retry effects", (_name, mutate) => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-profile-"));
    roots.push(home, install, profile);
    fs.writeFileSync(path.join(install, "owned.txt"), "approved\n");
    fs.writeFileSync(path.join(profile, "state"), "preserve-until-validation-passes\n");
    const options = {
      project: root,
      installRoot: install,
      home,
      env: { ...process.env, AGENTERA_PROFILE_DIR: profile },
    };
    const preview = previewProductV1Reset(options);
    expect(() =>
      applyProductV1Reset(options, preview.authorization, {
        afterEffect(effect) {
          if (effect === "journal") throw new Error("interrupted after journal");
        },
      }),
    ).toThrow("interrupted after journal");

    mutate(install);
    expect(() => applyProductV1Reset(options, preview.authorization)).toThrow(/new or changed|changed after approval/);
    expect(fs.existsSync(path.join(root, ".agentera", "PROGRESS.md"))).toBe(true);
    expect(fs.readFileSync(path.join(profile, "state"), "utf8")).toBe("preserve-until-validation-passes\n");
  });

  it("recovers a truncated journal only while the approved preview is still current", () => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-profile-"));
    roots.push(home, install, profile);
    const options = {
      project: root,
      installRoot: install,
      home,
      env: { ...process.env, AGENTERA_PROFILE_DIR: profile },
    };
    const preview = previewProductV1Reset(options);
    expect(() =>
      applyProductV1Reset(options, preview.authorization, {
        afterEffect(effect) {
          if (effect === "journal") throw new Error("interrupted after journal");
        },
      }),
    ).toThrow("interrupted after journal");
    fs.writeFileSync(path.join(root, ".agentera-product-v1-reset.json"), "{\n");

    expect(applyProductV1Reset(options, preview.authorization)).toMatchObject({
      status: "complete",
    });
    expect(fs.existsSync(path.join(root, ".agentera-product-v1-reset.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera-product-v1-reset.json.staging"))).toBe(false);
    expect(classifyProjectState(root).state).toBe("fresh_uninitialized");
  });

  it("rejects a truncated journal after deletion began without continuing effects", () => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-profile-"));
    roots.push(home, install, profile);
    fs.writeFileSync(path.join(profile, "state"), "must-remain\n");
    const options = {
      project: root,
      installRoot: install,
      home,
      env: { ...process.env, AGENTERA_PROFILE_DIR: profile },
    };
    const preview = previewProductV1Reset(options);
    expect(() =>
      applyProductV1Reset(options, preview.authorization, {
        afterEffect(effect) {
          if (effect === "delete:project.state:.agentera") throw new Error("interrupted after deletion");
        },
      }),
    ).toThrow("interrupted after deletion");
    fs.writeFileSync(path.join(root, ".agentera-product-v1-reset.json"), "{\n");

    expect(() => applyProductV1Reset(options, preview.authorization)).toThrow("cannot be recovered after effects may have begun");
    expect(fs.readFileSync(path.join(profile, "state"), "utf8")).toBe("must-remain\n");
  });
});

describe("bounded product v1 reset preview", () => {
  it("keeps the worst-case default preview within 8 KiB while naming every user-data entry by path", () => {
    const { project, home, install, userData } = worstCaseHome();
    const preview = withRootEnv(null, () => resetPreview(project, home, install));
    expect(preview.rc).toBe(0);
    expect(preview.bytes).toBeLessThanOrEqual(8192);
    expect(preview.value).toMatchObject({ detail: "summary", name_limit: 12 });
    expect(userDataPaths(preview.value).sort()).toEqual([...userData].sort());
    expect(preview.value.user_data.find((entry: { path: string }) => entry.path === "sessions")).toEqual({ kind: "sessions", root: "profile_root", path: "sessions", type: "directory", entry_count: 201 });
    const profile = preview.value.deletions.find(({ id }: { id: string }) => id === "profile.state");
    expect(Object.keys(profile.entries)).toHaveLength(12);
    expect(profile.omitted_count).toBeGreaterThan(0);
    expect(Object.values(profile.entries).every((count) => typeof count === "number" && count > 0)).toBe(true);
    expect(Object.keys(profile.entries).some((name) => userData.includes(path.join(install, name)))).toBe(false);
    expect(preview.value.deletions.find(({ id }: { id: string }) => id === "runtime.resources").omitted_count).toBeGreaterThan(0);
    expect(preview.out).not.toContain("session-0001-with-a-longer-name.jsonl");
  });

  it("stays within 8 KiB with 150-character split roots that both hold user data, naming every user-data entry", () => {
    const { project, home, install, profile, userData } = worstCaseHome({ long: 150, split: true });
    expect(Math.min(project.length, home.length, install.length, profile!.length)).toBeGreaterThanOrEqual(150);
    const preview = withRootEnv(profile, () => resetPreview(project, home, install));
    expect(preview.rc).toBe(0);
    expect(preview.bytes).toBeLessThanOrEqual(8192);
    expect(preview.value.roots).toEqual({ project, profile_root: profile, install_root: install, runtime_home: home });
    expect(userDataPaths(preview.value).sort()).toEqual([...userData].sort());
    expect(preview.value.user_data).toHaveLength(16);
    expect(preview.value.name_limit).toBe(0);
    for (const deletion of preview.value.deletions) expect(deletion.entries).toEqual({});
    expect(preview.value.deletions.find(({ id }: { id: string }) => id === "profile.state").omitted_count).toBeGreaterThan(12);
    expect(preview.out.split(install).length - 1).toBe(3);
    expect(preview.out).toContain("\n  ");
    const full = withRootEnv(profile, () => resetPreview(project, home, install, ["--full-detail"])).value;
    expect(full.authorization).toBe(preview.value.authorization);
  });

  it("drops indentation last when 250-character split roots still exceed 8 KiB without names", () => {
    const { project, home, install, profile, userData } = worstCaseHome({ long: 250, split: true });
    const preview = withRootEnv(profile, () => resetPreview(project, home, install));
    expect(preview.rc).toBe(0);
    expect(preview.bytes).toBeLessThanOrEqual(8192);
    expect(preview.out.trimEnd()).not.toContain("\n");
    expect(preview.value.name_limit).toBe(0);
    expect(userDataPaths(preview.value).sort()).toEqual([...userData].sort());
    expect(preview.value.apply_command).toContain(`--project ${project} --home ${home} --install-root ${install} --yes`);
  });

  it("omits nothing from a scope with at most 12 top-level names", () => {
    const project = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-small-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-small-app-"));
    roots.push(home, install);
    for (let i = 0; i < 12; i++) writeFile(path.join(install, `entry-${String(i).padStart(2, "0")}`));
    const preview = withRootEnv(null, () => resetPreview(project, home, install));
    const profile = preview.value.deletions.find(({ id }: { id: string }) => id === "profile.state");
    expect(profile).toMatchObject({ omitted_count: 0, entry_count: 13 });
    expect(Object.keys(profile.entries)).toHaveLength(12);
    expect(preview.value.user_data).toEqual([]);
  });

  it("lists a tree shared by identical profile and installation roots once", () => {
    const { project, home, install } = worstCaseHome();
    const summary = withRootEnv(null, () => resetPreview(project, home, install)).value;
    expect(summary.roots.profile_root).toBe(summary.roots.install_root);
    expect(summary.deletions.find(({ id }: { id: string }) => id === "installation.state")).toEqual({ id: "installation.state", root: "install_root", entry_count: 0, shared_with: "profile.state", entries: {}, omitted_count: 0 });
    const full = withRootEnv(null, () => resetPreview(project, home, install, ["--full-detail"]));
    const sample = path.join(install, "sessions", "session-0001-with-a-longer-name.jsonl");
    expect(full.out.split(`"${sample}"`).length - 1).toBe(1);
    expect(full.value.deletions.find(({ id }: { id: string }) => id === "installation.state").targets).toEqual([{ declared: ".", operation: "remove_path", path: install, shared_with: "profile.state" }]);
  });

  it("lists separate profile and installation roots under their own scopes", () => {
    const project = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-split-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-split-app-"));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-split-profile-"));
    roots.push(home, install, profile);
    writeFile(path.join(install, "skills", "SKILL.md"));
    writeFile(path.join(profile, "PROFILE.md"));
    const preview = withRootEnv(profile, () => resetPreview(project, home, install)).value;
    const byId = Object.fromEntries(preview.deletions.map((item: { id: string }) => [item.id, item]));
    expect(byId["installation.state"]).not.toHaveProperty("shared_with");
    expect(byId["installation.state"].entries).toEqual({ skills: 2 });
    expect(preview.user_data).toEqual([{ kind: "profile", root: "profile_root", path: "PROFILE.md", type: "file", entry_count: 1 }]);
    expect(preview.deletions.map(({ id, root }: { id: string; root: string }) => [id, root])).toEqual([
      ["project.state", "project"],
      ["profile.state", "profile_root"],
      ["installation.state", "install_root"],
      ["runtime.resources", "runtime_home"],
    ]);
    expect(JSON.stringify(preview)).not.toContain(`"root":"${install}"`);
  });

  it("lists every deleted entry only with --full-detail and advertises the option", () => {
    const { project, home, install } = worstCaseHome();
    const internal = withRootEnv(null, () => previewProductV1Reset({ project, home, installRoot: install }));
    const full = withRootEnv(null, () => resetPreview(project, home, install, ["--full-detail"])).value;
    expect(full.detail).toBe("full");
    expect(full).not.toHaveProperty("full_detail_command");
    const listed = new Set(full.deletions.flatMap((item: { targets: Array<{ entries?: Array<{ path: string }> }> }) => item.targets.flatMap((target) => (target.entries ?? []).map((entry) => entry.path))));
    const deleted = internal.deletions.flatMap((item) => item.targets.flatMap((target) => (target.entries ?? []).filter((entry) => entry.type !== "absent").map((entry) => entry.path)));
    expect(deleted.length).toBeGreaterThan(1000);
    expect(deleted.every((entry) => listed.has(entry))).toBe(true);
    const summary = withRootEnv(null, () => resetPreview(project, home, install)).value;
    expect(summary.full_detail_command).toBe(`npx -y agentera@next upgrade --reset-product-v1 --project ${project} --home ${home} --install-root ${install} --dry-run --full-detail --format json`);

    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-help-"));
    roots.push(clean);
    expect(run(clean, ["upgrade", "--help"]).out).toContain("--full-detail");
    const explain = run(clean, ["upgrade", "--explain", "--operation", "reset", "--section", "usage", "--limit", "20", "--format", "json"]);
    expect(explain.rc).toBe(0);
    expect(explain.out).toContain("--dry-run --full-detail");
  });

  it.each([
    ["apply", ["--yes", "--authorization", "sha256:0"]],
    ["ordinary upgrade", null],
  ])("rejects --full-detail outside the reset preview: %s", (_name, extra) => {
    const { project, home, install } = worstCaseHome();
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-ordinary-"));
    roots.push(clean);
    const args = extra === null ? ["upgrade", "--project", clean, "--dry-run", "--full-detail", "--format", "json"] : ["upgrade", "--reset-product-v1", "--project", project, "--install-root", install, "--home", home, ...extra, "--full-detail", "--format", "json"];
    const before = [snapshot(project), snapshot(home)];
    const result = withRootEnv(null, () => run(project, args));
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out).error).toMatchObject({ class: "invalid_request", message: expect.stringContaining("--full-detail") });
    expect([snapshot(project), snapshot(home)]).toEqual(before);
  });

  it("binds every deleted entry, named or not, to the default preview authorization", () => {
    const { project, home, install } = worstCaseHome();
    const summary = withRootEnv(null, () => resetPreview(project, home, install)).value;
    const full = withRootEnv(null, () => resetPreview(project, home, install, ["--full-detail"])).value;
    expect(summary.authorization).toBe(full.authorization);
    const unnamed = path.join(install, "vendor", "sub-3", "file-8.md");
    expect(JSON.stringify(summary)).not.toContain(unnamed);
    fs.writeFileSync(unnamed, "changed after review\n");
    const apply = (authorization: string) => withRootEnv(null, () => run(project, ["upgrade", "--reset-product-v1", "--project", project, "--home", home, "--install-root", install, "--yes", "--authorization", authorization, "--format", "json"]));
    const stale = apply(summary.authorization);
    expect(stale.rc).toBe(2);
    expect(JSON.parse(stale.out).error.message).toContain("scope changed after preview");
    expect(fs.existsSync(path.join(install, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".agentera", "PROGRESS.md"))).toBe(true);

    const reviewed = withRootEnv(null, () => resetPreview(project, home, install)).value;
    expect(apply(reviewed.authorization).rc).toBe(0);
    expect(fs.existsSync(unnamed)).toBe(false);
    expect(fs.existsSync(path.join(install, "sessions"))).toBe(false);
  });

  it("names deleted user data in plain words and points recovery through the previous major version", () => {
    const { project, home, install } = worstCaseHome();
    const preview = withRootEnv(null, () => resetPreview(project, home, install)).value;
    expect(preview.question).toBe("This permanently deletes every listed reset target, including your Agentera profile, saved profile copies and history, usage report, sessions, benchmarks, and extracted evidence, then recreates fresh v3 state. There is no backup or undo. Apply exactly this reset?");
    expect(preview.question).not.toMatch(/user_data|profile\.state|scope/);
    expect(preview.recovery).toContain("upgrade through the previous major version first");
    expect(preview.recovery).toContain("Agentera 2.x");
  });

  it("keeps the generic question and recovery when no user data is deleted", () => {
    const project = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-nodata-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reset-nodata-app-"));
    roots.push(home, install);
    const preview = withRootEnv(null, () => resetPreview(project, home, install)).value;
    expect(preview.user_data).toEqual([]);
    expect(preview.question).toContain("including any current data within those scopes");
    expect(preview.recovery).not.toContain("previous major version");
  });

  it("draws user data only from the handoff catalog and doctor's preserved user state", () => {
    expect(PRODUCT_V1_RESET_USER_DATA_NAMES).toEqual(expect.arrayContaining([...PROFILE_FILE_MEMBERS, ...USER_DATA_CATALOG_DIRS]));
    expect(PRODUCT_V1_RESET_USER_DATA_NAMES.every((name) => ROOT_USER_STATE_FILE_NAMES.has(name) || ROOT_USER_STATE_DIR_NAMES.has(name))).toBe(true);
    expect(PRODUCT_V1_RESET_USER_DATA_NAMES).not.toEqual(expect.arrayContaining(["TODO.md"]));
  });
});
