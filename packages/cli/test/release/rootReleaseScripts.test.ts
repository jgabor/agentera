import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { parseReleaseFlags } from "../../scripts/release-arguments.mjs";
import { canonicalContainedRegularFile, load, resolve } from "../../scripts/source-loader-hooks.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("root release script argument forwarding", () => {
  it("loads current TypeScript source authority before release argument parsing", () => {
    const scripts = path.join(REPO_ROOT, "packages/cli/scripts");
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-release-entrypoints-"));
    const home = path.join(isolated, "home");
    const config = path.join(isolated, "xdg-config");
    const cache = path.join(isolated, "xdg-cache");
    const data = path.join(isolated, "xdg-data");
    const temporary = path.join(isolated, "tmp");
    const npmCache = path.join(isolated, "npm-cache");
    const npmConfig = path.join(isolated, "npm-user-config");
    const npmGlobalConfig = path.join(isolated, "npm-global-config");
    const candidate = path.join(isolated, "candidate");
    const benchmark = path.join(isolated, "benchmark");
    const receipt = path.join(isolated, "publication-receipt.json");
    for (const directory of [home, config, cache, data, temporary, npmCache]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(npmConfig, "");
    fs.writeFileSync(npmGlobalConfig, "");

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm_config_|npm_token$|npm_auth_token$|node_auth_token$|git_|agentera_)/i.test(key)));
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      TMPDIR: temporary,
      AGENTERA_HOME: path.join(isolated, "agentera-home"),
      npm_config_cache: npmCache,
      npm_config_userconfig: npmConfig,
      npm_config_globalconfig: npmGlobalConfig,
    });
    const probes = [
      ["publication-transaction.mjs", "prepare", "development", "--source-commit", "0".repeat(40), "--candidate-dir", candidate, "--check", "--unexpected"],
      ["release-qualification.mjs", "verify", "--unexpected"],
      ["release-qualification.mjs", "source", "--candidate-dir", candidate, "--unexpected"],
      ["release-readiness.mjs", "development", "--candidate-dir", candidate, "--source-commit", "0".repeat(40), "--unexpected"],
      ["release-qualification.mjs", "candidate", "--adapter", "development", "--candidate-dir", candidate, "--unexpected"],
      ["release-qualification.mjs", "approval", "--adapter", "development", "--candidate-dir", candidate, "--approved-by", "test", "--unexpected"],
      ["release-benchmark.mjs", "qualification", "--adapter", "development", "--candidate-root", benchmark, "--unexpected"],
      ["release-benchmark.mjs", "publication", "--adapter", "development", "--candidate-dir", candidate, "--receipt-file", receipt, "--unexpected"],
    ];

    const protectedFiles = [path.join(REPO_ROOT, "packages/cli/package.json"), path.join(REPO_ROOT, "packages/cli/shim/package.json"), npmConfig, npmGlobalConfig];
    const before = new Map(protectedFiles.map((file) => [file, fs.readFileSync(file)]));
    const isolatedFiles = () =>
      fs
        .readdirSync(isolated, { recursive: true })
        .map(String)
        .sort()
        .map((relative) => {
          const file = path.join(isolated, relative);
          return [relative, fs.statSync(file).isFile() ? fs.readFileSync(file).toString("base64") : null];
        });
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", env });
      expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };
    const fixtureIndex = path.join(isolated, "git-index");
    fs.copyFileSync(git(["rev-parse", "--path-format=absolute", "--git-path", "index"]), fixtureIndex);
    env.GIT_INDEX_FILE = fixtureIndex;
    const isolatedBefore = isolatedFiles();
    const gitDirectory = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
    const gitCommonDirectory = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const gitStorage = () => {
      const records: Array<[string, string]> = [];
      let files = 0;
      let bytes = 0;
      const visit = (label: string, target: string) => {
        if (label === "worktree/index") return;
        if (!fs.existsSync(target)) {
          records.push([label, "missing"]);
          return;
        }
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
          records.push([label, `symlink:${fs.readlinkSync(target)}`]);
          return;
        }
        if (stat.isDirectory()) {
          records.push([label, "directory"]);
          for (const entry of fs.readdirSync(target).sort()) visit(`${label}/${entry}`, path.join(target, entry));
          return;
        }
        files += 1;
        bytes += stat.size;
        if (files > 10_000 || bytes > 64 * 1024 * 1024) throw new Error("Git metadata snapshot exceeded its bound");
        records.push([label, createHash("sha256").update(fs.readFileSync(target)).digest("hex")]);
      };
      for (const [label, target] of [
        ["worktree/HEAD", path.join(gitDirectory, "HEAD")],
        ["worktree/index", path.join(gitDirectory, "index")],
        ["worktree/config.worktree", path.join(gitDirectory, "config.worktree")],
        ["worktree/logs/HEAD", path.join(gitDirectory, "logs/HEAD")],
        ["common/config", path.join(gitCommonDirectory, "config")],
        ["common/packed-refs", path.join(gitCommonDirectory, "packed-refs")],
        ["common/refs", path.join(gitCommonDirectory, "refs")],
        ["common/logs/refs", path.join(gitCommonDirectory, "logs/refs")],
        ["common/reftable", path.join(gitCommonDirectory, "reftable")],
      ])
        visit(label, target);
      return records;
    };
    const logicalGitRefs = () => {
      const refs = git(["for-each-ref", "--count=10001", "--format=%(refname)%00%(objectname)%00%(symref)"]).split("\n").filter(Boolean);
      if (refs.length > 10_000) throw new Error("logical Git ref snapshot exceeded its bound");
      const symbolic = spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env,
      });
      expect([0, 1]).toContain(symbolic.status);
      return {
        head: git(["rev-parse", "--verify", "HEAD"]),
        symbolic: symbolic.stdout.trim(),
        refs,
      };
    };
    const gitStorageBefore = gitStorage();
    const logicalGitRefsBefore = logicalGitRefs();
    const gitBefore = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    }).stdout;

    try {
      for (const [script, ...args] of probes) {
        const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
          cwd: isolated,
          encoding: "utf8",
          env,
        });
        expect(result.status, `${script}: ${result.stderr}`).toBe(1);
        expect(result.stderr, script).toContain("unexpected argument '--unexpected'");
        expect(result.stderr, script).not.toContain("ERR_MODULE_NOT_FOUND");
      }
      for (const [file, contents] of before) expect(fs.readFileSync(file)).toEqual(contents);
      expect(fs.existsSync(candidate)).toBe(false);
      expect(fs.existsSync(benchmark)).toBe(false);
      expect(fs.existsSync(receipt)).toBe(false);
      expect(isolatedFiles()).toEqual(isolatedBefore);
      expect(gitStorage()).toEqual(gitStorageBefore);
      expect(logicalGitRefs()).toEqual(logicalGitRefsBefore);
      expect(
        spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env,
        }).stdout,
      ).toBe(gitBefore);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("only resolves contained regular source files from explicit relative specifiers", async () => {
    const parent = pathToFileURL(path.join(REPO_ROOT, "packages/cli/src/validate/activationArtifactEvidence.ts")).href;
    const mapped = await resolve("../registries/activationTuples.js", { parentURL: parent }, () => null);
    expect(mapped.url).toBe(pathToFileURL(path.join(REPO_ROOT, "packages/cli/src/registries/activationTuples.ts")).href);

    const ignored = ["node:fs", "typescript", "/tmp/module.js", "data:text/javascript,export default 1", "./module.js?raw", "./module.ts#fragment"];
    for (const specifier of ignored) {
      const fallback = { url: `ignored:${specifier}` };
      expect(await resolve(specifier, { parentURL: parent }, () => fallback)).toBe(fallback);
    }
    const absoluteSource = pathToFileURL(path.join(REPO_ROOT, "packages/cli/src/registries/packagePublication.ts")).href;
    const loadFallback = { format: "module", source: "fallback" };
    expect(await load(absoluteSource, {}, () => loadFallback)).toBe(loadFallback);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-source-loader-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-source-loader-outside-"));
    try {
      const regular = path.join(root, "regular.ts");
      const escaped = path.join(root, "escaped.ts");
      fs.writeFileSync(regular, "export {};\n");
      fs.writeFileSync(path.join(outside, "outside.ts"), "export {};\n");
      fs.symlinkSync(path.join(outside, "outside.ts"), escaped);
      expect(canonicalContainedRegularFile(root, regular)).toBe(fs.realpathSync(regular));
      expect(canonicalContainedRegularFile(root, escaped)).toBeNull();
      expect(canonicalContainedRegularFile(root, root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("gates the development entrypoint before metadata effects", () => {
    const script = path.join(REPO_ROOT, "packages/cli/scripts/publication-transaction.mjs");
    const developmentPath = path.join(REPO_ROOT, "packages/cli/package.json");
    const developmentBytes = fs.readFileSync(developmentPath);
    const development = JSON.parse(developmentBytes.toString("utf8"));
    const candidate = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-prepare-readiness-"));
    try {
      const developmentCheck = spawnSync(process.execPath, [script, "prepare", "development", "--candidate-dir", candidate, "--source-commit", development.agentera.gitRef, "--check", "--json"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(developmentCheck.status).toBe(1);
      expect(developmentCheck.stderr).toContain("source receipt is missing");
      expect(fs.readFileSync(developmentPath)).toEqual(developmentBytes);
    } finally {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  });

  it("accepts each documented pnpm argv shape and rejects extra separators or unknown flags", () => {
    expect(
      parseReleaseFlags(["--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--json"], {
        boolean: ["--json"],
        value: ["--adapter", "--candidate-dir"],
      }),
    ).toEqual(
      new Map([
        ["--adapter", "development"],
        ["--candidate-dir", "/external/candidate"],
        ["--json", true],
      ]),
    );
    expect(() => parseReleaseFlags(["--", "--", "--json"], { boolean: ["--json"] })).toThrow("duplicate pnpm argument separator");
    expect(() => parseReleaseFlags(["--", "--unknown"], { boolean: ["--json"] })).toThrow("unexpected argument '--unknown'");
    expect(() =>
      parseReleaseFlags(["--candidate-dir", "--", "/external"], {
        value: ["--candidate-dir"],
      }),
    ).toThrow("--candidate-dir requires a value");
  });

  it("accepts the exact separator and JSON shape forwarded by every root release recipe", () => {
    const rootScripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts;
    const prepareDevelopment = {
      boolean: ["--check", "--json", "--verbose"],
      value: ["--source-commit", "--candidate-dir"],
    };
    const prepareStable = {
      boolean: ["--check", "--json", "--verbose"],
      value: ["--target-version", "--source-commit"],
    };
    const qualification = {
      boolean: ["--json", "--verbose"],
      value: ["--candidate-dir", "--adapter"],
    };
    const readiness = {
      boolean: ["--json"],
      value: ["--candidate-dir", "--source-commit", "--metadata-commit"],
    };
    const approval = {
      boolean: qualification.boolean,
      value: [...qualification.value, "--approved-by", "--source-run-id"],
    };
    const qualificationBenchmark = {
      boolean: ["--json"],
      value: ["--adapter", "--candidate-root"],
    };
    const publicationBenchmark = {
      boolean: ["--json"],
      value: ["--adapter", "--candidate-dir", "--source-run-id", "--receipt-file"],
    };
    const transaction = {
      boolean: ["--approve", "--json", "--verbose"],
      value: ["--candidate-dir", "--source-run-id"],
    };
    const recipes = [
      ["cli:prepare:dev", prepareDevelopment, ["--", "--candidate-dir", "/external/candidate", "--source-commit", "commit", "--json"]],
      ["cli:prepare:stable", prepareStable, ["--", "--target-version", "next", "--source-commit", "commit", "--json"]],
      ["cli:qualify:source", qualification, ["--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:ready:dev", readiness, ["--", "--candidate-dir", "/external/candidate", "--source-commit", "commit", "--json"]],
      ["cli:qualify:dev", qualification, ["--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:approve:dev", approval, ["--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--approved-by", "test", "--json"]],
      ["cli:benchmark:qualification", qualificationBenchmark, ["--", "--adapter", "development", "--candidate-root", "/external/benchmark", "--json"]],
      ["cli:publish:qualified:dev", publicationBenchmark, ["--adapter", "development", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:publish:qualified:stable", publicationBenchmark, ["--adapter", "stable", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:stage:dev", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:promote:dev", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:stage:stable", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
      ["cli:promote:stable", transaction, ["--approve", "--", "--candidate-dir", "/external/candidate", "--json"]],
    ] as const;

    for (const [script, options, forwarded] of recipes) {
      expect(rootScripts[script]).toMatch(/^pnpm -C packages\/cli/);
      const flags = parseReleaseFlags([...forwarded], options);
      expect(flags.get("--json"), script).toBe(true);
      expect([...flags.keys()], script).not.toContain("--");
    }
    expect(() => parseReleaseFlags(["--candidate-dir", "/external/candidate", "--target-version", "next", "--source-commit", "commit"], prepareStable)).toThrow("unexpected argument '--candidate-dir'");
  });
});
