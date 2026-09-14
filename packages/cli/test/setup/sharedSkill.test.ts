import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diagnoseCanonicalSkill } from "../../src/setup/sharedSkill.js";

const checkout = path.resolve(import.meta.dirname, "../../../..");
const posixIt = process.platform === "win32" ? it.skip : it;
let root: string, homePath: string, sourceRoot: string, appHome: string, current: string;

function write(destination: string, content: string) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-shared-skill-"));
  homePath = path.join(root, "home");
  sourceRoot = path.join(root, "runtime");
  appHome = path.join(root, "app");
  fs.mkdirSync(homePath);
  for (const relative of ["registry.json", "references/adapters/package-registry.yaml", "skills/agentera/SKILL.md"]) write(path.join(sourceRoot, relative), fs.readFileSync(path.join(checkout, relative), "utf8"));
  current = fs.readFileSync(path.join(sourceRoot, "skills/agentera/SKILL.md"), "utf8");
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", sourceRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(directory = root): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    const stat = fs.lstatSync(entry);
    entries[name] = {
      device: stat.dev,
      inode: stat.ino,
      content: stat.isSymbolicLink() ? `link:${fs.readlinkSync(entry)}` : stat.isDirectory() ? snapshot(entry) : fs.readFileSync(entry).toString("base64"),
    };
  }
  return entries;
}

function target(): string {
  return path.join(homePath, ".agents", "skills", "agentera");
}

function diagnose(options: Parameters<typeof diagnoseCanonicalSkill>[1] = {}) {
  const before = snapshot();
  const result = diagnoseCanonicalSkill(homePath, options);
  expect(snapshot()).toEqual(before);
  return result;
}

function expectManualRecovery(result: ReturnType<typeof diagnoseCanonicalSkill>) {
  expect(result.details).toEqual(expect.arrayContaining([expect.stringContaining("Preserve the reported destination and ownership journal."), expect.stringContaining("this route never deletes or adopts them"), expect.stringContaining("separate user approval")]));
}

describe("diagnoseCanonicalSkill", () => {
  it.each(["default checkout", "configured checkout", "configured bundle"])("passes a valid current one-file shared skill discovered from %s", (discovery) => {
    if (discovery === "default checkout") vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", undefined);
    if (discovery === "configured bundle") {
      write(path.join(sourceRoot, ".agentera-npx-bundle.json"), "{}");
      // The bundled host surface, not the retained internal skill, owns freshness.
      current += "\nSelected bundled host bootstrap.\n";
      write(path.join(sourceRoot, "host/agentera/SKILL.md"), current);
    }
    write(path.join(target(), "SKILL.md"), current);

    expect(diagnose()).toMatchObject({
      name: "canonical_skill",
      status: "pass",
      path: target(),
      gap: null,
      shape: "one_file",
      compatibility: "compatible",
      freshness: "current",
      runtime_authority: "available",
      ownership: "not_inspected",
      preview_command: `npx -y agentera@next upgrade --shared-skill --home ${homePath} --dry-run`,
      details: [],
    });
  });

  it("warns for a missing target with a scoped read-only install preview", () => {
    const result = diagnose({ appHome });

    expect(result).toMatchObject({
      status: "warn",
      gap: "skill_path_drift",
      shape: "missing",
      compatibility: "unknown",
      freshness: "unknown",
      runtime_authority: "available",
      ownership: "absent",
      preview_command: `npx -y agentera@next upgrade --shared-skill --home ${homePath} --install-root ${appHome} --dry-run`,
    });
    expectManualRecovery(result);
    expect(fs.existsSync(target())).toBe(false);
    expect(fs.existsSync(appHome)).toBe(false);
  });

  it("preserves an existing unrelated target and requests manual review", () => {
    const unrelated = path.join(target(), "SKILL.md");
    write(unrelated, "---\nname: unrelated\n---\n");

    const before = fs.readFileSync(unrelated, "utf8");
    const result = diagnose({ appHome });

    expect(result).toMatchObject({
      status: "warn",
      gap: "skill_path_drift",
      shape: "one_file",
      compatibility: "incompatible",
      freshness: "stale",
      runtime_authority: "available",
      ownership: "blocked",
    });
    expectManualRecovery(result);
    expect(fs.readFileSync(unrelated, "utf8")).toBe(before);
  });

  posixIt("preserves an invalid symlink and requests manual review", () => {
    const unrelated = path.join(homePath, "unrelated-skill");
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "SKILL.md"), "---\nname: unrelated\n---\n");
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.symlinkSync(unrelated, target(), "dir");

    const result = diagnose({ appHome });

    expect(result).toMatchObject({
      status: "warn",
      gap: "skill_path_drift",
      shape: "legacy_symlink",
      compatibility: "unknown",
      freshness: "unknown",
      runtime_authority: "available",
      ownership: "blocked",
    });
    expectManualRecovery(result);
    expect(fs.lstatSync(target()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target())).toBe(unrelated);
    expect(fs.readFileSync(path.join(unrelated, "SKILL.md"), "utf8")).toBe("---\nname: unrelated\n---\n");
  });

  it.each([
    ["unversioned", "---\nname: agentera\n---\n# Agentera\n"],
    ["v2", "---\nname: agentera\nversion: 2.0.0\n---\n# Agentera\n"],
  ])("preserves and warns for an incompatible %s one-file bootstrap", (_kind, content) => {
    write(path.join(target(), "SKILL.md"), content);
    const result = diagnose();
    expect(result).toMatchObject({
      status: "warn",
      shape: "one_file",
      compatibility: "incompatible",
      freshness: "stale",
      runtime_authority: "available",
    });
    expectManualRecovery(result);
  });

  it("distinguishes compatible but stale host bytes from invalid runtime authority", () => {
    write(path.join(target(), "SKILL.md"), current + "\nDifferent host guidance.\n");
    const result = diagnose();
    expect(result).toMatchObject({
      status: "warn",
      shape: "one_file",
      compatibility: "compatible",
      freshness: "stale",
      runtime_authority: "available",
    });
    expectManualRecovery(result);
  });

  it("reports missing selected runtime authority without falling back to the checkout or repairing host bytes", () => {
    write(path.join(target(), "SKILL.md"), current);
    fs.unlinkSync(path.join(sourceRoot, "skills/agentera/SKILL.md"));
    const result = diagnose({ appHome });
    expect(result).toMatchObject({
      status: "warn",
      shape: "one_file",
      compatibility: "compatible",
      freshness: "unknown",
      runtime_authority: "invalid_host_authority",
      ownership: "not_inspected",
    });
    expect(result.details).toContain("Repair the selected CLI distribution/runtime authority; host installation cannot repair package bytes.");
    expectManualRecovery(result);
  });

  it("does not equate current compatible bytes with ownership when an app journal is inspected", () => {
    write(path.join(target(), "SKILL.md"), current);
    const result = diagnose({ appHome });
    expect(result).toMatchObject({
      status: "warn",
      shape: "one_file",
      compatibility: "compatible",
      freshness: "current",
      runtime_authority: "available",
      ownership: "blocked",
    });
    expectManualRecovery(result);
    expect(fs.existsSync(appHome)).toBe(false);
  });
});
