import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactSchemaValidator, HookCliAdapter, loadSchema } from "../../src/hooks/validateArtifact/index.js";
import { runCursorPreToolUse } from "../../src/hooks/cursorPreToolUse.js";
import { cleanupFixtureProject, useFixtureProject } from "../helpers/useFixtureProject.js";

let tmp: string;
const fixtureRoots: string[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  while (fixtureRoots.length) cleanupFixtureProject(fixtureRoots.pop()!);
});

describe("ArtifactSchemaValidator", () => {
  it("loads real schemas and validates repo-state fixture artifacts clean", () => {
    expect(loadSchema("progress")).toBeTruthy();
    const root = useFixtureProject("ok");
    fixtureRoots.push(root);
    const v = new ArtifactSchemaValidator();
    for (const [artifact, rel] of [
      ["DOCS.md", ".agentera/docs.yaml"],
      ["VISION.md", ".agentera/vision.yaml"],
      ["HEALTH.md", ".agentera/health.yaml"],
    ] as const) {
      expect(v.validateExplicit(artifact, path.join(root, rel), root)).toEqual([]);
    }
  });

  it("reports missing required fields for an under-specified progress cycle", () => {
    const p = path.join(tmp, "progress.yaml");
    fs.writeFileSync(p, "cycles:\n- number: 1\n  timestamp: x\n");
    const violations = new ArtifactSchemaValidator().validateExplicit("PROGRESS.md", p, tmp);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("missing required field"))).toBe(true);
  });

  it("flags decision alternatives and satisfaction violations", () => {
    const p = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(
      p,
      "decisions:\n- number: 1\n  date: x\n  question: q\n  choice: c\n  alternatives:\n  - status: rejected\n  satisfaction:\n    state: bogus_state\n",
    );
    const violations = new ArtifactSchemaValidator().validateExplicit("DECISIONS.md", p, tmp);
    expect(violations.some((v) => v.includes("must have exactly one chosen entry"))).toBe(true);
    expect(violations.some((v) => v.includes("invalid value 'bogus_state'"))).toBe(true);
  });

  it("validates human-facing TODO.md markdown", () => {
    const p = path.join(tmp, "TODO.md");
    fs.writeFileSync(p, "# TODO\n\nNo sections here.\n");
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", p, tmp);
    expect(violations.some((v) => v.includes("severity"))).toBe(true);
  });

  it("accepts header-only Degraded and Annoying bands in a multi-section TODO.md", () => {
    const p = path.join(tmp, "TODO.md");
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "- [fix:3.0.0] First critical item",
      "",
      "## ⇉ Degraded",
      "",
      "## → Normal",
      "- [chore:3.0.0] Normal item",
      "",
      "## ⇢ Annoying",
      "",
    ].join("\n");
    fs.writeFileSync(p, todo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", p, tmp);
    expect(violations.filter((v) => v.includes("severity section"))).toEqual([]);
  });

  it("accepts all four bands header-only when Critical still carries an item", () => {
    const p = path.join(tmp, "TODO.md");
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "- [fix:3.0.0] First critical item",
      "",
      "## ⇉ Degraded",
      "",
      "## → Normal",
      "",
      "## ⇢ Annoying",
      "",
    ].join("\n");
    fs.writeFileSync(p, todo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", p, tmp);
    expect(violations.filter((v) => v.includes("severity section"))).toEqual([]);
  });

  it("accepts header-only Critical when resolved items live in ## ✓ Resolved", () => {
    const p = path.join(tmp, "TODO.md");
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "",
      "## ⇉ Degraded",
      "",
      "## → Normal",
      "- [ ] [chore:3.0.0] Open item",
      "",
      "## ⇢ Annoying",
      "",
      "## ✓ Resolved",
      "- [x] [fix:3.0.0] Done item",
      "",
    ].join("\n");
    fs.writeFileSync(p, todo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", p, tmp);
    expect(violations.filter((v) => v.includes("severity section"))).toEqual([]);
    expect(violations.filter((v) => v.includes("## ✓ Resolved"))).toEqual([]);
  });

  it("flags resolved checkboxes left in severity bands", () => {
    const p = path.join(tmp, "TODO.md");
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "- [x] [fix:3.0.0] Done in critical",
      "",
      "## → Normal",
      "- [ ] [chore:3.0.0] Open item",
      "",
      "## ⇢ Annoying",
      "",
    ].join("\n");
    fs.writeFileSync(p, todo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", p, tmp);
    expect(violations.some((v) => v.includes("must live under '## ✓ Resolved'"))).toBe(true);
  });

  it("does not collapse an empty Degraded body into the next Normal heading", () => {
    const p = path.join(tmp, "TODO.md");
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "- [fix:3.0.0] First critical item",
      "",
      "## ⇉ Degraded",
      "",
      "## → Normal",
      "- [chore:3.0.0] Normal item",
      "",
      "## ⇢ Annoying",
      "",
    ].join("\n");
    fs.writeFileSync(p, todo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", p, tmp);
    expect(violations.filter((v) => v.includes("severity section '⇉ Degraded'"))).toEqual([]);
    expect(violations.filter((v) => v.includes("severity section '⇶ Critical'"))).toEqual([]);
  });

  it("flags a Critical-body-collapse scenario where the next heading is glued into Critical", () => {
    const p = path.join(tmp, "TODO.md");
    const todo = [
      "# TODO",
      "",
      "## ⇶ Critical",
      "## ⇉ Degraded",
      "- [chore:3.0.0] Degraded item",
      "",
      "## → Normal",
      "- [chore:3.0.0] Normal item",
      "",
      "## ⇢ Annoying",
      "",
    ].join("\n");
    fs.writeFileSync(p, todo);
    const violations = new ArtifactSchemaValidator().validateExplicit("TODO.md", p, tmp);
    expect(
      violations.filter((v) => v.includes("nested heading")).length,
    ).toBeGreaterThan(0);
  });

  it("rejects an unsupported artifact name", () => {
    const f = path.join(tmp, "x");
    fs.writeFileSync(f, "content\n");
    const violations = new ArtifactSchemaValidator().validateExplicit("BOGUS.md", f, tmp);
    expect(violations[0]).toContain("unsupported artifact");
  });
});

describe("HookCliAdapter.run", () => {
  it("returns 0 for non-artifact writes and empty input", () => {
    const adapter = new HookCliAdapter();
    expect(adapter.run("")).toEqual([0, []]);
    expect(adapter.run(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/x.ts" }, cwd: tmp }))).toEqual([0, []]);
  });

  it("returns 2 with violations for an invalid artifact write", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentera", "progress.yaml"), "cycles:\n- number: 1\n  timestamp: x\n");
    const [rc, violations] = new HookCliAdapter().run(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".agentera/progress.yaml" }, cwd: tmp }),
    );
    expect(rc).toBe(2);
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("runCursorPreToolUse", () => {
  it("denies an invalid artifact write and allows valid/non-artifact writes", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentera", "progress.yaml"), "cycles:\n- number: 1\n  timestamp: x\n");
    let denyOut = "";
    runCursorPreToolUse(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".agentera/progress.yaml" }, cwd: tmp }),
      { out: (t) => (denyOut = t) },
    );
    expect(JSON.parse(denyOut).permission).toBe("deny");

    let allowOut = "";
    runCursorPreToolUse(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/x.ts" }, cwd: tmp }), {
      out: (t) => (allowOut = t),
    });
    expect(JSON.parse(allowOut).permission).toBe("allow");
  });
});
