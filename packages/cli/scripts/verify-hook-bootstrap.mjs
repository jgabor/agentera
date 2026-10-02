// Live, independent disposable Git regression. Run with standalone Vite+ 1.0.0:
// vp node packages/cli/scripts/verify-hook-bootstrap.mjs /absolute/path/to/standalone/vp
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const launcher = process.argv[2];
assert.ok(launcher && path.isAbsolute(launcher), "Supply the supported standalone vp executable as an absolute path");
const sandbox = fs.mkdtempSync(path.join("/tmp/opencode", "agentera-hook-bootstrap-"));
const current = path.join(sandbox, "current");
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
// OS tools only: no ambient JS runtime or package manager.
for (const name of ["git", "sh", "bash", "env", "uname", "tr", "sed", "dirname", "basename", "mkdir", "rm", "cat", "chmod", "timeout"]) {
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
    devDependencies: { "vite-plus": "1.0.0", vite: "npm:@voidzero-dev/vite-plus-core@1.0.0" },
    scripts: { typecheck: "node record.mjs typecheck" },
  }),
);
write(".node-version", fs.readFileSync(path.join(root, ".node-version")));
assert.match(run([launcher, "--version"]).output, /^vp v1\.0\.0\n/);
write("pnpm-workspace.yaml", "allowBuilds:\n  esbuild: true\noverrides:\n  vite@*: npm:@voidzero-dev/vite-plus-core@1.0.0\n  vitest@*: 5.0.1\npeerDependencyRules:\n  allowAny: [vite, vitest]\n");
write(".gitignore", "node_modules/\n*.marker\n");
for (const file of [".vite-hooks/pre-commit", "packages/cli/scripts/run-lefthook.sh", "packages/cli/scripts/pre-commit-checks.mjs"]) write(file, fs.readFileSync(path.join(root, file)));
fs.chmodSync(path.join(current, ".vite-hooks/pre-commit"), 0o755);
const staged = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8").match(/staged: (\{[\s\S]*?\n  \}),/)[1];
write(
  "vite.config.ts",
  `import { defineConfig } from 'vite-plus';
export default defineConfig({ staged: ${staged}, fmt: { printWidth: 320, ignorePatterns: ['node_modules/**', '.agentera/**', 'TODO.md', 'packages/cli/test/**/fixtures/**', 'packages/cli/test/evidence/**'] }, test: { maxWorkers: 2, projects: [
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
// Dependency acquisition must not activate hooks implicitly, even in this fixture.
env.VP_GIT_HOOKS = "0";
run(["vp", "install"]);
run(["vp", "install", "--frozen-lockfile"]);
delete env.VP_GIT_HOOKS;
run(["git", "add", "."]);
run(["git", "commit", "-m", "seed disposable hook fixture"]);
run(["git", "config", "--local", "fixture.preserve", "current-value"]);
const globalConfig = path.join(home, ".gitconfig");
fs.writeFileSync(globalConfig, "[fixture]\n\tpreserve = global-value\n");
const globalBefore = fs.readFileSync(globalConfig);
run(["vp", "hooks", "enable"]);
assert.equal(run(["git", "config", "--local", "core.hooksPath"]).output.trim(), ".vite-hooks/_");
assert.equal(run(["git", "config", "--local", "fixture.preserve"]).output.trim(), "current-value");
assert.deepEqual(fs.readFileSync(globalConfig), globalBefore);
assert.ok(fs.existsSync(path.join(current, ".vite-hooks/_/pre-commit")));
const commonConfig = read(".git/config");
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
assert.deepEqual(fs.readFileSync(globalConfig), globalBefore);
// Actual missing prerequisites must fail, not silently skip checks.
fs.renameSync(path.join(current, "node_modules"), path.join(current, "saved-dependencies"));
const missingDependencies = run(["git", "hook", "run", "pre-commit"], current, false);
assert.notEqual(missingDependencies.exit, 0);
assert.match(missingDependencies.output, /this worktree's dependencies.*vp install --frozen-lockfile/);
fs.renameSync(path.join(current, "saved-dependencies"), path.join(current, "node_modules"));
fs.unlinkSync(path.join(bin, "vp"));
const missingLauncher = run(["git", "hook", "run", "pre-commit"], current, false);
assert.notEqual(missingLauncher.exit, 0);
assert.match(missingLauncher.output, /standalone Vite\+ 1\.0 on Git's PATH/);
// An ambient Node does not make the local vp shim a supported runtime owner.
fs.symlinkSync(process.execPath, path.join(bin, "node"));
const ambientFallback = run(["git", "hook", "run", "pre-commit"], current, false);
assert.notEqual(ambientFallback.exit, 0);
assert.match(ambientFallback.output, /standalone Vite\+ 1\.0 on Git's PATH/);
console.log(`PASS: native local activation, managed ordinary Git, partial hunks, owner selection, config preservation, missing prerequisites. Receipt: ${sandbox}/receipt.json`);
