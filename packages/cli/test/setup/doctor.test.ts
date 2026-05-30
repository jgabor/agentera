import fs from "node:fs";
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
} from "../../src/setup/doctor.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-doctor-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedRoot(root: string, withHelper = true): void {
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "validate_capability.py"), "x");
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "s");
  if (withHelper) fs.writeFileSync(path.join(root, "hooks", "validate_artifact.py"), "x");
}

describe("setup doctor: registry-derived constants", () => {
  it("exposes the doctor schema + runtime roster", () => {
    expect(SCHEMA_VERSION).toBe("agentera.setupDoctor.v1");
    expect(RUNTIMES).toContain("claude");
    expect(RUNTIMES).toContain("codex");
    expect(Object.keys(AVAILABILITY_CHECKS).sort()).toEqual([...RUNTIMES].sort());
    expect(INSTALLER_FIXABLE_GAPS.copilot).toHaveLength(2);
    expect(HELPER_ENTRIES).toContain("hooks/validate_artifact.py");
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

  it("fails a managed root that is missing helper scripts", () => {
    const root = path.join(tmp, "nohelper");
    managedRoot(root, false);
    const c = classifyInstallRoot(root, {});
    expect(c.status).toBe("fail");
    expect(c.gap).toBe("bundle_packaging");
    expect(c.missing).toEqual(["hooks/validate_artifact.py"]);
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
