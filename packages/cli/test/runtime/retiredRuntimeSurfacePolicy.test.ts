import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  CAPABILITY_INSTRUCTIONS,
  capabilityInstructionModulePath,
} from "../../src/capabilities/index.js";
import { statusStartupInstructions } from "../../src/capabilities/status/startupInstructions.js";
import { preCutoverInstructionBody } from "../../src/cli/preCutoverCommand.js";
import { PRIME_BLOB } from "../../src/cli/prime-blob.js";
import {
  printCapabilityHelp,
  printRouteHelp,
  printTopLevelHelp,
  printUpgradeHelp,
} from "../../src/cli/help.js";
import {
  preCutoverBootstrapAuthorityDiagnostics,
  preCutoverBootstrapGuidanceViolations,
  registryBootstrapAuthorityInventory,
  registryBootstrapAuthorityParity,
  registryBundledAuthorityPaths,
  registryBundledAuthorityViolations,
  retiredStartupGuidanceViolations,
} from "../helpers/retiredStartupGuidance.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const packageRegistryPath = "references/adapters/package-registry.yaml";
const STABLE_V2_PREVIEW = "npx -y agentera@latest upgrade --dry-run";
const STABLE_V2_APPLY = "npx -y agentera@latest upgrade --yes";

const forbiddenCurrentSupportPatterns = [
  ["Claude Code Task tool", /Claude Code:\s*Task tool/i],
  ["Claude runtime question tool", /Claude Code\s+`AskUserQuestion`/i],
  ["Claude runtime opt-out", /--no-claude\b/i],
  [
    "Claude in a supported runtime list",
    /(?:supported|active) runtime(?: ids|s)?(?:\s+are|:)?[^.\n]*(?:\bclaude\b|claude-code)/i,
  ],
  [
    "Claude in supported runtime sources",
    /Supported runtime sources:[\s\S]{0,800}\*\*Claude Code\*\*/i,
  ],
  [
    "Claude install command",
    /(?:\bnpx\s+(?:-y\s+)?skills\s+add[^\n]*(?:\bclaude\b|claude-code)|\bclaude\s+(?:plugin|install|setup|configure)\b[^\n]*agentera)/i,
  ],
  [
    "active native runtime roster",
    /Canonical active runtime names are OpenCode, Codex, Cursor, and GitHub Copilot/i,
  ],
  ["runtime selector write requirement", /runtime writes require an explicit selector/i],
  ["managed native repair", /managed runtime config, plugins, hooks, commands, and safe cleanup/i],
  ["active package-update flag", /External package manager changes require `--update-packages`/i],
  [
    "active narrow bundle selector",
    /`--only bundle`\s*\|\s*Compatibility selector for narrow app-file work/i,
  ],
  [
    "active runtime adapter",
    /Runtime-specific Agentera adapter support for skill loading, hooks, artifact validation/i,
  ],
  ["active plugin hooks", /Hooks that are shipped by active runtime plugin package surfaces/i],
  [
    "named native worker roster",
    /worker execution through OpenCode, Codex CLI, Cursor IDE, Copilot CLI/i,
  ],
  ["runtime setup doctor", /Diagnostic command surface for install\/runtime health/i],
] as const;

const publicInstallSurfaceRoots = [
  "AGENTS.md",
  "README.md",
  "packages/cli/README.md",
  "packages/cli/shim",
  "packages/cli/src/cli/help.ts",
  "UPGRADE.md",
  "references/adapters/package-surface-characterization.md",
  "references/cli/app-lifecycle-vocabulary.yaml",
  "references/cli/vocabulary.md",
] as const;

const retiredInstallerSurfaces = [
  "packages/cli/shim/lib/exec.mjs",
  "references/adapters/package-registry.yaml",
  "references/adapters/package-surface-characterization.md",
] as const;

const textExtensions = new Set([
  ".astro",
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".yaml",
  ".yml",
]);

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function commandAuthorityFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-authority-"));
  fs.mkdirSync(path.join(root, "references/adapters"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages/cli/src/cli"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages/cli/src/emitted"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/guidance.md"), "Run `npx -y agentera@next prime --format json`.\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "fixture license\n");
  fs.writeFileSync(path.join(root, "packages/cli/src/cli/preCutoverCommand.ts"), [
    "export const preCutoverCommand = (value: string) => value;",
    "export const preCutoverInstructionBody = (value: string) => value;",
    "export const preCutoverCommandFromBare = (value: string) => value;",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "packages/cli/src/emitted/guidance.ts"), [
    'import { preCutoverCommand } from "../cli/preCutoverCommand.js";',
    'preCutoverCommand("prime --format json");',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "references/adapters/package-registry.yaml"), YAML.stringify({
    records: [{
      identity: { id: "agentera" },
      bundle_surfaces: {
        directories: [{ path: "docs" }],
        files: [{ path: "LICENSE" }],
        generated_files: [{ path: "generated.json", format: "json", command_authority_reason: "Generated only during package construction." }],
      },
      bootstrap_command_authority: {
        exemptions: [{ path: "LICENSE", reason: "Legal fixture text." }],
        emitted_producers: [{ path: "packages/cli/src/emitted/guidance.ts", reason: "Guarded fixture producer." }],
      },
    }],
  }));
  return root;
}

function commandAuthorityPackageFixture(sourceRoot: string): string {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-authority-package-"));
  fs.mkdirSync(path.join(packageRoot, "bundle/references/adapters"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "bundle/docs"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "references/adapters/package-registry.yaml"), path.join(packageRoot, "bundle/references/adapters/package-registry.yaml"));
  fs.copyFileSync(path.join(sourceRoot, "docs/guidance.md"), path.join(packageRoot, "bundle/docs/guidance.md"));
  fs.copyFileSync(path.join(sourceRoot, "LICENSE"), path.join(packageRoot, "bundle/LICENSE"));
  fs.writeFileSync(path.join(packageRoot, "bundle/generated.json"), '{"schema":"fixture"}\n');
  return packageRoot;
}

function decodeRawCapabilityModule(relativePath: string): string {
  const source = read(relativePath);
  const literal = source.match(/JSON\.parse\(\s*String\.raw`([\s\S]*?)`,?\s*\);/);
  expect(literal, `${relativePath} instruction literal`).not.toBeNull();
  return JSON.parse(literal![1]) as string;
}

function currentSupportViolations(content: string): string[] {
  return forbiddenCurrentSupportPatterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([label]) => label);
}

function collectTextSurfaces(relativePath: string, surfaces: Set<string>): void {
  if (path.isAbsolute(relativePath) || relativePath.startsWith("~") || relativePath.includes("{")) {
    return;
  }

  const wildcard = relativePath.search(/[?*[]/);
  if (wildcard >= 0) {
    const prefix = relativePath.slice(0, wildcard);
    collectTextSurfaces(
      prefix.endsWith("/") ? prefix.slice(0, -1) : path.dirname(prefix),
      surfaces,
    );
    return;
  }

  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) return;
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(fullPath)) {
      collectTextSurfaces(path.join(relativePath, entry), surfaces);
    }
    return;
  }
  if (stat.isFile() && textExtensions.has(path.extname(relativePath))) {
    surfaces.add(relativePath);
  }
}

describe("retired runtime current-surface policy", () => {
  it("keeps complete raw and served startup guidance free of retired fields", async () => {
    const skill = read("skills/agentera/SKILL.md");
    const surfaces: Array<[string, string]> = [["skills/agentera/SKILL.md", skill]];

    for (const [capability, served] of Object.entries(CAPABILITY_INSTRUCTIONS)) {
      const modulePath = capabilityInstructionModulePath(capability);
      const raw = decodeRawCapabilityModule(modulePath);
      const module = await import(pathToFileURL(path.join(repoRoot, modulePath)).href);
      const canonical = typeof module.default === "string" ? module.default : raw;
      const expected = preCutoverInstructionBody(capability === "status" ? statusStartupInstructions(canonical) : canonical);
      surfaces.push([`${modulePath} raw instructions`, raw]);
      surfaces.push([`${modulePath} served instructions`, expected]);
      expect(expected, `${capability} served instructions`).toBe(served);
    }

    for (const [surface, guidance] of surfaces) {
      expect(retiredStartupGuidanceViolations(guidance), `${surface} retired startup fields`).toEqual([]);
    }
  });

  it("keeps every complete served body and active bundled bootstrap authority on @next", () => {
    for (const [capability, body] of Object.entries(CAPABILITY_INSTRUCTIONS)) {
      expect(preCutoverBootstrapGuidanceViolations(body), `${capability} complete served body`).toEqual([]);
      expect(body, `${capability} development bootstrap`).toContain(
        `npx -y agentera@next prime --context ${capability} --format json`,
      );
    }
    const authorities = registryBundledAuthorityPaths(repoRoot);
    expect(authorities).toEqual(expect.arrayContaining([
      "README.md",
      "UPGRADE.md",
      "references/cli/routing-model.md",
      "references/cli/vocabulary.md",
      "skills/agentera/SKILL.md",
    ]));
    expect(registryBundledAuthorityViolations(repoRoot), `${authorities.length} registry-owned source authorities`).toEqual([]);
  });

  it("rejects a wrong-channel executable injected into a formerly omitted Markdown tail", () => {
    const target = "references/cli/routing-model.md";
    const injected = `${read(target)}\n## Recovery regression\nRun \`agentera prime --context status --format json\`.\n`;
    const violations = registryBundledAuthorityViolations(repoRoot, new Map([[target, injected]]));
    expect(violations).toContain(`${target}: bare_executable`);
  });

  it.each([
    ["missing stable heading", read("UPGRADE.md").replace("## Stable v2 line", "## Stable line")],
    ["missing development heading", read("UPGRADE.md").replace("## Upgrading v2 to v3 development channel", "## Development migration")],
    ["duplicate stable heading", read("UPGRADE.md").replace("## Stable v2 line", "## Stable v2 line\n## Stable v2 line")],
    ["intervening section", read("UPGRADE.md").replace("## Upgrading v2 to v3 development channel", "## Unexpected section\n\n## Upgrading v2 to v3 development channel")],
  ])("fails closed when the UPGRADE.md stable-v2 boundary is invalid: %s", (_label, content) => {
    const violations = registryBundledAuthorityViolations(repoRoot, new Map([["UPGRADE.md", content]]));
    expect(violations).toContain("UPGRADE.md: stable_v2_section_boundary");
  });

  it("exempts only the two exact stable-v2 upgrade commands", () => {
    const content = read("UPGRADE.md").replace(
      "npx -y agentera@latest upgrade --dry-run",
      "npx -y agentera@latest prime --context status --format json",
    );
    expect(registryBundledAuthorityViolations(repoRoot, new Map([["UPGRADE.md", content]])))
      .toContain("UPGRADE.md: stable_v2_sequence");
  });

  it("distinguishes executable startup guidance from vocabulary labels", () => {
    expect(preCutoverBootstrapGuidanceViolations(
      "CLI-visible `agentera prime` labels are source labels; `agentera doctor` is a diagnostic name.",
    )).toEqual([]);
    expect(preCutoverBootstrapGuidanceViolations(
      "Recovery: Run `agentera doctor --format json`.",
    )).toEqual(["bare_executable"]);
    expect(preCutoverBootstrapGuidanceViolations(
      "```bash\nagentera prime --context status --format json\n```",
    )).toEqual(["bare_executable"]);
  });

  it.each([
    ["shell prompt", "$ agentera prime --context status --format json"],
    ["numbered list", "1. agentera doctor --format json"],
    ["prose", "For recovery, run agentera prime --context status --format json."],
    ["table", "| Recovery | agentera doctor --format json |"],
    ["wrapper", "```bash\nenv CI=1 agentera prime --context status --format json\n```"],
    ["quoted wrapper", "```bash\nbash -c 'agentera doctor --format json'\n```"],
    ["composition", "```bash\nnpx -y agentera@next doctor --format json && agentera prime --context status --format json\n```"],
    ["multiline continuation", "```bash\nagentera \\\n  prime --context status --format json\n```"],
    ["unicode whitespace", "```bash\nnpx\u00a0-y\u2003agentera@next prime --context status --format json\n```"],
  ])("rejects Markdown command evasion with complete diagnostics: %s", (_label, content) => {
    const diagnostics = preCutoverBootstrapAuthorityDiagnostics("fixture.md", content);
    expect(diagnostics).not.toEqual([]);
    expect(diagnostics[0]).toEqual(expect.objectContaining({
      path: "fixture.md",
      location: expect.objectContaining({ line: expect.any(Number), column: expect.any(Number) }),
      candidate: expect.objectContaining({ raw: expect.any(String), normalized: expect.any(String) }),
      violation: expect.any(String),
      correction: expect.stringContaining("npx -y agentera@next"),
    }));
  });

  it.each([
    ["env wrapper", "```bash\nenv CI=1 npx -y agentera@next prime --format json\n```", "command_wrapper"],
    ["and composition", "```bash\nnpx -y agentera@next prime --format json && true\n```", "command_composition"],
    ["pipeline", "```bash\nnpx -y agentera@next doctor --format json | jq .\n```", "command_composition"],
    ["substitution", "```bash\nresult=$(npx -y agentera@next prime --format json)\n```", "command_composition"],
    ["split dist-tag", "```bash\nnpx -y agentera@ne\"xt\" prime --format json\n```", "noncanonical_development_executable"],
  ])("rejects a non-exact complete shell context: %s", (_label, content, violation) => {
    const [diagnostic] = preCutoverBootstrapAuthorityDiagnostics("shell.md", content);
    expect(diagnostic).toEqual(expect.objectContaining({
      path: "shell.md",
      location: expect.objectContaining({ line: 2, column: expect.any(Number) }),
      candidate: expect.objectContaining({ raw: expect.any(String), normalized: expect.any(String) }),
      violation,
      correction: expect.stringMatching(/^npx -y agentera@next /),
    }));
  });

  it("treats standalone structured no-argument commands as executable", () => {
    expect(preCutoverBootstrapAuthorityDiagnostics("command.yaml", "nested:\n  command: agentera prime\n"))
      .toEqual([expect.objectContaining({
        location: { structured_path: '$["nested"]["command"]' },
        candidate: { raw: "agentera prime", normalized: "agentera prime" },
        violation: "bare_executable",
        correction: "npx -y agentera@next prime",
      })]);
  });

  it.each([
    ["duplicate JSON key", "duplicate.json", '{"command":"npx -y agentera@next prime","command":"agentera prime"}', "malformed_json"],
    ["recursive YAML alias", "cycle.yaml", "cycle: &cycle\n  self: *cycle\n", "malformed_yaml_alias_cycle"],
    ["excessive YAML aliases", "aliases.yaml", `base: &base [agentera prime]\nitems: [${Array.from({ length: 101 }, () => "*base").join(", ")}]\n`, "malformed_yaml"],
  ])("returns diagnostics instead of crashing for %s", (_label, surface, content, violation) => {
    const diagnostics = preCutoverBootstrapAuthorityDiagnostics(surface, content);
    expect(diagnostics).not.toEqual([]);
    expect(diagnostics[0]).toEqual(expect.objectContaining({
      path: surface,
      location: { structured_path: "$" },
      violation,
      correction: expect.any(String),
    }));
  });

  it("parses nested YAML and JSON strings, multiline values, and every candidate", () => {
    const yamlDiagnostics = preCutoverBootstrapAuthorityDiagnostics("fixture.yaml", [
      "outer:",
      "  prompts:",
      "    - >-",
      "        First run agentera prime",
      "        --context status --format json.",
      "    - recovery: npx -y agentera@latest doctor --format json",
    ].join("\n"));
    expect(yamlDiagnostics).toHaveLength(2);
    expect(yamlDiagnostics.map(({ location }) => location)).toEqual([
      { structured_path: '$["outer"]["prompts"][0]' },
      { structured_path: '$["outer"]["prompts"][1]["recovery"]' },
    ]);
    const jsonDiagnostics = preCutoverBootstrapAuthorityDiagnostics("fixture.json", JSON.stringify({
      nested: [{ command: "agentera doctor --format json; agentera prime --format json" }],
    }));
    expect(jsonDiagnostics).toHaveLength(1);
    expect(jsonDiagnostics[0]).toMatchObject({
      violation: "command_composition",
      candidate: { raw: "agentera doctor --format json; agentera prime --format json" },
    });
    expect(jsonDiagnostics.every(({ location }) => "structured_path" in location)).toBe(true);
  });

  it.each([
    ["fixture.yaml", "outer: [unterminated"],
    ["fixture.json", '{"outer": }'],
    ["fixture.md", "---\nouter: value\n# missing boundary"],
  ])("fails closed on malformed instructional input: %s", (surface, content) => {
    const [diagnostic] = preCutoverBootstrapAuthorityDiagnostics(surface, content);
    expect(diagnostic).toEqual(expect.objectContaining({
      path: surface,
      location: { structured_path: "$" },
      candidate: null,
      violation: expect.stringMatching(/^malformed_/),
      correction: expect.any(String),
    }));
  });

  it("accepts exact development commands and descriptive command vocabulary", () => {
    expect(preCutoverBootstrapAuthorityDiagnostics("fixture.md", [
      "```bash",
      "npx -y agentera@next prime --context status --format json",
      "```",
      "CLI-visible `agentera prime` labels and the `agentera doctor` diagnostic name are vocabulary.",
    ].join("\n"))).toEqual([]);
  });

  it.each([
    ["omission", (body: string) => body.replace(`${STABLE_V2_PREVIEW}\n`, "")],
    ["duplication", (body: string) => body.replace(STABLE_V2_PREVIEW, `${STABLE_V2_PREVIEW}\n${STABLE_V2_PREVIEW}`)],
    ["reversal", (body: string) => body.replace(`${STABLE_V2_PREVIEW}\n${STABLE_V2_APPLY}`, `${STABLE_V2_APPLY}\n${STABLE_V2_PREVIEW}`)],
    ["insertion", (body: string) => body.replace(`${STABLE_V2_PREVIEW}\n${STABLE_V2_APPLY}`, `${STABLE_V2_PREVIEW}\n# inserted\n${STABLE_V2_APPLY}`)],
    ["mutation", (body: string) => body.replace(STABLE_V2_PREVIEW, `${STABLE_V2_PREVIEW} --format json`)],
  ])("rejects stable-v2 pair %s", (_label, mutate) => {
    const violations = registryBundledAuthorityViolations(repoRoot, new Map([["UPGRADE.md", mutate(read("UPGRADE.md"))]]));
    expect(violations).toContain("UPGRADE.md: stable_v2_sequence");
  });

  it("rejects stable-channel execution outside the sole exemption", () => {
    const content = read("UPGRADE.md").replace(
      "npx -y agentera@next doctor --format json",
      "npx -y agentera@latest doctor --format json",
    );
    expect(registryBundledAuthorityViolations(repoRoot, new Map([["UPGRADE.md", content]])))
      .toContain("UPGRADE.md: stable_channel_outside_exemption");
  });

  it.each([
    ["inline no-arg", "Use `npx -y agentera@latest prime` only as a probe."],
    ["split quoted", "```bash\nnpx -y agentera@la\"test\" doctor --format json\n```"],
    ["continued", "```bash\nnpx -y agentera@latest \\\n  prime --format json\n```"],
  ])("rejects an outside stable-channel escape: %s", (_label, injected) => {
    const content = `${read("UPGRADE.md")}\n## Outside stable regression\n${injected}\n`;
    expect(registryBundledAuthorityViolations(repoRoot, new Map([["UPGRADE.md", content]])))
      .toContain("UPGRADE.md: stable_channel_outside_exemption");
  });

  it("publishes a closed source, generated, and emitted inventory with a reason for every classification", () => {
    const inventory = registryBootstrapAuthorityInventory(repoRoot);
    expect(inventory.diagnostics).toEqual([]);
    expect(new Set(inventory.records.map(({ surface }) => surface))).toEqual(new Set(["source", "generated", "emitted"]));
    expect(inventory.records.every(({ classification, reason }) =>
      ["parsed_and_scanned", "reason_classified"].includes(classification) && reason.length > 0)).toBe(true);
  });

  it.each([
    ["malformed", (root: string) => fs.writeFileSync(path.join(root, "docs/new.yaml"), "value: [unterminated"), "malformed_yaml"],
    ["unclassified", (root: string) => fs.writeFileSync(path.join(root, "docs/new.txt"), "new surface\n"), "inventory_unclassified"],
    ["omitted", (root: string) => fs.rmSync(path.join(root, "docs"), { recursive: true }), "inventory_omission"],
    ["producer", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/new.ts"), 'import { preCutoverCommand } from "../cli/preCutoverCommand.js";\npreCutoverCommand("doctor --format json");\n'), "emitted_producer_omitted"],
  ])("fails closed for a %s inventory change", (_label, mutate, violation) => {
    const root = commandAuthorityFixture();
    mutate(root);
    expect(registryBootstrapAuthorityInventory(root).diagnostics.map((diagnostic) => diagnostic.violation)).toContain(violation);
  });

  it.each([
    ["import alias", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/alias.ts"), [
      'import { preCutoverCommand as bind } from "../cli/preCutoverCommand.js";',
      'bind("prime");',
    ].join("\n"))],
    ["local wrapper", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/wrapper.ts"), [
      'import { preCutoverCommand } from "../cli/preCutoverCommand.js";',
      "const bind = (value: string) => preCutoverCommand(value);",
      'bind("prime");',
    ].join("\n"))],
    ["namespace value alias", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/namespace.ts"), [
      'import * as commands from "../cli/preCutoverCommand.js";',
      "const bind = commands.preCutoverCommand;",
      'bind("prime");',
    ].join("\n"))],
    ["re-export", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/reexport.ts"),
      'export { preCutoverCommand as bind } from "../cli/preCutoverCommand.js";\n')],
    ["re-export consumer", (root: string) => {
      fs.writeFileSync(path.join(root, "packages/cli/src/emitted/reexport.ts"), 'export { preCutoverCommand as bind } from "../cli/preCutoverCommand.js";\n');
      fs.writeFileSync(path.join(root, "packages/cli/src/emitted/consumer.ts"), 'import { bind } from "./reexport.js";\nbind("prime");\n');
    }],
  ])("discovers an unclassified %s producer", (_label, mutate) => {
    const root = commandAuthorityFixture();
    mutate(root);
    expect(registryBootstrapAuthorityInventory(root).diagnostics.map(({ violation }) => violation))
      .toContain("emitted_producer_omitted");
  });

  it.each([
    ["deleted child", (packageRoot: string) => fs.rmSync(path.join(packageRoot, "bundle/docs/guidance.md")), "package_inventory_missing"],
    ["extra child", (packageRoot: string) => fs.writeFileSync(path.join(packageRoot, "bundle/docs/extra.md"), "descriptive extra\n"), "package_inventory_extra_or_mismatched"],
    ["classification mismatch", (packageRoot: string) => {
      const registryPath = path.join(packageRoot, "bundle/references/adapters/package-registry.yaml");
      const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
      registry.records[0].bootstrap_command_authority.exemptions.push({ path: "docs/guidance.md", reason: "Incorrect package-only exemption." });
      fs.writeFileSync(registryPath, YAML.stringify(registry));
    }, "package_inventory_extra_or_mismatched"],
    ["generated declaration mismatch", (packageRoot: string) => {
      const registryPath = path.join(packageRoot, "bundle/references/adapters/package-registry.yaml");
      const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
      registry.records[0].bundle_surfaces.generated_files[0].command_authority_reason = "Changed only in package.";
      fs.writeFileSync(registryPath, YAML.stringify(registry));
    }, "package_inventory_extra_or_mismatched"],
  ])("fails exact source/package parity for a %s", (_label, mutate, violation) => {
    const sourceRoot = commandAuthorityFixture();
    const packageRoot = commandAuthorityPackageFixture(sourceRoot);
    mutate(packageRoot);
    const parity = registryBootstrapAuthorityParity(sourceRoot, packageRoot);
    expect(parity.diagnostics.map((diagnostic) => diagnostic.violation)).toContain(violation);
    expect(parity.package).not.toEqual(parity.source);
  });

  it("keeps complete machine help and recovery guidance on @next", () => {
    const surfaces: Array<[string, string]> = [
      ["prime guidance", PRIME_BLOB],
      ["top-level help", printTopLevelHelp()],
      ["route help", printRouteHelp()],
      ["upgrade help", printUpgradeHelp()],
      ...Object.keys(CAPABILITY_INSTRUCTIONS).map((capability): [string, string] => [
        `${capability} help`,
        printCapabilityHelp(capability),
      ]),
    ];
    for (const [surface, body] of surfaces) {
      expect(preCutoverBootstrapGuidanceViolations(body), surface).toEqual([]);
      expect(body, `${surface} stable channel`).not.toContain("agentera@latest");
    }
    expect(printTopLevelHelp()).toContain("Examples: npx -y agentera@next prime --context status --format json");
    expect(PRIME_BLOB).toContain("npx -y agentera@next doctor");
  });

  it.each([
    ["omitted tail", `${CAPABILITY_INSTRUCTIONS.build}\n### Tail\nRun \`agentera prime --context build --format json\`.`],
    ["stable tail", `${CAPABILITY_INSTRUCTIONS.build}\n### Tail\nRun \`npx -y agentera@latest prime --context build --format json\`.`],
  ])("rejects bootstrap authority outside sampled sections: %s", (_label, body) => {
    expect(preCutoverBootstrapGuidanceViolations(body)).not.toEqual([]);
  });

  it("rejects a retired field reintroduced outside a startup-contract section", () => {
    const outOfSectionFixture = `${CAPABILITY_INSTRUCTIONS.plan}\n### Handoff\nTrust source_contract.complete_for_handoff before reading state.`;

    expect(retiredStartupGuidanceViolations(outOfSectionFixture)).toEqual(["source_contract", "complete_for_*"]);
  });

  it("serves each capability module's canonical instruction export", async () => {
    for (const [capability, served] of Object.entries(CAPABILITY_INSTRUCTIONS)) {
      const modulePath = capabilityInstructionModulePath(capability);
      const raw = decodeRawCapabilityModule(modulePath);
      // Status keeps one canonical instruction vocabulary but publishes its
      // one-call startup wording through the same deterministic adapter used
      // by the runtime. Other capabilities remain raw and unchanged.
      const module = await import(pathToFileURL(path.join(repoRoot, modulePath)).href);
      const canonical = typeof module.default === "string" ? module.default : raw;
      const expected = preCutoverInstructionBody(capability === "status" ? statusStartupInstructions(canonical) : canonical);
      expect(expected, `${capability} expected instructions`).toBe(served);
      expect(currentSupportViolations(raw), `${modulePath} raw instructions`).toEqual([]);
      expect(currentSupportViolations(served), `${capability} served instructions`).toEqual([]);
    }
  });

  it("keeps public install surfaces free of active Claude claims", () => {
    const surfaces = new Set<string>([packageRegistryPath, "references/cli/vocabulary.md"]);
    for (const value of publicInstallSurfaceRoots) collectTextSurfaces(value, surfaces);
    expect([...surfaces]).toEqual(
      expect.arrayContaining([
        "README.md",
        "packages/cli/README.md",
        "packages/cli/shim/lib/exec.mjs",
      ]),
    );
    for (const surface of surfaces) {
      expect(currentSupportViolations(read(surface)), surface).toEqual([]);
    }
  });

  it.each([
    ["Task substrate", "Claude Code: Task tool"],
    ["question tool", "Use the Claude Code `AskUserQuestion` runtime tool"],
    ["supported list", "All supported runtimes: codex, claude-code, cursor"],
    ["opt-out flag", "Run profile with --no-claude"],
    ["install command", "npx skills add jgabor/agentera -g -a claude-code"],
    [
      "active native roster",
      "Canonical active runtime names are OpenCode, Codex, Cursor, and GitHub Copilot.",
    ],
    ["selector write contract", "Runtime writes require an explicit selector and --yes."],
    [
      "managed native repair",
      "App repair includes managed runtime config, plugins, hooks, commands, and safe cleanup.",
    ],
    ["package update flag", "External package manager changes require `--update-packages`."],
    ["bundle selector", "| `--only bundle` | Compatibility selector for narrow app-file work |"],
    [
      "runtime adapter",
      "Runtime-specific Agentera adapter support for skill loading, hooks, artifact validation.",
    ],
    ["plugin hooks", "Hooks that are shipped by active runtime plugin package surfaces."],
    [
      "native worker roster",
      "Runtime support for worker execution through OpenCode, Codex CLI, Cursor IDE, Copilot CLI.",
    ],
    ["setup doctor", "Diagnostic command surface for install/runtime health."],
  ])("rejects %s regressions", (_label, claim) => {
    expect(currentSupportViolations(claim)).not.toEqual([]);
  });

  it.each([
    "Claude Code is not a supported runtime. Use --import-source claude only for historical import.",
    "Retired Claude migration removes only the exact Agentera-owned legacy link.",
    "OpenCode supports .claude/skills as a Claude Code compatibility location.",
  ])("allows classified retirement and compatibility references: %s", (claim) => {
    expect(currentSupportViolations(claim)).toEqual([]);
  });

  it("documents host-neutral shared-skill support and retired Claude only", () => {
    const vocabulary = read("references/cli/vocabulary.md");
    expect(vocabulary).toContain("does not ship host-native package surfaces");
    expect(vocabulary).toContain(
      "Claude Code is a retired migration and consent-gated historical-import source",
    );
  });

  it("documents the shared-skill and CLI active contract", () => {
    for (const surface of ["README.md", "UPGRADE.md"]) {
      const content = read(surface);
      expect(content, surface).toContain("~/.agents/skills/agentera");
      expect(content, surface).toContain("CLI");
      expect(content, surface).not.toMatch(/--runtime all/);
    }
  });

  it("keeps active readiness surfaces on app, project, shared-skill, and CLI evidence", () => {
    const surfaces = [
      "README.md",
      "packages/cli/src/cli/help.ts",
      "skills/agentera/SKILL.md",
    ];
    const retiredClaims = [
      /detailed install and runtime evidence/i,
      /home directory for runtime detection/i,
      /same lifecycle snapshot/i,
      /aggregate lifecycle state/i,
      /aggregate release-blocking state/i,
      /runtime adapter availability and configuration diagnostics/i,
      /hook, package, and schema availability checks/i,
      /secure automatic lifecycle apply currently requires/i,
    ];
    for (const surface of surfaces) {
      const content = read(surface);
      for (const claim of retiredClaims) expect(content, `${surface}: ${claim}`).not.toMatch(claim);
    }

    expect(read("README.md")).toContain("app, project-state, shared-skill, and CLI evidence");
    expect(read("packages/cli/src/cli/help.ts")).toContain(
      "Home directory for shared-skill diagnosis",
    );
    expect(read("skills/agentera/SKILL.md")).toContain("One agent, one CLI");
  });

  it("keeps active upgrade guidance free of current runtime selectors", () => {
    for (const surface of ["README.md", "UPGRADE.md"]) {
      const content = read(surface);
      expect(content, surface).not.toMatch(/--runtime\s+(?:all|opencode|codex|cursor|copilot)/);
      expect(content, surface).toContain("--legacy-cleanup RESOURCE_ID");
    }
  });

  it("keeps active install contracts on the shared skill and explicit lifecycle path", () => {
    for (const surface of retiredInstallerSurfaces) {
      const content = read(surface);
      expect(content, surface).not.toMatch(/npx\s+skills\s+add\s+jgabor\/agentera/);
      expect(content, surface).not.toContain("install-agentera-skill");
      expect(content, surface).not.toMatch(/OpenCode portable-skill install/i);
    }
    for (const surface of ["packages/cli/README.md", "packages/cli/shim/lib/exec.mjs"]) {
      const content = read(surface);
      expect(content, surface).toContain("shared skill");
      expect(content, surface).toContain("CLI");
      expect(content, surface).not.toMatch(/--runtime\s+(?:all|opencode|codex|cursor|copilot)/);
      expect(content, surface).not.toMatch(/(?:copilot|codex) plugin (?:marketplace|install|add)/);
    }
  });
});
