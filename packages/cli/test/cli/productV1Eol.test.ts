import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { resolveSourceRoot } from "../../src/core/sourceRoot.js";
import { loadNativeResourceCleanupContract } from "../../src/runtime/nativeResourceCleanup.js";
import { applyProductV1Reset, authorizeProductV1Reset, previewProductV1Reset } from "../../src/upgrade/productV1Reset.js";
import { classifyProjectState } from "../../src/state/stateMode.js";
import { applyAppContentRefresh } from "../../src/upgrade/appContentRefresh.js";

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

function snapshot(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
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
      out: (text) => { out += text; },
      err: (text) => { err += text; },
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("product v1 EOL execution gate", () => {
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

  it("previews every bounded reset effect and authorizes only the unchanged reviewed scope", () => {
    const root = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-home-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-profile-"));
    roots.push(home, install, profile);
    const previousProfile = process.env.AGENTERA_PROFILE_DIR;
    process.env.AGENTERA_PROFILE_DIR = profile;
    try {
      const args = [
        "upgrade", "--reset-product-v1", "--project", root, "--install-root", install,
        "--home", home, "--dry-run", "--format", "json",
      ];
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
      expect(preview.deletions.map((item: { id: string }) => item.id)).toEqual([
        "project.state", "profile.state", "installation.state", "runtime.resources",
      ]);
      expect(preview.recreations.map((item: { id: string }) => item.id)).toEqual([
        "project.fresh-v3", "installation.current-package", "runtime.canonical-skill",
      ]);
      expect(preview.deletions.every((item: { targets: unknown[] }) => item.targets.length > 0)).toBe(true);
      expect(preview.irreversible_loss).toHaveLength(4);
      expect(preview.authorization).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect([snapshot(root), snapshot(home), snapshot(install), snapshot(profile)]).toEqual(before);

      fs.writeFileSync(path.join(root, ".agentera", "new-state.yaml"), "changed: true\n");
      const changed = snapshot(root);
      const stale = run(root, [
        "upgrade", "--reset-product-v1", "--project", root, "--install-root", install,
        "--home", home, "--yes", "--authorization", preview.authorization, "--format", "json",
      ]);
      expect(stale.rc).toBe(2);
      expect(JSON.parse(stale.out).error.message).toContain("scope changed after preview");
      expect(snapshot(root)).toBe(changed);

      const freshPreview = JSON.parse(run(root, args).out);
      const authorized = run(root, [
        "upgrade", "--reset-product-v1", "--project", root, "--install-root", install,
        "--home", home, "--yes", "--authorization", freshPreview.authorization, "--format", "json",
      ]);
      expect(authorized.rc).toBe(0);
      expect(JSON.parse(authorized.out)).toMatchObject({ status: "complete", effects_performed: true });
      expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("user owned\n");
      expect(fs.existsSync(path.join(root, ".agentera"))).toBe(false);
      expect(classifyProjectState(root).state).toBe("fresh_uninitialized");
      expect(fs.existsSync(profile)).toBe(false);
      expect(fs.existsSync(path.join(install, "skills", "agentera", "SKILL.md"))).toBe(true);
      expect(fs.realpathSync(path.join(home, ".agents", "skills", "agentera"))).toBe(
        fs.realpathSync(path.join(install, "skills", "agentera")),
      );
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

    const preview = run(root, [
      "upgrade", "--reset-product-v1", "--project", root, "--install-root", install,
      "--home", home, "--dry-run", "--format", "json",
    ]);
    expect(preview.rc).toBe(0);
    const serialized = preview.out;
    expect(serialized).toContain(path.join(root, ".agentera", "external-link"));
    expect(serialized).not.toContain(path.join(external, "keep.txt"));

    const alias = run(root, [
      "upgrade", "--reset-product-v1", "--project", root, "--install-root", installAlias,
      "--home", home, "--dry-run", "--format", "json",
    ]);
    expect(alias.rc).toBe(2);
    expect(JSON.parse(alias.out).error.message).toContain("must not be a symbolic link");
    expect(fs.readFileSync(path.join(external, "keep.txt"), "utf8")).toBe("external\n");
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
    fs.writeFileSync(config, [
      "[plugins.unrelated]",
      'command = "keep-me"',
      "",
      '[plugins."agentera@agentera"]',
      'command = "legacy-agentera"',
      "",
    ].join("\n"));
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
    expect(configTargets.every((target) =>
      target.operation === "remove_in_file_selector"
      && target.selector !== undefined
      && target.entries === undefined
      && target.file_state?.type === "file"
    )).toBe(true);
    expect(configTargets).toContainEqual(expect.objectContaining({
      selector: { kind: "contains", value: '[plugins."agentera@agentera"]' },
    }));
    expect(JSON.stringify(configTargets)).not.toContain("keep-me");

    fs.appendFileSync(config, "[plugins.still_unrelated]\nenabled = true\n");
    expect(() => authorizeProductV1Reset(options, preview.authorization)).toThrow("scope changed after preview");

    const reviewed = previewProductV1Reset(options);
    const changedContract = structuredClone(loadNativeResourceCleanupContract());
    const selected = changedContract.diagnosticResources.find((resource) => resource.contains !== null)!;
    selected.contains = `${selected.contains}.changed`;
    expect(() => authorizeProductV1Reset(
      options,
      reviewed.authorization,
      { runtimeContract: changedContract },
    )).toThrow("scope changed after preview");

    const authorized = authorizeProductV1Reset(options, reviewed.authorization);
    const validatedRuntime = authorized.validated_scope.deletions.find(({ id }) => id === "runtime.resources")!;
    expect(validatedRuntime.targets.filter((target) => target.path === config)).toEqual(configTargets.map((target) => ({
      ...target,
      file_state: expect.objectContaining({ type: "file" }),
    })));
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
      expect(() => applyProductV1Reset(options, preview.authorization, {
        afterEffect(effect) {
          if (!interrupted && (effect === interruptedEffect || (interruptedEffect === "selector-staged" && effect === `selector-staged:${config}`))) {
            interrupted = true;
            throw new Error(`interrupted after ${interruptedEffect}`);
          }
        },
      })).toThrow(`interrupted after ${interruptedEffect}`);

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
      expect(fs.readFileSync(config, "utf8")).toBe([
        "[plugins.unrelated]",
        'command = "keep-me"',
        "",
        "[plugins.after] # adjacent unrelated section",
        'command = "keep-after"',
        "",
        "[shell_environment_policy.set]",
        'KEEP = "yes"',
        "",
      ].join("\n"));
      expect(fs.existsSync(path.join(install, "skills", "agentera", "SKILL.md"))).toBe(true);
      expect(fs.realpathSync(path.join(home, ".agents", "skills", "agentera"))).toBe(
        fs.realpathSync(path.join(install, "skills", "agentera")),
      );
      if (interruptedEffect === "initialize:fresh-v3") {
        const canonicalInstall = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-fresh-install-"));
        roots.push(canonicalInstall);
        applyAppContentRefresh(canonicalInstall, resolveSourceRoot());
        expect(snapshot(install)).toBe(snapshot(canonicalInstall));
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
    const options = { project: root, installRoot: install, home, env: { ...process.env, AGENTERA_PROFILE_DIR: profile } };
    const preview = previewProductV1Reset(options);
    expect(() => applyProductV1Reset(options, preview.authorization, {
      afterEffect(effect) { if (effect === "journal") throw new Error("interrupted after journal"); },
    })).toThrow("interrupted after journal");

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
    const options = { project: root, installRoot: install, home, env: { ...process.env, AGENTERA_PROFILE_DIR: profile } };
    const preview = previewProductV1Reset(options);
    expect(() => applyProductV1Reset(options, preview.authorization, {
      afterEffect(effect) { if (effect === "journal") throw new Error("interrupted after journal"); },
    })).toThrow("interrupted after journal");
    fs.writeFileSync(path.join(root, ".agentera-product-v1-reset.json"), "{\n");

    expect(applyProductV1Reset(options, preview.authorization)).toMatchObject({ status: "complete" });
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
    const options = { project: root, installRoot: install, home, env: { ...process.env, AGENTERA_PROFILE_DIR: profile } };
    const preview = previewProductV1Reset(options);
    expect(() => applyProductV1Reset(options, preview.authorization, {
      afterEffect(effect) { if (effect === "delete:project.state:.agentera") throw new Error("interrupted after deletion"); },
    })).toThrow("interrupted after deletion");
    fs.writeFileSync(path.join(root, ".agentera-product-v1-reset.json"), "{\n");

    expect(() => applyProductV1Reset(options, preview.authorization)).toThrow("cannot be recovered after effects may have begun");
    expect(fs.readFileSync(path.join(profile, "state"), "utf8")).toBe("must-remain\n");
  });
});
