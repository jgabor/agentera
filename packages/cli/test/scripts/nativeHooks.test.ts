import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import config from "../../../../vite.config.ts";
import { selectChecks } from "../../scripts/pre-commit-checks.mjs";

const repo = path.resolve(import.meta.dirname, "../../../..");
const vp = path.join(repo, "node_modules/.bin/vp");
const stagedCommand = "./node_modules/.bin/vp staged --hide-partially-staged";
const fixtureParent = path.join(repo, ".vitest/followup/hooks");
const hookFlags = ["VP_GIT_HOOKS", "VITE_GIT_HOOKS", "HUSKY"] as const;
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function temporaryRoot(prefix: string) {
  fs.mkdirSync(fixtureParent, { recursive: true });
  fs.mkdirSync(path.join(fixtureParent, "tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, prefix));
  temporary.push(root);
  return root;
}
function run(root: string, command: string, args: string[], env = process.env) {
  // Only our disposable fixture children may override the host's hook policy.
  const childEnv = temporary.includes(root)
    ? {
        ...env,
        TMPDIR: env.TMPDIR ?? path.join(fixtureParent, "tmp"),
        VP_GIT_HOOKS: "1",
        VITE_GIT_HOOKS: "1",
        HUSKY: "1",
      }
    : env;
  return spawnSync(command, args, {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
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
  const root = temporaryRoot("native-");
  ok(root, "git", ["init", "--quiet"]);
  ok(root, "git", ["config", "user.name", "Hook Fixture"]);
  ok(root, "git", ["config", "user.email", "fixture@example.invalid"]);
  ok(root, "git", ["config", "commit.gpgsign", "false"]);
  ok(root, "git", ["config", "core.hooksPath", ".git/hooks"]);
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
  fs.copyFileSync(path.join(repo, ".node-version"), path.join(root, ".node-version"));
  write(root, "packages/cli/scripts/run-lefthook.sh", fs.readFileSync(path.join(repo, "packages/cli/scripts/run-lefthook.sh"), "utf8"));
  for (const file of [".vite-hooks/pre-commit", "packages/cli/scripts/pre-commit-checks.mjs"]) write(root, file, fs.readFileSync(path.join(repo, file), "utf8"));
  write(root, "vite.config.ts", `export default ${JSON.stringify({ staged: config.staged, lint: config.lint, fmt: config.fmt })};\n`);
  write(root, ".gitignore", "node_modules\n");
  // Keep native workspace discovery inside this nested disposable repository.
  write(root, "pnpm-workspace.yaml", "packages: []\n");
  write(root, "package.json", '{"name":"hook-fixture","private":true,"type":"module"}\n');
  write(root, "README.md", "# Fixture\n\nOriginal.\n");
  write(root, "packages/cli/src/odd name [x] 'quoted'.ts", "export const first = 0;\n\n// Separate hunks\n\nexport const second = 0;\n");
  ok(root, "git", ["add", "--", "."]);
  ok(root, "git", ["commit", "--quiet", "-m", "fixture baseline"]);
  return root;
}

function install(root: string) {
  // This is an independent fixture repo, never the checkout's common hooks.
  ok(root, "git", ["config", "--local", "--unset", "core.hooksPath"]);
  const output = ok(root, "vp", ["hooks", "enable"]);
  fs.chmodSync(path.join(root, ".vite-hooks/pre-commit"), 0o755);
  const status = run(root, "vp", ["hooks", "status"]);
  const hooksPath = run(root, "git", ["config", "--local", "core.hooksPath"]);
  const diagnostics = output + status.stdout + status.stderr + hooksPath.stdout + hooksPath.stderr;
  expect(status.status, diagnostics).toBe(0);
  expect(hooksPath.status, diagnostics).toBe(0);
  expect(hooksPath.stdout.trim(), diagnostics).toBe(".vite-hooks/_");
  expect(fs.existsSync(path.join(root, ".vite-hooks/_/pre-commit"))).toBe(true);
}

describe("native hook boundaries", () => {
  it.each([
    ["compact", ".agentera/entities/task/owned.yaml", "README.md", "timeout"],
    ["compact TODO", "TODO.md", "CHANGELOG.md", "timeout"],
    ["parity", "packages/cli/test/analytics/extractCorpusParity.test.ts", "packages/cli/test/analytics/profileSignals.test.ts", "bash"],
    ["guards", "references/authority.yaml", "docs/README.md", "guards"],
    ["native hook guards", ".vite-hooks/pre-commit", "docs/README.md", "guards"],
    ["related", "packages/cli/src/-odd [x] 'quoted'.ts", "packages/cli/dist/sample.ts", "related"],
    ["typecheck", "package.json", "README.md", "typecheck"],
  ])("selects %s only for its contracted inputs", (_name, selected, unrelated, token) => {
    expect(selectChecks([selected]).some((command: string[]) => command.includes(token))).toBe(true);
    expect(selectChecks([unrelated]).some((command: string[]) => command.includes(token))).toBe(false);
  });

  it.each(["compact", "parity", "guards", "related", "typecheck"])("propagates %s failures and does not run later readers", (failed) => {
    const root = temporaryRoot("dispatch-");
    const bin = path.join(root, "bin");
    const fake = `const fs = require('node:fs'); const args = process.argv.slice(2); const job = args.includes('10s') ? 'compact' : args.includes('--json') ? 'parity' : args.includes('guards') ? 'guards' : args.includes('related') ? 'related' : 'typecheck'; fs.appendFileSync('trace', job + '\\n'); if (process.env.FAIL_CHECK === job) process.exit(17);`;
    write(root, "fake.cjs", fake);
    for (const file of ["bin/timeout", "bin/bash", "node_modules/.bin/vp"]) {
      write(root, file, `#!/bin/sh\nexec '${process.execPath}' '${path.join(root, "fake.cjs")}' "$@"\n`);
      fs.chmodSync(path.join(root, file), 0o755);
    }
    const inputs = ["TODO.md", "scripts/extract_corpus.py", "packages/cli/src/sample.ts", "package.json"].map((file) => path.join(root, file));
    const args = [path.join(repo, "packages/cli/scripts/pre-commit-checks.mjs"), ...inputs];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const jobs = ["compact", "parity", "guards", "related", "typecheck"];
    expect(run(root, process.execPath, args, { ...env, FAIL_CHECK: "" }).status).toBe(0);
    expect(fs.readFileSync(path.join(root, "trace"), "utf8").trim().split("\n")).toEqual(jobs);
    fs.unlinkSync(path.join(root, "trace"));
    expect(run(root, process.execPath, args, { ...env, FAIL_CHECK: failed }).status).toBe(17);
    expect(fs.readFileSync(path.join(root, "trace"), "utf8").trim().split("\n")).toEqual(jobs.slice(0, jobs.indexOf(failed) + 1));
  });

  it("accepts the old entry point only for pre-commit and runs the native policy", () => {
    const root = fixture();
    write(root, "README.md", "# Fixture\n\n\nBridge.\n");
    ok(root, "git", ["add", "--", "README.md"]);
    ok(root, "sh", ["packages/cli/scripts/run-lefthook.sh", "run", "pre-commit"]);
    expect(ok(root, "git", ["show", ":README.md"])).toBe("# Fixture\n\nBridge.\n");
    const unsupported = run(root, "sh", ["packages/cli/scripts/run-lefthook.sh", "install"]);
    expect(unsupported.status).not.toBe(0);
    expect(unsupported.stderr).toContain("supports only run pre-commit");
    // Reproduce the existing common hook's delegate in this fixture only.
    write(root, ".git/hooks/pre-commit", '#!/bin/sh\nexec sh packages/cli/scripts/run-lefthook.sh run pre-commit "$@"\n');
    fs.chmodSync(path.join(root, ".git/hooks/pre-commit"), 0o755);
    ok(root, "git", ["commit", "--quiet", "-m", "legacy delegate uses native policy"]);
    expect(ok(root, "git", ["show", "HEAD:README.md"])).toBe("# Fixture\n\nBridge.\n");
    const head = ok(root, "git", ["rev-parse", "HEAD"]);
    write(root, "packages/cli/src/bad.ts", "export const value = ;\n");
    ok(root, "git", ["add", "--", "packages/cli/src/bad.ts"]);
    const failed = run(root, "git", ["commit", "--quiet", "-m", "must be rejected"]);
    expect(failed.status, failed.stdout + failed.stderr).not.toBe(0);
    expect(ok(root, "git", ["rev-parse", "HEAD"])).toBe(head);
  });

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
    // Formatting-only probe; reader ordering is exercised through actual Git below.
    write(root, "vite.config.ts", `export default ${JSON.stringify({ staged: { "*": config.staged!["*"][0] }, lint: config.lint, fmt: config.fmt })};\n`);
    ok(root, "sh", ["-c", stagedCommand]);
    const index = ok(root, "git", ["show", `:${file}`]);
    expect(index).toContain("first = { value: 1 }");
    expect(index).toContain("second = 0");
    expect(index).not.toContain("99");
    expect(fs.readFileSync(path.join(root, file), "utf8")).toContain("second = 99");
    expect(preserved.map((name) => fs.readFileSync(path.join(root, name)))).toEqual(before);
    const renamed = "packages/cli/src/-renamed space.ts";
    ok(root, "git", ["mv", "--", file, renamed]);
    ok(root, "git", ["rm", "--", "README.md"]);
    ok(root, "sh", ["-c", stagedCommand]);
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
      const invalid = run(root, "sh", ["-c", stagedCommand]);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr + invalid.stdout).toMatch(/Unexpected|Expected|parse/i);
      ok(root, "git", ["rm", "-f", "--", file]);
    }
    fs.unlinkSync(path.join(root, "node_modules"));
    const missing = run(root, "sh", ["-c", stagedCommand]);
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
    install(root);
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

  it("commits only formatted staged Markdown through the installed native trigger", () => {
    const root = fixture();
    install(root);
    write(root, "README.md", "# Fixture\n\n\nStaged.\n");
    ok(root, "git", ["add", "--", "README.md"]);
    write(root, "README.md", "# Fixture\n\n\nStaged.\n\nUnstaged.\n");
    ok(root, "git", ["commit", "--quiet", "-m", "staged Markdown"]);
    expect(ok(root, "git", ["show", "HEAD:README.md"])).toBe("# Fixture\n\nStaged.\n");
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toContain("Unstaged.");
  });

  it("executes installed hook checks with all outer hook flags disabled without changing them", () => {
    const before = hookFlags.map((flag) => process.env[flag]);
    try {
      for (const flag of hookFlags) vi.stubEnv(flag, "0");
      const root = fixture();
      install(root);
      write(root, "vite.config.ts", `export default ${JSON.stringify({ staged: { "*": [...config.staged!["*"], "node trace.cjs"] }, lint: config.lint, fmt: config.fmt })};\n`);
      write(root, "trace.cjs", `const fs = require('node:fs'); fs.writeFileSync('hook-trace.json', JSON.stringify({flags: ${JSON.stringify(hookFlags)}.map(flag => process.env[flag]), markdown: fs.readFileSync('README.md', 'utf8')}));\n`);
      write(root, "README.md", "# Fixture\n\n\nEnabled child.\n");
      ok(root, "git", ["add", "--", "README.md"]);
      ok(root, "git", ["commit", "--quiet", "-m", "disabled parent enabled fixture"]);
      expect(JSON.parse(fs.readFileSync(path.join(root, "hook-trace.json"), "utf8"))).toEqual({
        flags: ["1", "1", "1"],
        markdown: "# Fixture\n\nEnabled child.\n",
      });
      expect(ok(root, "git", ["show", "HEAD:README.md"])).toBe("# Fixture\n\nEnabled child.\n");
      expect(hookFlags.map((flag) => process.env[flag])).toEqual(["0", "0", "0"]);
      // Commands against the checkout must still inherit its disabled policy.
      expect(JSON.parse(ok(repo, process.execPath, ["-e", `console.log(JSON.stringify(${JSON.stringify(hookFlags)}.map(flag => process.env[flag])))`]))).toEqual(["0", "0", "0"]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(hookFlags.map((flag) => process.env[flag])).toEqual(before);
  });

  it.each(["guards", "related", "typecheck"])("rejects an installed-hook %s failure and restores partial hunks", (reader) => {
    const root = fixture();
    write(root, "vite.config.ts", `export default ${JSON.stringify({ staged: config.staged, lint: config.lint, fmt: config.fmt, test: { projects: [{ test: { name: "local", include: ["local.test.ts"] } }, { test: { name: "guards", include: ["guards.test.ts"] } }] } })};\n`);
    write(
      root,
      "package.json",
      JSON.stringify({
        private: true,
        type: "module",
        scripts: { typecheck: 'node -e "process.exit(Number(process.env.FAIL_TYPECHECK || 0))"' },
      }),
    );
    write(root, "packages/cli/src/value.ts", "export const value = 1;\n");
    write(root, "local.test.ts", "import { it, expect } from 'vite-plus/test'; import { value } from './packages/cli/src/value.ts'; it('local reader', () => expect(value).toBe(1));\n");
    write(root, "guards.test.ts", "import { it } from 'vite-plus/test'; it('guard reader', () => { if (process.env.FAIL_GUARDS) throw Error('negative guard'); });\n");
    ok(root, "git", ["add", "--", "."]);
    ok(root, "git", ["commit", "--quiet", "-m", "failure fixture baseline"]);
    install(root);
    write(root, "authority.json", "{}\n");
    write(root, "packages/cli/src/value.ts", "export const value = 1;\n// staged\n");
    ok(root, "git", ["add", "--", "authority.json", "packages/cli/src/value.ts"]);
    ok(root, "git", ["hook", "run", "pre-commit"]);
    if (reader === "related") {
      write(root, "packages/cli/src/value.ts", "export const value = 2;\n// staged\n");
      ok(root, "git", ["add", "--", "packages/cli/src/value.ts"]);
    }
    write(root, "packages/cli/src/value.ts", fs.readFileSync(path.join(root, "packages/cli/src/value.ts"), "utf8") + "// unstaged\n");
    const index = ok(root, "git", ["show", ":packages/cli/src/value.ts"]);
    const worktree = fs.readFileSync(path.join(root, "packages/cli/src/value.ts"), "utf8");
    const result = run(root, "git", ["hook", "run", "pre-commit"], {
      ...process.env,
      FAIL_GUARDS: reader === "guards" ? "1" : "",
      FAIL_TYPECHECK: reader === "typecheck" ? "19" : "0",
    });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(ok(root, "git", ["show", ":packages/cli/src/value.ts"])).toBe(index);
    expect(fs.readFileSync(path.join(root, "packages/cli/src/value.ts"), "utf8")).toBe(worktree);
    expect(ok(root, "git", ["stash", "list"])).toBe("");
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
      if (owner === "source") expect([...new Set(files.map(({ projectName }) => projectName))]).toEqual(["source"]);
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
    const reportRoot = temporaryRoot("related-report-");
    const reportFile = path.join(reportRoot, "related.json");
    ok(repo, vp, ["test", "related", "--run", "--project", "local", "--reporter=json", `--outputFile=${reportFile}`, "packages/cli/src/core/text.ts"]);
    const related = JSON.parse(fs.readFileSync(reportFile, "utf8")).testResults as {
      name: string;
    }[];
    expect(related.map(({ name }) => path.relative(repo, name))).toContain("packages/cli/test/validate/capability.test.ts");
    expect(related.every(({ name }) => localFiles.includes(path.relative(repo, name)))).toBe(true);
  });
});
