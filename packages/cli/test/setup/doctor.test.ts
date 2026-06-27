import fs from "node:fs";
import { pluginSourceHasUnmigratedProfileDirSchema } from "../../src/core/envPaths.js";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AVAILABILITY_CHECKS,
  CANONICAL_ENTRIES,
  HELPER_ENTRIES,
  INSTALLER_FIXABLE_GAPS,
  RUNTIMES,
  SCHEMA_VERSION,
  aggregateStatus,
  autoDetectInstallRoot,
  classifyInstallRoot,
  mkCheck,
  summarizeStatuses,
  tail,
  verifyHelperAccess,
  verifyInstallRoot,
  binaryPath,
  configuredRootCheck,
  diagnoseBundledReferenceValidation,
  diagnoseOpencodeCommands,
  diagnoseOpencodeProfileDir,
  diagnoseOpencodeProfileDirSchemaLiteral,
  diagnoseOpencodeSkillPaths,
  extractReferencePaths,
  hasManagedMarker,
  normalizeReference,
  opencodeCommandTemplate,
  runtimeResult,
  runtimeSkip,
  which,
  DIAGNOSTICS,
  diagnoseClaude,
  diagnoseCodex,
  diagnoseCursor,
  readCodexAgenteraHome,
  buildReport,
  buildInstallerPlan,
  doctorMain,
  pyJsonIndent,
  renderHuman,
} from "../../src/setup/doctor.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-doctor-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedRoot(root: string, _withHelper = true): void {
  // Node-era managed app: app data surfaces (no Python scripts/hooks).
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "s");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "x" }] }));
}

describe("setup doctor: registry-derived constants", () => {
  it("exposes the doctor schema + runtime roster", () => {
    expect(SCHEMA_VERSION).toBe("agentera.setupDoctor.v1");
    expect(RUNTIMES).toContain("claude");
    expect(RUNTIMES).toContain("codex");
    expect(Object.keys(AVAILABILITY_CHECKS).sort()).toEqual([...RUNTIMES].sort());
    expect(INSTALLER_FIXABLE_GAPS.copilot).toHaveLength(2);
    expect(HELPER_ENTRIES).toEqual([]);
    expect(CANONICAL_ENTRIES.length).toBeGreaterThan(0);
  });
});

describe("setup doctor: install-root classification", () => {
  it("passes a valid managed root with helper scripts", () => {
    const root = path.join(tmp, "ok");
    managedRoot(root);
    const c = classifyInstallRoot(root, {});
    expect(c.status).toBe("pass");
    expect(c.kind).toBe("installed-bundle");
    expect(verifyInstallRoot(root)).toEqual([]);
    expect(verifyHelperAccess(root)).toEqual([]);
  });

  it("fails a root missing canonical Agentera entries", () => {
    const root = path.join(tmp, "nodata");
    fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "s");
    // registry.json missing -> not a managed root.
    const c = classifyInstallRoot(root, {});
    expect(c.status).toBe("fail");
    expect(c.gap).toBe("bundle_packaging");
    expect(c.missing).toContain("registry.json");
  });

  it("fails an invalid root", () => {
    const root = path.join(tmp, "invalid");
    fs.mkdirSync(root);
    const c = classifyInstallRoot(root, {});
    expect(c.status).toBe("fail");
    expect(c.kind).toBeNull();
  });

  it("resolves via AGENTERA_HOME env fallback", () => {
    const root = path.join(tmp, "envroot");
    managedRoot(root);
    expect(autoDetectInstallRoot({ AGENTERA_HOME: root })).toBe(fs.realpathSync.native(root));
    const c = classifyInstallRoot(null, { AGENTERA_HOME: root });
    expect(c.status).toBe("pass");
    expect(c.source).toBe("auto");
  });
});

describe("setup doctor: aggregation helpers", () => {
  it("aggregates statuses with fail>warn>pass>skip precedence", () => {
    expect(aggregateStatus([])).toBe("skip");
    expect(aggregateStatus([{ status: "skip" }])).toBe("skip");
    expect(aggregateStatus([{ status: "pass" }, { status: "fail" }])).toBe("fail");
    expect(aggregateStatus([{ status: "pass" }, { status: "warn" }])).toBe("warn");
  });

  it("summarizes status counts across all buckets", () => {
    expect(summarizeStatuses([{ status: "pass" }, { status: "pass" }, { status: "fail" }])).toEqual({
      pass: 2,
      warn: 0,
      fail: 1,
      skip: 0,
    });
  });

  it("tails non-empty lines", () => {
    expect(tail("a\n\n b \nc\n\nd\n", 2)).toEqual(["c", "d"]);
  });

  it("builds a check record with defaults", () => {
    expect(mkCheck("n", "pass", "ok")).toEqual({
      name: "n",
      status: "pass",
      message: "ok",
      source: null,
      path: null,
      gap: null,
      details: [],
    });
  });
});


describe("setup doctor: runtime detection", () => {
  it("finds an executable on PATH (which) and skips when absent", () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const exe = path.join(bin, "codex");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    fs.chmodSync(exe, 0o755);
    expect(which("codex", bin)).toBe(exe);
    expect(binaryPath("codex", { PATH: bin })).toBe(exe);
    expect(binaryPath("codex", { PATH: "/nonexistent" })).toBeNull();
    const skip = runtimeSkip("codex", { PATH: "/x" });
    expect(skip.available).toBe(false);
    expect(skip.status).toBe("skip");
  });

  it("assembles a runtime result with the binary check first", () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const exe = path.join(bin, "codex");
    fs.writeFileSync(exe, "x");
    fs.chmodSync(exe, 0o755);
    const r = runtimeResult("codex", { PATH: bin }, []);
    expect(r.available).toBe(true);
    expect(r.binary).toBe(exe);
    expect(r.checks).toHaveLength(1);
  });

  it("warns when the configured root differs from the install root", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    managedRoot(a);
    managedRoot(b);
    const c = configuredRootCheck("codex", "codex.home", a, b, "env");
    expect(c.status).toBe("warn");
  });
});

describe("setup doctor: OpenCode diagnostics", () => {
  it("renders a managed command template and detects its marker", () => {
    const tpl = opencodeCommandTemplate("agentera");
    expect(tpl).toContain("agentera_managed: true");
    expect(hasManagedMarker(tpl)).toBe(true);
    expect(hasManagedMarker("no frontmatter")).toBe(false);
  });

  it("passes when the managed command file is current", () => {
    const home = path.join(tmp, "home");
    const cmds = path.join(home, ".config", "opencode", "commands");
    fs.mkdirSync(cmds, { recursive: true });
    fs.writeFileSync(path.join(cmds, "agentera.md"), opencodeCommandTemplate("agentera"));
    const c = diagnoseOpencodeCommands(home, {});
    expect(c.status).toBe("pass");
  });

  it("warns when the managed command is missing", () => {
    const home = path.join(tmp, "home2");
    fs.mkdirSync(path.join(home, ".config", "opencode", "commands"), { recursive: true });
    const c = diagnoseOpencodeCommands(home, {});
    expect(c.status).toBe("warn");
    expect(c.details).toContain("missing: agentera");
  });

  it("passes skill paths when the symlink resolves to a SKILL.md", () => {
    const root = path.join(tmp, "root");
    fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "s");
    const home = path.join(tmp, "h");
    const skills = path.join(home, ".config", "opencode", "skills");
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(path.join(root, "skills", "agentera"), path.join(skills, "agentera"));
    const c = diagnoseOpencodeSkillPaths(root, home, {});
    expect(c.status).toBe("pass");
  });

  describe("profile_dir_deprecated", () => {
    it("warns when the deprecated PROFILERA_PROFILE_DIR env var is set", () => {
      const c = diagnoseOpencodeProfileDir(path.join(tmp, "root"), path.join(tmp, "home"), {
        PROFILERA_PROFILE_DIR: "/legacy/profile",
      });
      expect(c.status).toBe("warn");
      expect(c.name).toBe("profile_dir_deprecated");
      expect(c.message).toContain("PROFILERA_PROFILE_DIR");
      expect(c.message).toContain("agentera upgrade");
      expect(c.message).toContain("AGENTERA_PROFILE_DIR");
      expect(c.gap).toBe("user_environment");
    });

    it("passes when only AGENTERA_PROFILE_DIR is set (canonical v3 name)", () => {
      const c = diagnoseOpencodeProfileDir(path.join(tmp, "root"), path.join(tmp, "home"), {
        AGENTERA_PROFILE_DIR: "/v3/profile",
      });
      expect(c.status).toBe("pass");
      expect(c.name).toBe("profile_dir_deprecated");
      expect(c.message).toBe("profile dir env var is current");
      expect(c.gap).toBeNull();
    });

    it("passes when neither profile-dir env var is set", () => {
      const c = diagnoseOpencodeProfileDir(path.join(tmp, "root"), path.join(tmp, "home"), {});
      expect(c.status).toBe("pass");
      expect(c.name).toBe("profile_dir_deprecated");
      expect(c.message).toBe("profile dir env var is current");
      expect(c.gap).toBeNull();
    });
  });

  describe("profile_dir_schema_literal", () => {
    function writeOpencodePlugin(home: string, source: string): string {
      const pluginDir = path.join(home, ".config", "opencode", "plugins");
      fs.mkdirSync(pluginDir, { recursive: true });
      const pluginPath = path.join(pluginDir, "agentera.js");
      fs.writeFileSync(pluginPath, source);
      return pluginPath;
    }

    it("predicate flags PROFILERA-only source and accepts migrated dual-name source", () => {
      expect(pluginSourceHasUnmigratedProfileDirSchema("process.env.PROFILERA_PROFILE_DIR")).toBe(true);
      expect(pluginSourceHasUnmigratedProfileDirSchema("process.env.AGENTERA_PROFILE_DIR")).toBe(false);
      expect(
        pluginSourceHasUnmigratedProfileDirSchema(
          "process.env.AGENTERA_PROFILE_DIR || process.env.PROFILERA_PROFILE_DIR",
        ),
      ).toBe(false);
      expect(pluginSourceHasUnmigratedProfileDirSchema("")).toBe(false);
    });

    it("warns when installed plugin source only references PROFILERA_PROFILE_DIR", () => {
      const home = path.join(tmp, "home-schema-unmigrated");
      const pluginPath = writeOpencodePlugin(
        home,
        `function setProfileDir() {
  if (process.env.PROFILERA_PROFILE_DIR) return;
  process.env.PROFILERA_PROFILE_DIR = "/tmp/profile";
}`,
      );
      const c = diagnoseOpencodeProfileDirSchemaLiteral(home, {});
      expect(c.status).toBe("warn");
      expect(c.name).toBe("profile_dir_schema_literal");
      expect(c.message).toContain("agentera upgrade");
      expect(c.message).toContain("AGENTERA_PROFILE_DIR");
      expect(c.message).toContain("PROFILERA_PROFILE_DIR");
      expect(c.path).toBe(pluginPath);
      expect(c.gap).toBe("runtime_config");
    });

    it("passes when installed plugin follows the migrated setProfileDir contract", () => {
      const home = path.join(tmp, "home-schema-migrated");
      writeOpencodePlugin(
        home,
        `function setProfileDir() {
  if (process.env.AGENTERA_PROFILE_DIR) return;
  if (process.env.PROFILERA_PROFILE_DIR) {
    process.env.AGENTERA_PROFILE_DIR = process.env.PROFILERA_PROFILE_DIR;
    return;
  }
  process.env.AGENTERA_PROFILE_DIR = "/default/profile";
}`,
      );
      const c = diagnoseOpencodeProfileDirSchemaLiteral(home, {});
      expect(c.status).toBe("pass");
      expect(c.name).toBe("profile_dir_schema_literal");
      expect(c.message).toBe("OpenCode plugin profile-dir schema is current");
      expect(c.gap).toBeNull();
    });

    it("passes when the OpenCode plugin file is not installed", () => {
      const c = diagnoseOpencodeProfileDirSchemaLiteral(path.join(tmp, "home-no-plugin"), {});
      expect(c.status).toBe("pass");
      expect(c.name).toBe("profile_dir_schema_literal");
      expect(c.gap).toBeNull();
    });
  });
});

describe("setup doctor: reference validation", () => {
  it("extracts and normalizes references", () => {
    expect(extractReferencePaths("a references/guide.md `references/x.md` references/guide.md")).toEqual([
      "references/guide.md",
      "references/x.md",
    ]);
    expect(normalizeReference("references/guide.md).")).toBe("references/guide.md");
    expect(normalizeReference("/abs/x")).toBeNull();
    expect(normalizeReference("references/../x")).toBeNull();
  });

  it("warns on missing bundled references", () => {
    const root = path.join(tmp, "root");
    fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "skills", "agentera", "SKILL.md"),
      "see references/here.md and references/gone.md\n",
    );
    fs.mkdirSync(path.join(root, "skills", "agentera", "references"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "agentera", "references", "here.md"), "x");
    const c = diagnoseBundledReferenceValidation(root);
    expect(c.status).toBe("warn");
    expect(c.details).toContain("agentera: references/gone.md");
  });
});


function fakeBin(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const b of ["claude", "opencode", "copilot", "codex", "cursor", "cursor-agent"]) {
    const f = path.join(dir, b);
    fs.writeFileSync(f, "#!/bin/sh\n");
    fs.chmodSync(f, 0o755);
  }
  return dir;
}

describe("setup doctor: per-runtime diagnostics", () => {
  it("exposes a diagnostics map for every runtime", () => {
    expect(Object.keys(DIAGNOSTICS).sort()).toEqual([...RUNTIMES].sort());
  });

  it("skips a runtime whose binary is absent", () => {
    const root = path.join(tmp, "root");
    managedRoot(root);
    const r = diagnoseClaude(root, path.join(tmp, "h"), {});
    expect(r.status).toBe("skip");
    expect(r.available).toBe(false);
  });

  it("passes claude when CLAUDE_PLUGIN_ROOT points at the install root", () => {
    const root = path.join(tmp, "root");
    managedRoot(root);
    const bin = fakeBin(path.join(tmp, "bin"));
    const r = diagnoseClaude(root, path.join(tmp, "h"), { PATH: bin, CLAUDE_PLUGIN_ROOT: root });
    expect(r.available).toBe(true);
    expect(r.status).toBe("pass");
  });

  it("reads AGENTERA_HOME from a codex config", () => {
    const home = path.join(tmp, "h");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const root = path.join(tmp, "root");
    managedRoot(root);
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      `[shell_environment_policy]\nset = { AGENTERA_HOME = "${root}" }\n`,
    );
    expect(readCodexAgenteraHome(path.join(home, ".codex", "config.toml"))).toEqual([root, null]);
    expect(readCodexAgenteraHome(path.join(home, ".codex", "missing.toml"))).toEqual([null, "missing"]);
    const bin = fakeBin(path.join(tmp, "bin"));
    const r = diagnoseCodex(root, home, { PATH: bin });
    expect(r.status).toBe("pass");
  });

  it("classifies cursor hooks + agents drift", () => {
    const root = path.join(tmp, "root");
    managedRoot(root);
    fs.mkdirSync(path.join(root, ".cursor", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".cursor", "hooks.json"),
      '{"h":["cursor_session_start.py","cursor_pre_tool_use.py"]}',
    );
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, ".cursor", "agents", `a${i}.md`), "x");
    const bin = fakeBin(path.join(tmp, "bin"));
    const r = diagnoseCursor(root, path.join(tmp, "h"), { PATH: bin, AGENTERA_HOME: root });
    expect(r.status).toBe("pass");
    const checkStatuses = (r.checks as Array<{ status: string }>).map((c) => c.status);
    expect(checkStatuses.every((sv) => sv === "pass")).toBe(true);
  });
});


describe("setup doctor: report + CLI", () => {
  function fullRoot(root: string): void {
    managedRoot(root);
    fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "x\n");
  }

  it("builds a report with schema, install root, and per-runtime entries", () => {
    const root = path.join(tmp, "root");
    fullRoot(root);
    const bin = fakeBin(path.join(tmp, "bin"));
    const report = buildReport({
      installRoot: root,
      home: path.join(tmp, "home"),
      env: { PATH: bin, AGENTERA_HOME: root },
    });
    expect(report.schemaVersion).toBe("agentera.setupDoctor.v1");
    expect(report.installRoot.status).toBe("pass");
    expect(Object.keys(report.runtimes).sort()).toEqual([...RUNTIMES].sort());
    expect(typeof report.ok).toBe("boolean");
  });

  it("fails every runtime when the install root is invalid", () => {
    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad);
    const report = buildReport({ installRoot: bad, home: path.join(tmp, "home"), env: {} });
    expect(report.ok).toBe(false);
    expect(report.installRoot.status).toBe("fail");
  });

  it("renders a stable human report and indented JSON", () => {
    const root = path.join(tmp, "root");
    fullRoot(root);
    const report = buildReport({ installRoot: root, home: path.join(tmp, "home"), env: {} });
    expect(renderHuman(report)).toContain("Agentera setup doctor");
    const json = pyJsonIndent(report);
    expect(json.startsWith("{\n")).toBe(true);
    expect(JSON.parse(json).schemaVersion).toBe("agentera.setupDoctor.v1");
  });

  it("plans a codex installer change when the codex config is missing", () => {
    const root = path.join(tmp, "root");
    fullRoot(root);
    const bin = fakeBin(path.join(tmp, "bin"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const env = { PATH: bin, AGENTERA_HOME: root };
    const report = buildReport({ installRoot: root, home, env });
    const plan = buildInstallerPlan(report, { home, env, runtimes: [...RUNTIMES], confirmed: false, dryRun: true });
    const codex = (plan.changes as Array<{ runtime: string; status: string }>).find((c) => c.runtime === "codex");
    expect(codex?.status).toBe("pending");
  });

  it("doctorMain --install --yes writes the codex config", () => {
    const root = path.join(tmp, "root");
    fullRoot(root);
    const bin = fakeBin(path.join(tmp, "bin"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    let out = "";
    const rc = doctorMain(
      ["--install-root", root, "--home", home, "--install", "--yes"],
      { out: (sx) => (out += sx), err: () => {}, env: { PATH: bin, AGENTERA_HOME: root, HOME: home } },
    );
    expect(typeof rc).toBe("number");
    expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
    expect(out).toContain("Agentera setup installer");
  });

  it("buildReport --smoke emits bounded offline smoke checks", () => {
    const root = path.join(tmp, "root");
    fullRoot(root);
    const report = buildReport({
      installRoot: root,
      home: path.join(tmp, "home"),
      env: {},
      runSmoke: true,
    });
    expect(report.smoke.enabled).toBe(true);
    expect(report.smoke.modelCallsAttempted).toBe(false);
    expect((report.smoke.checks as unknown[]).length).toBeGreaterThan(0);
  });
});
