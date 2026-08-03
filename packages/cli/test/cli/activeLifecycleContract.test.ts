import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; home: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-active-lifecycle-"));
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(project, ".agentera", "state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  return { root, home, project };
}

function capture(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  });
  return { rc, out, err };
}

function tree(root: string): string[] {
  return fs.readdirSync(root, { recursive: true }).map(String).sort();
}

describe("active shared-skill lifecycle contract", () => {
  it("documents app upgrade, v2 migration, and explicit native resource cleanup without current runtime selectors", () => {
    const help = capture(["upgrade", "--help"]);
    expect(help.rc).toBe(0);
    expect(help.out).not.toContain("--runtime");
    expect(help.out).toContain("~/.agents/skills/agentera");
    expect(help.out).toContain("v2-to-v3 development upgrade");
    expect(help.out).toContain("--legacy-cleanup RESOURCE_ID");

    const doctorHelp = capture(["doctor", "--help"]);
    expect(doctorHelp.rc).toBe(0);
    expect(doctorHelp.out).toContain("Home directory for shared-skill diagnosis");
    expect(doctorHelp.out).toContain("app, project-state, shared-skill, and CLI evidence");
    expect(doctorHelp.out).not.toContain("runtime detection");
  });

  it("reports shared-skill and CLI state without a native runtime lifecycle projection", () => {
    const { home, project } = fixture();
    const previous = process.cwd();
    process.chdir(project);
    try {
      const doctor = capture([
        "doctor", "--home", home, "--install-root", REPO_ROOT, "--project", project, "--format", "json",
      ]);
      expect(doctor.rc).toBeGreaterThanOrEqual(0);
      const doctorPayload = JSON.parse(doctor.out) as Record<string, unknown>;
      expect(doctorPayload).toHaveProperty("shared_skill");
      expect(doctorPayload).not.toHaveProperty("runtime_lifecycle");

      const prime = capture(["prime", "--format", "json"]);
      expect(prime.rc).toBe(0);
      const primePayload = JSON.parse(prime.out) as Record<string, unknown>;
      expect(primePayload).toHaveProperty("shared_skill");
      expect(primePayload).not.toHaveProperty("runtime_lifecycle");
      expect(JSON.stringify(primePayload.project_integration)).not.toContain("pending_runtime");

      const schema = capture(["schema", "--format", "json"]);
      expect(schema.rc).toBe(0);
      const schemaPayload = JSON.parse(schema.out) as Record<string, unknown>;
      expect(schemaPayload).toHaveProperty("integration.shared_skill.path", "~/.agents/skills/agentera");
      expect(schemaPayload).toHaveProperty(
        "integration.authority",
        "skills/agentera/SKILL.md",
      );
      expect(schemaPayload).not.toHaveProperty("runtime_lifecycle");
      expect(JSON.stringify(schemaPayload)).not.toMatch(/current_runtime_selectors|current_native_resource_operations/);
    } finally {
      process.chdir(previous);
    }
  });

  it("rejects retired runtime selectors before mutation with the shared-skill correction", () => {
    const { root, home, project } = fixture();
    const before = tree(root);
    const result = capture([
      "upgrade", "--runtime", "cursor", "--home", home, "--project", project, "--yes", "--format", "json",
    ]);
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    expect(result.out).toContain("retired");
    expect(result.out).toContain("~/.agents/skills/agentera");
    expect(result.out).toContain("Remove --runtime");
    expect(tree(root)).toEqual(before);
  });

  it("keeps normal preview/apply native-resource-free and native cleanup explicitly reachable", () => {
    const { root, home, project } = fixture();
    const forbidden = [".opencode", ".codex", ".cursor", ".github", ".claude-plugin"];
    for (const approval of ["--dry-run", "--yes"] as const) {
      const result = capture([
        "upgrade", "--home", home, "--install-root", REPO_ROOT, "--project", project,
        approval, "--format", "json",
      ]);
      expect([0, 1]).toContain(result.rc);
      if (result.out) expect(JSON.parse(result.out)).toHaveProperty("lifecycle", null);
      for (const entry of forbidden) expect(fs.existsSync(path.join(home, entry))).toBe(false);
    }

    const cleanup = capture([
      "upgrade", "--legacy-cleanup", "claude.agentera-skill-link", "--home", home, "--install-root", REPO_ROOT,
      "--project", project, "--dry-run", "--format", "json",
    ]);
    expect(cleanup.rc).toBe(0);
    const cleanupPayload = JSON.parse(cleanup.out);
    expect(cleanupPayload).toHaveProperty("lifecycle.nativeResourceCleanup.resourceId", "claude.agentera-skill-link");
    expect(cleanupPayload.lifecycle).not.toHaveProperty("selection");
    expect(cleanupPayload.lifecycle).not.toHaveProperty("projection");
    expect(cleanupPayload.lifecycle).not.toHaveProperty("operations");
    expect(cleanupPayload.lifecycle).not.toHaveProperty("userActions");
  });
});
