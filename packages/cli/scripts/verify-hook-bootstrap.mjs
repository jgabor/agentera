// Live, disposable Git/worktree regression. Run with standalone Vite+ 0.3:
// vp node packages/cli/scripts/verify-hook-bootstrap.mjs /absolute/path/to/standalone/vp
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const launcher = process.argv[2];
assert.ok(launcher && path.isAbsolute(launcher), "Supply the supported standalone vp executable as an absolute path");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-hook-bootstrap-"));
const current = path.join(sandbox, "current");
const sibling = path.join(sandbox, "installer");
const home = path.join(sandbox, "home");
const bin = path.join(sandbox, "os-bin");
for (const dir of [current, home, bin]) fs.mkdirSync(dir);
const env = {
  HOME: home,
  VP_HOME: path.join(home, ".vite-plus"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  TMPDIR: sandbox,
  PATH: bin,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Hook fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Hook fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  NO_COLOR: "1",
};
// OS tools only: no ambient JS runtime, package manager, or Lefthook.
for (const name of ["git", "sh", "bash", "env", "uname", "tr", "sed", "dirname", "mkdir", "rm", "cat", "chmod", "timeout"]) {
  const file = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
  assert.ok(file, `Missing fixture OS prerequisite: ${name}`);
  fs.symlinkSync(file, path.join(bin, name));
}
fs.symlinkSync(launcher, path.join(bin, "vp"));
const commands = [];
function run(args, cwd = current, success = true) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  commands.push({
    args,
    cwd,
    exit: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error?.message,
  });
  fs.writeFileSync(path.join(sandbox, "receipt.json"), JSON.stringify({ env, launcher, commands }, null, 2));
  assert.equal(result.error, undefined);
  if (success) assert.equal(result.status, 0, commands.at(-1).output);
  return commands.at(-1);
}
function write(file, text) {
  const target = path.join(current, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function read(file) {
  return fs.readFileSync(path.join(current, file), "utf8");
}
console.log(`Hook evidence: ${sandbox}`);
assert.equal(process.version, `v${fs.readFileSync(path.join(root, ".node-version"), "utf8").trim()}`);
run(["git", "init"]);
write(
  "package.json",
  JSON.stringify({
    private: true,
    packageManager: "pnpm@10.30.3",
    devDependencies: { "vite-plus": "0.3.0", lefthook: "2.1.12" },
    scripts: { typecheck: "node record.mjs typecheck" },
  }),
);
write(".node-version", fs.readFileSync(path.join(root, ".node-version")));
assert.match(run([launcher, "--version"]).output, /^vp v0\.3\.0\n/);
write("pnpm-workspace.yaml", "allowBuilds:\n  esbuild: true\n");
write(".gitignore", "node_modules/\n*.marker\n");
write(".lefthook.yml", fs.readFileSync(path.join(root, ".lefthook.yml")));
write("packages/cli/scripts/run-lefthook.sh", fs.readFileSync(path.join(root, "packages/cli/scripts/run-lefthook.sh")));
const staged = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8").match(/staged: (\{[\s\S]*?\n  \}),/)[1];
write(
  "vite.config.ts",
  `import { defineConfig } from 'vite-plus';
export default defineConfig({ staged: ${staged}, test: { maxWorkers: 2, projects: [
{ test: { name: 'local', include: ['local.test.ts'] } },
{ test: { name: 'guards', include: ['guards.test.ts'] } }
] } });\n`,
);
write(
  "record.mjs",
  `import fs from 'node:fs';
if (process.version !== 'v24.19.0') throw Error(process.version);
fs.writeFileSync(process.argv[2] + '.marker', JSON.stringify({ node: process.version, cwd: process.cwd(), exec: process.execPath }));\n`,
);
write(
  "local.test.ts",
  `import { test, expect } from 'vite-plus/test';
import fs from 'node:fs';
import { value } from './packages/cli/src/sample.js';
test('related owner', () => { expect(value).toBe(2); expect(process.version).toBe('v24.19.0'); fs.writeFileSync('local.marker', 'passed'); });\n`,
);
write(
  "guards.test.ts",
  `import { test, expect } from 'vite-plus/test';
import fs from 'node:fs';
test('guard owner', () => { expect(process.version).toBe('v24.19.0'); fs.writeFileSync('guards.marker', 'passed'); });\n`,
);
const source = "packages/cli/src/sample.js";
const padding = "// separate hunks\n".repeat(15);
write(source, `export const value = 1;\n${padding}export const pending = 0;\n`);
run(["vp", "env", "on"]);
run(["vp", "install"]);
run(["git", "add", "."]);
run(["git", "commit", "-m", "seed disposable hook fixture"]);
run(["git", "config", "extensions.worktreeConfig", "true"]);
run(["git", "config", "--worktree", "fixture.preserve", "current-value"]);
run(["git", "worktree", "add", "--detach", sibling]);
run(["git", "config", "--worktree", "fixture.preserve", "sibling-value"], sibling);
const commonConfig = read(".git/config");
const currentConfig = read(".git/config.worktree");
const siblingConfigPath = path.join(current, ".git/worktrees/installer/config.worktree");
const siblingConfig = fs.readFileSync(siblingConfigPath, "utf8");
run(["vp", "install", "--frozen-lockfile"], sibling);
run(["vp", "exec", "lefthook", "install"], sibling);
assert.equal(fs.readFileSync(siblingConfigPath, "utf8"), siblingConfig);
assert.equal(read(".git/config"), commonConfig);
assert.equal(read(".git/config.worktree"), currentConfig);
assert.match(read(".git/hooks/pre-commit"), /sh packages\/cli\/scripts\/run-lefthook\.sh "\$@"/);
run(["git", "worktree", "remove", "--force", sibling]);
write(source, `export const value=2\n${padding}export const pending = 0;\n`);
run(["git", "add", source]);
write(source, `export const value=2\n${padding}export const pending = 999;\n`);
run(["git", "hook", "run", "pre-commit"]);
assert.match(read(source), /pending = 999/);
const index = run(["git", "show", `:${source}`]).output;
assert.match(index, /value = 2;/);
assert.match(index, /pending = 0;/);
assert.doesNotMatch(index, /999/);
assert.equal(read("local.marker"), "passed");
assert.equal(fs.existsSync(path.join(current, "guards.marker")), false);
const runtime = JSON.parse(read("typecheck.marker"));
assert.equal(runtime.cwd, current);
assert.equal(runtime.node, "v24.19.0");
assert.ok(runtime.exec.startsWith(env.VP_HOME));
// Consume the staged hunk through ordinary Git, retaining the unstaged hunk.
run(["git", "commit", "-m", "exercise current worktree hook"]);
assert.match(run(["git", "diff", "--", source]).output, /pending = 999/);
for (const name of ["local.marker", "typecheck.marker"]) fs.unlinkSync(path.join(current, name));
write("packages/cli/scripts/selection.sh", "# fixture guard selection\n");
run(["git", "add", "packages/cli/scripts/selection.sh"]);
run(["git", "hook", "run", "pre-commit"]);
assert.equal(read("guards.marker"), "passed");
for (const name of ["local.marker", "typecheck.marker"]) assert.equal(fs.existsSync(path.join(current, name)), false);
assert.equal(read(".git/config"), commonConfig);
assert.equal(read(".git/config.worktree"), currentConfig);
// Actual missing prerequisites must fail, not silently skip checks.
fs.renameSync(path.join(current, "node_modules"), path.join(current, "saved-dependencies"));
const missingDependencies = run(["git", "hook", "run", "pre-commit"], current, false);
assert.notEqual(missingDependencies.exit, 0);
assert.match(missingDependencies.output, /this worktree's dependencies.*vp install --frozen-lockfile/);
fs.renameSync(path.join(current, "saved-dependencies"), path.join(current, "node_modules"));
fs.unlinkSync(path.join(bin, "vp"));
const missingLauncher = run(["git", "hook", "run", "pre-commit"], current, false);
assert.notEqual(missingLauncher.exit, 0);
assert.match(missingLauncher.output, /standalone Vite\+ 0\.3 on Git's PATH/);
console.log(`PASS: installation, managed ordinary Git, removed sibling, partial hunks, owner selection, config preservation, missing prerequisites. Receipt: ${sandbox}/receipt.json`);
