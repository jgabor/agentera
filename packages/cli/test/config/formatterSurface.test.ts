import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import config from "../../../../vite.config.js";

const vp = resolve(import.meta.dirname, "../../../../node_modules/.bin/vp");
const repo = resolve(import.meta.dirname, "../../../..");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join("/tmp", "agentera-formatter-"));
  temporary.push(root);
  mkdirSync(join(root, "packages/cli"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/cli"\n');
  writeFileSync(join(root, "vite.config.ts"), `export default ${JSON.stringify({ fmt: config.fmt, lint: config.lint })};\n`);
  writeFileSync(join(root, "packages/cli/vite.config.ts"), "export default {};\n");
  writeFileSync(join(root, ".editorconfig"), readFileSync(join(repo, ".editorconfig")));
  return root;
}

describe("formatter check", () => {
  it("includes all maintained source", () => {
    expect(config.fmt?.ignorePatterns).toContain("packages/cli/test/**/fixtures/**");
  });

  it("accepts clean input and rejects formatting drift", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentera-formatter-"));
    temporary.push(directory);
    const clean = join(directory, "clean.ts");
    const drifted = join(directory, "drifted.ts");

    writeFileSync(clean, 'const value = "clean";\n');
    writeFileSync(drifted, "const value='drifted'\n");

    expect(() => execFileSync(vp, ["fmt", "--check", clean])).not.toThrow();
    expect(spawnSync(vp, ["fmt", "--check", drifted]).status).not.toBe(0);
  });

  it("uses the same root/package/editor width and byte-stable exclusions", () => {
    const root = fixture();
    expect(config.fmt?.printWidth).toBe(320);
    expect(readFileSync(join(repo, ".editorconfig"), "utf8")).toContain("max_line_length = 320");
    const source = "packages/cli/source.ts";
    const clean = `export const values = [${Array.from({ length: 24 }, (_, i) => `"value${i}"`).join(", ")}];\n`;
    writeFileSync(join(root, source), clean);
    const preserved = [".agentera/entities/task/owned.json", "packages/cli/test/fixtures/bytes.json", "packages/cli/test/evidence/bytes.md", "packages/cli/dist/bytes.json", "skills/agentera/SKILL.md", "references/bytes.md"];
    for (const file of preserved) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), file.endsWith("json") ? '{"bytes":[1,2]}\n' : "#  preserved\n\n\nkept  \n");
    }
    const before = preserved.map((file) => readFileSync(join(root, file)));
    for (const cwd of [root, join(root, "packages/cli")]) {
      const checked = spawnSync(vp, ["fmt", "--check", join(root, source)], {
        cwd,
        encoding: "utf8",
      });
      expect(checked.status, checked.stdout + checked.stderr).toBe(0);
      const formatted = spawnSync(vp, ["fmt", join(root, source), ...preserved.map((file) => join(root, file))], {
        cwd,
        encoding: "utf8",
      });
      expect(formatted.status, formatted.stdout + formatted.stderr).toBe(0);
      expect(preserved.map((file) => readFileSync(join(root, file)))).toEqual(before);
    }
    writeFileSync(join(root, source), clean.replace("values =", "values="));
    for (const cwd of [root, join(root, "packages/cli")]) expect(spawnSync(vp, ["fmt", "--check", join(root, source)], { cwd }).status).not.toBe(0);
  });

  it("formats eligible Markdown but does not assert Markdown structural policy", () => {
    const root = fixture();
    for (const file of ["README.md", "docs/nested/current.md", "packages/cli/README.md", "skills/example/SKILL.md", ".opencode/skills/example/SKILL.md"]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "# First\n\n\n### Skipped level\n\n# Second title\n");
      const drift = spawnSync(vp, ["fmt", "--check", join(root, file)], { cwd: root });
      expect(drift.status).not.toBe(0);
      expect(spawnSync(vp, ["fmt", join(root, file)], { cwd: root }).status).toBe(0);
      expect(readFileSync(join(root, file), "utf8")).toBe("# First\n\n### Skipped level\n\n# Second title\n");
      expect(spawnSync(vp, ["fmt", "--check", join(root, file)], { cwd: root }).status).toBe(0);
    }
  });
});
