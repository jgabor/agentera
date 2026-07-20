import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diagnoseCanonicalSkill } from "../../src/setup/sharedSkill.js";

const roots: string[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-shared-skill-"));
  roots.push(root);
  return root;
}

function target(homePath: string): string {
  return path.join(homePath, ".agents", "skills", "agentera");
}

describe("diagnoseCanonicalSkill", () => {
  it("passes a valid canonical shared skill", () => {
    const homePath = home();
    fs.mkdirSync(target(homePath), { recursive: true });
    fs.writeFileSync(path.join(target(homePath), "SKILL.md"), "---\nname: agentera\n---\n# Agentera\n");

    expect(diagnoseCanonicalSkill(homePath)).toMatchObject({
      name: "canonical_skill",
      status: "pass",
      path: target(homePath),
      gap: null,
      details: [],
    });
  });

  it("warns for a missing target with install and direct-CLI actions", () => {
    const result = diagnoseCanonicalSkill(home());

    expect(result.status).toBe("warn");
    expect(result.details).toEqual(expect.arrayContaining([
      expect.stringContaining("install or repair the shared Agentera skill"),
      expect.stringContaining("use the Agentera CLI directly"),
    ]));
  });

  it("preserves an existing unrelated target and requests manual review", () => {
    const homePath = home();
    fs.mkdirSync(target(homePath), { recursive: true });
    const unrelated = path.join(target(homePath), "SKILL.md");
    fs.writeFileSync(unrelated, "---\nname: unrelated\n---\n");

    const before = fs.readFileSync(unrelated, "utf8");
    const result = diagnoseCanonicalSkill(homePath);

    expect(result.status).toBe("warn");
    expect(result.details).toContain("existing target preserved; review and repair the shared-skill path manually");
    expect(fs.readFileSync(unrelated, "utf8")).toBe(before);
  });

  posixIt("preserves an invalid symlink and requests manual review", () => {
    const homePath = home();
    const unrelated = path.join(homePath, "unrelated-skill");
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "SKILL.md"), "---\nname: unrelated\n---\n");
    fs.mkdirSync(path.dirname(target(homePath)), { recursive: true });
    fs.symlinkSync(unrelated, target(homePath), "dir");

    const result = diagnoseCanonicalSkill(homePath);

    expect(result.status).toBe("warn");
    expect(result.details).toContain("existing target preserved; review and repair the shared-skill path manually");
    expect(fs.lstatSync(target(homePath)).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target(homePath))).toBe(unrelated);
  });
});
