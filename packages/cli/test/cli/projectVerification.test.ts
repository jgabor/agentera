import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverProjectVerification } from "../../src/cli/capabilityContext/projectVerification.js";
import { cmdPrime } from "../../src/cli/commands/prime.js";

let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "project-verification-"));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

function writeGuidance(rows: string[]): void {
  fs.writeFileSync(path.join(project, "AGENTS.md"), [
    "# Guidance",
    "",
    "| When | Command |",
    "| ---- | ------- |",
    ...rows,
    "",
  ].join("\n"));
}

function writePackage(directory: string, scripts: Record<string, string>, extra: Record<string, unknown> = {}): void {
  const root = path.join(project, directory);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts, ...extra }));
}

function primeVerification(): any {
  let output = "";
  const rc = cmdPrime(
    { command: "prime", context: "build", format: "json", projectRoot: project },
    { out: (text) => { output += text; }, err: () => {} },
  );
  expect(rc).toBe(0);
  return JSON.parse(output).capability_context.context.execution_context.verification_expectations;
}

describe("project verification command discovery", () => {
  it("uses shared project safety without a platform-specific descriptor path", () => {
    const source = fs.readFileSync(path.resolve("src/cli/capabilityContext/projectVerification.ts"), "utf8");
    expect(source).not.toContain("/proc/self/fd");
  });

  it("accepts concrete AGENTS recipes and rejects placeholders and unsupported executables", () => {
    writePackage(".", { lint: "eslint ." });
    writeGuidance([
      "| Lint | `pnpm lint` |",
      "| Validate capability | `pnpm run check:<name>` |",
      "| Verification | `check validate` · `echo verify` |",
    ]);

    const result = discoverProjectVerification(project) as any;
    expect(result).toMatchObject({
      status: "partial",
      expected_commands: [{ command: "pnpm run lint" }],
      rejections: [
        expect.objectContaining({ reason: "placeholder_not_allowed" }),
        expect.objectContaining({ reason: "unsupported_or_missing_executable" }),
        expect.objectContaining({ reason: "unsupported_or_missing_executable" }),
      ],
      resolution_policy: { id: "agents_recipe_table_package_scripts_v1" },
    });
  });

  it("canonicalizes package aliases and rejects missing scripts and alias cycles", () => {
    writePackage("packages/app", {
      test: "pnpm run test:source",
      "test:source": "node test.mjs",
      cycle: "pnpm run cycle:next",
      "cycle:next": "pnpm cycle",
    });
    writeGuidance([
      "| Source tests | `pnpm -C packages/app test` |",
      "| Package boundary | `pnpm -C packages/app run missing` |",
      "| Verification | `pnpm -C packages/app cycle` |",
      "| Typecheck | `pnpm -C ../outside typecheck` |",
    ]);

    const result = discoverProjectVerification(project) as any;
    expect(result.expected_commands).toEqual([
      {
        command: "pnpm -C packages/app run test:source",
        source_provenance: [
          expect.objectContaining({
            source_family: "project_guidance",
            path: "AGENTS.md",
            line: 5,
            recipe_label: "Source tests",
          }),
          { source_family: "package_manifest", path: "packages/app/package.json", field: "scripts.test" },
          { source_family: "package_manifest", path: "packages/app/package.json", field: "scripts.test:source" },
        ],
        provenance_omitted_count: 0,
      },
    ]);
    expect(result.rejections.map(({ reason }: { reason: string }) => reason)).toEqual([
      "package_script_missing",
      "package_script_alias_cycle",
      "package_path_outside_project",
    ]);
  });

  it("deduplicates identical labels and rejects conflicting duplicate definitions", () => {
    writePackage(".", { test: "node test.mjs", build: "node build.mjs", lint: "eslint ." });
    writeGuidance([
      "| Tests | `pnpm test` |",
      "| Tests | `pnpm test` |",
      "| Build | `pnpm build` |",
      "| Build | `pnpm lint` |",
    ]);

    const result = discoverProjectVerification(project) as any;
    expect(result.expected_commands).toHaveLength(1);
    expect(result.expected_commands[0]).toMatchObject({ command: "pnpm run test" });
    expect(result.expected_commands[0].source_provenance).toEqual([
      expect.objectContaining({ source_family: "project_guidance", path: "AGENTS.md", line: 5 }),
      { source_family: "package_manifest", path: "package.json", field: "scripts.test" },
      expect.objectContaining({ source_family: "project_guidance", path: "AGENTS.md", line: 6 }),
    ]);
    expect(result.rejections).toEqual([
      expect.objectContaining({ when: "Build", reason: "conflicting_recipe_label" }),
    ]);
  });

  it("requires every Node target to exist even when package metadata claims it", () => {
    writePackage("packages/app", { build: "node scripts/build.mjs" }, { files: ["dist"] });
    fs.mkdirSync(path.join(project, "packages/app/dist"));
    fs.writeFileSync(path.join(project, "packages/app/dist/cli.js"), "");
    writeGuidance([
      "| Compaction | `pnpm -C packages/app build && node packages/app/dist/cli.js check compact` |",
      "| Verification | `pnpm -C packages/app build && node packages/app/dist/never-generated.js check` |",
    ]);

    const result = discoverProjectVerification(project) as any;
    expect(result.expected_commands).toEqual([
      expect.objectContaining({
        command: "pnpm -C packages/app run build && node packages/app/dist/cli.js check compact",
      }),
    ]);
    expect(result.rejections).toEqual([
      expect.objectContaining({ reason: "node_target_missing" }),
    ]);
  });

  it("rejects path-escaping Node arguments while preserving check compact", () => {
    fs.mkdirSync(path.join(project, "tools"));
    fs.writeFileSync(path.join(project, "tools/check.mjs"), "");
    writeGuidance([
      "| Verification safe | `node tools/check.mjs check compact` |",
      "| Verification parent | `node tools/check.mjs ../../outside` |",
      "| Verification absolute | `node tools/check.mjs /tmp/outside` |",
      "| Verification option | `node tools/check.mjs --output=../outside` |",
    ]);

    const result = discoverProjectVerification(project) as any;
    expect(result.expected_commands).toEqual([
      expect.objectContaining({ command: "node tools/check.mjs check compact" }),
    ]);
    expect(result.rejections.map(({ reason }: { reason: string }) => reason)).toEqual([
      "node_argument_path_unsafe",
      "node_argument_path_unsafe",
      "node_argument_path_unsafe",
    ]);
  });

  it("canonicalizes @ script aliases before duplicate-label conflict checks", () => {
    writePackage(".", {
      verify: "pnpm run verify@source",
      "verify@source": "node verify.mjs",
    });
    writeGuidance([
      "| Verification | `pnpm verify` |",
      "| Verification | `pnpm verify@source` |",
    ]);

    const result = discoverProjectVerification(project) as any;
    expect(result.rejections).toEqual([]);
    expect(result.expected_commands).toEqual([
      {
        command: "pnpm run verify@source",
        source_provenance: [
          expect.objectContaining({ source_family: "project_guidance", line: 5 }),
          { source_family: "package_manifest", path: "package.json", field: "scripts.verify" },
          { source_family: "package_manifest", path: "package.json", field: "scripts.verify@source" },
          expect.objectContaining({ source_family: "project_guidance", line: 6 }),
        ],
        provenance_omitted_count: 0,
      },
    ]);
  });

  it("bounds 21 commands and 21 identical-row provenance pointers with explicit omissions", () => {
    const scripts = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`test${index + 1}`, "node test.mjs"]));
    writePackage(".", scripts);
    writeGuidance(Array.from({ length: 21 }, (_, index) => `| Test ${index + 1} | \`pnpm test${index + 1}\` |`));
    const commands = discoverProjectVerification(project) as any;
    expect(commands).toMatchObject({ status: "partial", command_omitted_count: 9 });
    expect(commands.expected_commands).toHaveLength(12);
    expect(commands.expected_commands.every(({ provenance_omitted_count }: any) => provenance_omitted_count === 0)).toBe(true);

    fs.mkdirSync(path.join(project, "tools"));
    fs.writeFileSync(path.join(project, "tools/check.mjs"), "");
    writeGuidance(Array.from({ length: 21 }, () => "| Verification | `node tools/check.mjs check compact` |"));
    const provenance = discoverProjectVerification(project) as any;
    expect(provenance).toMatchObject({ status: "partial", command_omitted_count: 0 });
    expect(provenance.expected_commands).toHaveLength(1);
    expect(provenance.expected_commands[0].source_provenance).toHaveLength(16);
    expect(provenance.expected_commands[0].provenance_omitted_count).toBe(5);
  });

  it("reports rejection and diagnostic omissions even without accepted commands", () => {
    writeGuidance(Array.from({ length: 13 }, (_, index) => `| Test ${index + 1} | \`echo test${index + 1}\` |`));
    const rejections = discoverProjectVerification(project) as any;
    expect(rejections).toMatchObject({
      status: "partial",
      expected_commands: [],
      rejection_omitted_count: 1,
      diagnostic_omitted_count: 0,
    });
    expect(rejections.rejections).toHaveLength(12);

    fs.writeFileSync(path.join(project, "AGENTS.md"), [
      "| When | Command |",
      "| ---- | ------- |",
      ...Array.from({ length: 9 }, () => "| malformed | row | with | extra | cells |"),
      "",
    ].join("\n"));
    const diagnostics = discoverProjectVerification(project) as any;
    expect(diagnostics).toMatchObject({
      status: "partial",
      expected_commands: [],
      rejection_omitted_count: 0,
      diagnostic_omitted_count: 1,
    });
    expect(diagnostics.diagnostics).toHaveLength(8);
  });

  it("rejects overlong source-pointer labels and commands without ellipsizing them", () => {
    writePackage(".", { test: "node test.mjs" });
    writeGuidance([
      `| Test ${"x".repeat(170)} | \`pnpm test\` |`,
      `| Verification | \`pnpm ${"x".repeat(170)}\` |`,
    ]);

    const result = discoverProjectVerification(project) as any;
    expect(result.expected_commands).toEqual([]);
    expect(result.rejections).toEqual([
      { when: "<overlong-label>", command: "`pnpm test`", reason: "source_pointer_too_long" },
      { when: "Verification", command: "<overlong-command>", reason: "source_pointer_too_long" },
    ]);
    expect(JSON.stringify(result)).not.toContain("…");
    const prime = primeVerification();
    expect(prime.rejections).toEqual(result.rejections);
    expect(JSON.stringify(prime)).not.toContain("…");
  });

  it("preserves explicit command and provenance omissions through Prime projection", () => {
    const scripts = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`test${index + 1}`, "node test.mjs"]));
    writePackage(".", scripts);
    writeGuidance(Array.from({ length: 21 }, (_, index) => `| Test ${index + 1} | \`pnpm test${index + 1}\` |`));
    const commands = primeVerification();
    expect(commands).toMatchObject({ status: "partial", command_omitted_count: 9 });
    expect(commands.expected_commands).toHaveLength(12);

    fs.mkdirSync(path.join(project, "tools"));
    fs.writeFileSync(path.join(project, "tools/check.mjs"), "");
    writeGuidance(Array.from({ length: 21 }, () => "| Verification | `node tools/check.mjs check compact` |"));
    const provenance = primeVerification();
    expect(provenance).toMatchObject({ status: "partial", command_omitted_count: 0 });
    expect(provenance.expected_commands[0].source_provenance).toHaveLength(16);
    expect(provenance.expected_commands[0].provenance_omitted_count).toBe(5);
  });

  it("rejects symlinked guidance, package manifests, and Node targets", () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "project-verification-links-"));
    try {
      fs.writeFileSync(path.join(external, "AGENTS.md"), "| When | Command |\n| ---- | ------- |\n| Tests | `pnpm test` |\n");
      fs.symlinkSync(path.join(external, "AGENTS.md"), path.join(project, "AGENTS.md"));
      expect(discoverProjectVerification(project)).toMatchObject({
        status: "unavailable",
        diagnostics: [expect.stringContaining("bounded path safety (symlink)")],
      });

      fs.unlinkSync(path.join(project, "AGENTS.md"));
      writeGuidance(["| Tests | `pnpm test` |"]);
      fs.writeFileSync(path.join(external, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
      fs.symlinkSync(path.join(external, "package.json"), path.join(project, "package.json"));
      expect(discoverProjectVerification(project)).toMatchObject({
        expected_commands: [],
        rejections: [expect.objectContaining({ reason: "package_path_unsafe" })],
      });

      fs.unlinkSync(path.join(project, "package.json"));
      writePackage(".", {});
      fs.mkdirSync(path.join(project, "tools"));
      fs.writeFileSync(path.join(external, "target.mjs"), "");
      fs.symlinkSync(path.join(external, "target.mjs"), path.join(project, "tools", "target.mjs"));
      writeGuidance(["| Verification | `node tools/target.mjs` |"]);
      expect(discoverProjectVerification(project)).toMatchObject({
        expected_commands: [],
        rejections: [expect.objectContaining({ reason: "node_target_path_unsafe" })],
      });
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it("rejects package and Node leaves reached through symlinked parent directories", () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "project-verification-parent-links-"));
    try {
      writeGuidance(["| Tests | `pnpm -C packages/app test` |"]);
      fs.mkdirSync(path.join(external, "app"), { recursive: true });
      fs.writeFileSync(path.join(external, "app", "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
      fs.symlinkSync(external, path.join(project, "packages"));
      expect(discoverProjectVerification(project)).toMatchObject({
        expected_commands: [],
        rejections: [expect.objectContaining({ reason: "package_path_unsafe" })],
      });

      fs.unlinkSync(path.join(project, "packages"));
      fs.writeFileSync(path.join(external, "target.mjs"), "");
      fs.symlinkSync(external, path.join(project, "tools"));
      writeGuidance(["| Verification | `node tools/target.mjs` |"]);
      expect(discoverProjectVerification(project)).toMatchObject({
        expected_commands: [],
        rejections: [expect.objectContaining({ reason: "node_target_path_unsafe" })],
      });
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it("threads an injected project root into Prime and serializes bounded provenance", () => {
    writePackage(".", { verify: "node verify.mjs" });
    writeGuidance(["| Verification | `pnpm verify` |"]);
    let output = "";
    const rc = cmdPrime(
      { command: "prime", context: "build", format: "json", projectRoot: project },
      { out: (text) => { output += text; }, err: () => {} },
    );

    expect(rc).toBe(0);
    const verification = JSON.parse(output).capability_context.context.execution_context.verification_expectations;
    expect(verification).toMatchObject({
      status: "available",
      diagnostics: [],
      rejections: [],
      expected_commands: [{
        command: "pnpm run verify",
        source_provenance: [
          expect.objectContaining({
            source_family: "project_guidance",
            path: "AGENTS.md",
            line: 5,
            recipe_label: "Verification",
          }),
          { source_family: "package_manifest", path: "package.json", field: "scripts.verify" },
        ],
      }],
    });
  });
});
