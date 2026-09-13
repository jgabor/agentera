import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import config from "../../../../vite.config.ts";

const repo = path.resolve(import.meta.dirname, "../../../..");
const vp = path.join(repo, "node_modules/.bin/vp");
const lefthook = path.join(repo, "node_modules/.bin/lefthook");
const hook = YAML.parse(fs.readFileSync(path.join(repo, ".lefthook.yml"), "utf8"));
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function run(root: string, command: string, args: string[], env = process.env) {
  return spawnSync(command, args, { cwd: root, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}
function ok(root: string, command: string, args: string[]) {
  const result = run(root, command, args);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}
function write(root: string, file: string, text: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-native-hooks-"));
  temporary.push(root);
  ok(root, "git", ["init", "--quiet"]);
  ok(root, "git", ["config", "user.name", "Hook Fixture"]);
  ok(root, "git", ["config", "user.email", "fixture@example.invalid"]);
  ok(root, "git", ["config", "commit.gpgsign", "false"]);
  ok(root, "git", ["config", "core.hooksPath", ".git/hooks"]);
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
  fs.copyFileSync(path.join(repo, ".node-version"), path.join(root, ".node-version"));
  write(root, "packages/cli/scripts/run-lefthook.sh", fs.readFileSync(path.join(repo, "packages/cli/scripts/run-lefthook.sh"), "utf8"));
  write(root, "vite.config.ts", `export default ${JSON.stringify({ staged: config.staged, lint: config.lint, fmt: config.fmt })};\n`);
  for (const file of [".markdownlint.json", ".markdownlintignore"]) fs.copyFileSync(path.join(repo, file), path.join(root, file));
  write(root, ".gitignore", "node_modules\n");
  write(root, "package.json", '{"name":"hook-fixture","private":true,"type":"module"}\n');
  write(root, "README.md", "# Fixture\n\nOriginal.\n");
  write(root, "packages/cli/src/odd name [x] 'quoted'.ts", "export const first = 0;\n\n// Separate hunks\n\nexport const second = 0;\n");
  ok(root, "git", ["add", "--", "."]);
  ok(root, "git", ["commit", "--quiet", "-m", "fixture baseline"]);
  return root;
}

describe("native hook boundaries", () => {
  it("formats only staged hunks, handles odd names, renames and deletions, and leaves evidence bytes alone", () => {
    const root = fixture();
    const file = "packages/cli/src/odd name [x] 'quoted'.ts";
    const staged = "export const first={value:1};\n\n// Separate hunks\n\nexport const second = 0;\n";
    write(root, file, staged);
    ok(root, "git", ["add", "--", file]);
    write(root, file, staged.replace("second = 0", "second = 99"));
    const preserved = ["packages/cli/test/fixtures/bytes.json", "packages/cli/test/evidence/bytes.json", "packages/cli/test/fixtures/bytes.md", ".agentera/entities/bytes.md", "TODO.md"];
    for (const name of preserved) {
      write(root, name, name.endsWith("json") ? '{"bytes":  [1,2]}\n' : "#  Byte sensitive\n\n\nkept  \n");
      ok(root, "git", ["add", "--", name]);
    }
    const before = preserved.map((name) => fs.readFileSync(path.join(root, name)));
    ok(root, "sh", ["-c", hook["pre-commit"].commands.staged.run]);
    const index = ok(root, "git", ["show", `:${file}`]);
    expect(index).toContain("first = { value: 1 }");
    expect(index).toContain("second = 0");
    expect(index).not.toContain("99");
    expect(fs.readFileSync(path.join(root, file), "utf8")).toContain("second = 99");
    expect(preserved.map((name) => fs.readFileSync(path.join(root, name)))).toEqual(before);
    const renamed = "packages/cli/src/-renamed space.ts";
    ok(root, "git", ["mv", "--", file, renamed]);
    ok(root, "git", ["rm", "--", "README.md"]);
    ok(root, "sh", ["-c", hook["pre-commit"].commands.staged.run]);
    expect(ok(root, "git", ["diff", "--cached", "--name-status"])).toContain("README.md");
    expect(ok(root, "git", ["show", `:${renamed}`])).toContain("second = 0");
    expect(ok(root, "git", ["stash", "list"])).toBe("");
  });

  it("actually lints TypeScript and JavaScript and fails without the local binary", () => {
    const root = fixture();
    for (const extension of ["ts", "js"]) {
      const file = `packages/cli/src/invalid.${extension}`;
      write(root, file, "export const invalid = ;\n");
      ok(root, "git", ["add", "--", file]);
      const invalid = run(root, "sh", ["-c", hook["pre-commit"].commands.staged.run]);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr + invalid.stdout).toMatch(/Unexpected|Expected|parse/i);
      ok(root, "git", ["rm", "-f", "--", file]);
    }
    fs.unlinkSync(path.join(root, "node_modules"));
    const missing = run(root, "sh", ["-c", hook["pre-commit"].commands.staged.run]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("./node_modules/.bin/vp");
  });

  it.each([
    ["root source", "packages/cli/src/odd name [x] 'quoted'.ts", "packages/cli/test/nested/import.test.ts", "source"],
    ["nested source", "packages/cli/src/core/odd name [x] 'quoted'.ts", "packages/cli/test/nested/import.test.ts", "source"],
    ["root test", "packages/cli/src/core/odd name [x] 'quoted'.ts", "packages/cli/test/odd name [x] 'quoted'.test.ts", "test"],
    ["nested test", "packages/cli/src/core/odd name [x] 'quoted'.ts", "packages/cli/test/nested/odd name [x] 'quoted'.test.ts", "test"],
  ])("runs staged fixes before every installed-hook reader for %s", (_name, source, test, trigger) => {
    const root = fixture();
    const fixtureConfig = {
      staged: config.staged,
      lint: config.lint,
      fmt: config.fmt,
      test: {
        ...config.test,
        projects: [
          {
            test: {
              name: "local",
              root,
              include: ["packages/cli/test/**/*.test.ts"],
              exclude: ["**/guard.test.ts"],
            },
          },
          { test: { name: "guards", root, include: ["packages/cli/test/guard.test.ts"] } },
        ],
      },
    };
    write(root, "vite.config.ts", `export default ${JSON.stringify(fixtureConfig)};\n`);
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "hook-fixture",
        private: true,
        type: "module",
        scripts: { typecheck: "tsc6 -p tsconfig.json --noEmit && node trace.cjs typecheck" },
      }),
    );
    write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", types: [], skipLibCheck: true },
        include: ["packages/cli/src/**/*.ts"],
      }),
    );
    write(root, "trace.cjs", `const fs = require('node:fs'); fs.appendFileSync('trace.jsonl', JSON.stringify({job: process.argv[2], text: fs.readFileSync(${JSON.stringify(source)}, 'utf8'), test: fs.readFileSync(${JSON.stringify(test)}, 'utf8'), markdown: fs.readFileSync('README.md', 'utf8')}) + '\\n');\n`);
    const testBody = `import { expect, it } from 'vitest'; import { first } from ${JSON.stringify(path.relative(path.dirname(test), source))}; import { execFileSync } from 'node:child_process'; it('related import', () => { expect(first).toEqual({ value: 1 }); execFileSync(process.execPath, ['trace.cjs', 'related']); });\n`;
    write(root, test, testBody);
    write(root, "packages/cli/test/guard.test.ts", "import { it } from 'vitest'; import { execFileSync } from 'node:child_process'; it('guard reader', () => { execFileSync(process.execPath, ['trace.cjs', 'guards']); });\n");
    write(root, "packages/cli/test/fs-only.test.ts", "import { it } from 'vitest'; it('not import-related', () => { throw Error('must not run'); });\n");
    const staged = "export const first={value:1};\n\n// Separate hunks\n\nexport const second = 0;\n";
    write(root, source, trigger === "source" ? staged : staged.replace("first={value:1}", "first = { value: 1 }"));
    if (_name === "nested source") {
      const related = ok(root, vp, ["test", "related", "--run", "--project", "local", "--passWithNoTests", source]);
      expect(related).toContain("1 passed");
      for (const file of ["references/authority.yaml", "vite.config.ts", "deleted.ts"]) {
        expect(ok(root, vp, ["test", "related", "--run", "--project", "local", "--passWithNoTests", file])).toContain("No test files found");
      }
      fs.unlinkSync(path.join(root, "trace.jsonl"));
    }
    write(root, ".gitignore", "node_modules\ntrace.jsonl\n");
    ok(root, "git", ["add", "--", "."]);
    ok(root, "git", ["commit", "--quiet", "-m", "reader fixture baseline"]);
    if (trigger === "source") {
      write(root, source, staged.replace("// Separate hunks", "// Staged change"));
    } else {
      write(root, test, testBody + "// Staged test change\n");
    }
    write(root, "README.md", "# Fixture\n\n\nStaged.\n");
    // A coarse authority trigger exercises guards without selecting another test.
    write(root, "authority.json", "{}\n");
    ok(root, "git", ["add", "--", trigger === "source" ? source : test, "README.md", "authority.json"]);
    if (trigger === "source") write(root, source, fs.readFileSync(path.join(root, source), "utf8").replace("second = 0", "second = 99"));
    write(root, "README.md", "# Fixture\n\n\nStaged.\n\nUnstaged.\n");
    fs.copyFileSync(path.join(repo, ".lefthook.yml"), path.join(root, ".lefthook.yml"));
    ok(root, lefthook, ["install", "--force"]);
    ok(root, "git", ["commit", "--quiet", "-m", "installed hook reader order"]);
    const trace = fs
      .readFileSync(path.join(root, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace.map(({ job }) => job)).toEqual(["guards", "related", "typecheck"]);
    for (const { text, test: testText, markdown } of trace) {
      expect(text).toContain("first = { value: 1 }");
      expect(markdown).toBe(ok(root, "git", ["show", "HEAD:README.md"]));
      if (trigger === "source") expect(text).toBe(ok(root, "git", ["show", `HEAD:${source}`]));
      else {
        expect(testText).toContain('import { expect, it } from "vitest";');
        expect(testText).toBe(ok(root, "git", ["show", `HEAD:${test}`]));
      }
    }
    if (trigger === "source") {
      expect(ok(root, "git", ["show", `HEAD:${source}`])).toContain("first = { value: 1 }");
      expect(ok(root, "git", ["show", `HEAD:${source}`])).toContain("second = 0");
      expect(fs.readFileSync(path.join(root, source), "utf8")).toContain("second = 99");
    }
    expect(ok(root, "git", ["show", "HEAD:README.md"])).toBe("# Fixture\n\nStaged.\n");
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("# Fixture\n\nStaged.\n\nUnstaged.\n");
    expect(ok(root, "git", ["stash", "list"])).toBe("");
  });

  it("commits only formatted staged Markdown through the installed Lefthook trigger", () => {
    const root = fixture();
    fs.copyFileSync(path.join(repo, ".lefthook.yml"), path.join(root, ".lefthook.yml"));
    ok(root, lefthook, ["install", "--force"]);
    write(root, "README.md", "# Fixture\n\n\nStaged.\n");
    ok(root, "git", ["add", "--", "README.md"]);
    write(root, "README.md", "# Fixture\n\n\nStaged.\n\nUnstaged.\n");
    ok(root, "git", ["commit", "--quiet", "-m", "staged Markdown"]);
    expect(ok(root, "git", ["show", "HEAD:README.md"])).toBe("# Fixture\n\nStaged.\n");
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toContain("Unstaged.");
  });

  it("clears Git's complete local variable set before nested fixture writes", () => {
    const outer = fixture();
    const inner = fixture();
    const before = ["HEAD", ":README.md"].map((ref) => ok(outer, "git", ["show", ref]));
    const configBefore = fs.readFileSync(path.join(outer, ".git/config"));
    const script = `await import(${JSON.stringify(pathToFileURL(path.join(repo, "packages/cli/test/gitSetup.ts")).href)});
      const { execFileSync } = await import('node:child_process');
      const names = execFileSync('git', ['rev-parse', '--local-env-vars'], {encoding:'utf8'}).trim().split(/\\s+/);
      if (names.some(name => process.env[name] !== undefined)) throw Error('inherited Git environment');
      execFileSync('git', ['-C', ${JSON.stringify(inner)}, 'config', '--local', 'fixture.isolated', 'true']);
      execFileSync('git', ['-C', ${JSON.stringify(inner)}, 'commit', '--allow-empty', '-m', 'nested fixture']);`;
    const result = run(inner, process.execPath, ["--input-type=module", "-e", script], {
      ...process.env,
      GIT_DIR: path.join(outer, ".git"),
      GIT_WORK_TREE: outer,
      GIT_INDEX_FILE: path.join(outer, ".git/index"),
      GIT_COMMON_DIR: path.join(outer, ".git"),
      GIT_OBJECT_DIRECTORY: path.join(outer, ".git/objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "fixture.inherited",
      GIT_CONFIG_VALUE_0: "true",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(ok(inner, "git", ["config", "--local", "fixture.isolated"]).trim()).toBe("true");
    expect(["HEAD", ":README.md"].map((ref) => ok(outer, "git", ["show", ref]))).toEqual(before);
    expect(fs.readFileSync(path.join(outer, ".git/config"))).toEqual(configBefore);
  });

  it("discovers every CI owner exactly once using native configuration", () => {
    expect(config.test).toMatchObject({
      maxWorkers: 2,
      projects: [{ test: { name: "local", maxWorkers: 2 } }, { test: { name: "source", maxWorkers: 2 } }, { test: { name: "guards", maxWorkers: 2 } }],
    });
    const inventory = JSON.parse(ok(repo, process.execPath, ["packages/cli/scripts/verify-lane.mjs", "inventory", "--json"]));
    const all: string[] = [];
    for (const [owner, expected] of Object.entries(inventory.files)) {
      const result = run(repo, vp, ["test", "list", "--filesOnly", "--json", "--config", owner === "package" ? "packages/cli/vite.package.config.ts" : "packages/cli/vite.config.ts"], { ...process.env, AGENTERA_VERIFICATION_OWNER: owner });
      expect(result.status, result.stderr).toBe(0);
      const files = JSON.parse(result.stdout) as { file: string; projectName: string }[];
      const relative = files.map(({ file }) => path.relative(repo, file)).sort();
      expect(relative).toEqual(expected);
      all.push(...relative);
    }
    expect(new Set(all).size).toBe(all.length);
    const rootFiles = JSON.parse(ok(repo, vp, ["test", "list", "--filesOnly", "--json"])) as {
      file: string;
      projectName: string;
    }[];
    expect(rootFiles.map(({ file }) => path.relative(repo, file)).sort()).toEqual(inventory.files.source);
    expect(new Set(rootFiles.map(({ file }) => file)).size).toBe(rootFiles.length);
    const localFiles = rootFiles.filter(({ projectName }) => projectName === "local").map(({ file }) => path.relative(repo, file));
    expect(localFiles).toContain("packages/cli/test/validate/capability.test.ts");
    expect(localFiles.some((file) => /\/test\/(integration|upgrade|runtime|setup|build)\//.test(file))).toBe(false);
    const related = JSON.parse(ok(repo, vp, ["test", "related", "--run", "--project", "local", "--reporter=json", "packages/cli/src/core/text.ts"])).testResults as { name: string }[];
    expect(related.map(({ name }) => path.relative(repo, name))).toContain("packages/cli/test/validate/capability.test.ts");
    expect(related.every(({ name }) => localFiles.includes(path.relative(repo, name)))).toBe(true);
  });
});
