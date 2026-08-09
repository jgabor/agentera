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
  DESCRIPTIVE_GRAMMAR_PRODUCTION_COUNT,
  NEGATION_GRAMMAR_PRODUCTION_COUNT,
  scanBootstrapAuthority,
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
        generated_files: [{
          id: "generated-fixture",
          path: "generated.json",
          format: "json",
          classification: "active",
          command_authority_reason: "Generated only during package construction.",
        }],
      },
      bootstrap_command_authority: {
        emitted_producers: [{ path: "packages/cli/src/emitted/guidance.ts", reason: "Guarded fixture producer." }],
        constructor_non_producers: [],
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
      expect(
        preCutoverBootstrapAuthorityDiagnostics(`${capability}.md`, body),
        `${capability} complete served body`,
      ).toEqual([]);
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
    ["substitution", "```bash\nresult=$(npx -y agentera@next prime --format json)\n```", "command_substitution"],
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

  it.each([
    ["suffix command substitution", "npx -y agentera@next prime $(touch /tmp/x)"],
    ["suffix backtick substitution", "npx -y agentera@next prime `printf x`"],
    ["suffix process substitution", "npx -y agentera@next prime <(printf x)"],
    ["redirection", "npx -y agentera@next prime > result.json"],
    ["background operation", "npx -y agentera@next prime & evil"],
    ["composed channel", "npx -y agentera@$(printf next) prime"],
    ["function-shaped bare identity", "agentera()"],
  ])("rejects a canonical-composition escape: %s", (_label, command) => {
    const scan = scanBootstrapAuthority("escape.md", `\`\`\`text\n${command}\n\`\`\`\n`);
    expect(scan.spans).toHaveLength(1);
    expect(scan.diagnostics).toEqual([expect.objectContaining({
      token: expect.objectContaining({ raw: expect.stringContaining("agentera") }),
      candidate: expect.objectContaining({ raw: expect.stringContaining("agentera") }),
      correction: expect.stringContaining("npx -y agentera@next"),
    })]);
  });

  it.each([
    ["ordinary output", "npx -y agentera@next prime > errors.log"],
    ["ordinary output append", "npx -y agentera@next prime >>errors.log"],
    ["ordinary input", "npx -y agentera@next prime < input.json"],
    ["ordinary descriptor duplication", "npx -y agentera@next prime >&1"],
    ["numeric output", "npx -y agentera@next prime 2> errors.log"],
    ["numeric output adjacent", "npx -y agentera@next prime 2>errors.log"],
    ["numeric output append", "npx -y agentera@next prime 2>> errors.log"],
    ["numeric output append adjacent", "npx -y agentera@next prime 2>>errors.log"],
    ["numeric input", "npx -y agentera@next prime 2< input.json"],
    ["numeric input adjacent", "npx -y agentera@next prime 2<input.json"],
    ["numeric descriptor duplication", "npx -y agentera@next prime 2>&1"],
  ])("rejects a bounded shell redirection in the IR: %s", (_label, command) => {
    const scan = scanBootstrapAuthority("redirection.md", `\`\`\`bash\n${command}\n\`\`\`\n`);
    expect(scan.spans).toHaveLength(1);
    expect(scan.spans[0]).toEqual(expect.objectContaining({
      candidate: { raw: command, normalized: command },
      traits: expect.objectContaining({ composed: true, composition_kinds: ["redirection"] }),
    }));
    expect(scan.diagnostics).toEqual([expect.objectContaining({
      candidate: { raw: command, normalized: command },
      violation: "command_composition",
      correction: "npx -y agentera@next prime",
    })]);
  });

  it.each([
    ["command substitution", "npx -y agentera@next prime $(printf x)", "command_substitution"],
    ["backtick substitution", "npx -y agentera@next prime `printf x`", "backtick_substitution"],
    ["process substitution", "npx -y agentera@next prime <(printf x)", "process_substitution"],
    ["redirection", "npx -y agentera@next prime > result.json", "redirection"],
    ["numeric FD redirection", "npx -y agentera@next prime 2>>result.log", "redirection"],
    ["background", "npx -y agentera@next prime & printf x", "background"],
    ["group", "(npx -y agentera@next prime)", "group"],
    ["operator", "npx -y agentera@next prime && printf x", "operator"],
  ])("returns one complete canonical sibling-local correction for %s", (_label, invalid, kind) => {
    const content = `${invalid}\nagentera sibling\n`;
    const scan = scanBootstrapAuthority("correction.md", content);
    const diagnostic = scan.diagnostics.find(({ token }) => token?.normalized === "agentera@next");
    const sibling = scan.spans.find(({ token }) => token.normalized === "agentera");
    expect(diagnostic, `${_label}: development diagnostic`).toBeDefined();
    expect(sibling?.candidate.raw).toBe("agentera sibling");
    expect(diagnostic).toEqual(expect.objectContaining({
      candidate: { raw: invalid, normalized: invalid },
      correction: "npx -y agentera@next prime",
      traits: expect.objectContaining({ composition_kinds: expect.arrayContaining([kind]) }),
    }));
    expect(diagnostic!.correction).not.toBe(diagnostic!.candidate?.raw);
    expect(diagnostic!.correction).not.toBe(diagnostic!.candidate?.normalized);
    expect(preCutoverBootstrapAuthorityDiagnostics("correction-result.md", `${diagnostic!.correction}\n`)).toEqual([]);
    const corrected = `${content.slice(0, diagnostic!.command_boundary!.start)}${diagnostic!.correction}${content.slice(diagnostic!.command_boundary!.end)}`;
    expect(corrected.slice(corrected.indexOf("agentera sibling"))).toBe("agentera sibling\n");
  });

  it.each([
    ["command substitution prefix", "$(npx -y agentera@next prime)", "command_substitution"],
    ["backtick substitution prefix", "`npx -y agentera@next prime`", "backtick_substitution"],
    ["input process substitution prefix", "<(npx -y agentera@next prime)", "process_substitution"],
    ["output process substitution prefix", ">(npx -y agentera@next prime)", "process_substitution"],
  ])("removes the complete %s without touching a sibling", (_label, invalid, kind) => {
    const scan = scanBootstrapAuthority("prefix.md", `\`\`\`bash\n${invalid}\nagentera sibling\n\`\`\`\n`);
    const diagnostic = scan.diagnostics.find(({ token }) => token?.normalized === "agentera@next");
    expect(diagnostic).toEqual(expect.objectContaining({
      candidate: { raw: invalid, normalized: invalid },
      correction: "npx -y agentera@next prime",
      traits: expect.objectContaining({ composition_kinds: expect.arrayContaining([kind]) }),
    }));
    expect(scan.spans.find(({ token }) => token.normalized === "agentera")?.candidate.raw).toBe("agentera sibling");
    expect(preCutoverBootstrapAuthorityDiagnostics("prefix-correction.md", `${diagnostic!.correction}\n`)).toEqual([]);
  });

  it("retains complete quoted command syntax before removing composition", () => {
    const invalid = 'npx -y agentera@next prime --context "status" `printf x`';
    const [diagnostic] = preCutoverBootstrapAuthorityDiagnostics("quoted-correction.md", `\`\`\`bash\n${invalid}\n\`\`\`\n`);
    expect(diagnostic).toEqual(expect.objectContaining({
      candidate: { raw: invalid, normalized: invalid },
      correction: 'npx -y agentera@next prime --context "status"',
    }));
    expect(preCutoverBootstrapAuthorityDiagnostics("quoted-result.md", `${diagnostic.correction}\n`)).toEqual([]);
  });

  it.each([
    ["double quote", 'npx -y agentera@next prime --context "status', "npx -y agentera@next prime --context"],
    ["single quote", "npx -y agentera@next prime --context 'status", "npx -y agentera@next prime --context"],
  ])("marks an unclosed suffix %s malformed and corrects from closed words", (_label, invalid, correction) => {
    const content = `${invalid}\nagentera sibling\n`;
    const scan = scanBootstrapAuthority("unclosed-quote.md", content);
    const diagnostic = scan.diagnostics.find(({ token }) => token?.normalized === "agentera@next");
    expect(diagnostic).toEqual(expect.objectContaining({
      candidate: { raw: invalid, normalized: invalid },
      violation: "malformed_command_context",
      correction,
      traits: expect.objectContaining({ malformed: true }),
    }));
    expect(diagnostic!.correction).not.toBe(diagnostic!.candidate!.raw);
    expect(preCutoverBootstrapAuthorityDiagnostics("quote-correction.md", `${diagnostic!.correction}\n`)).toEqual([]);
    expect(scan.spans.find(({ token }) => token.normalized === "agentera")?.candidate.raw).toBe("agentera sibling");
  });

  it.each([
    ['npx -y agentera@next prime --context "sta\\\"tus"', false],
    ["npx -y agentera@next prime --context 'status'", false],
    ['npx -y agentera@next prime --context "status"', false],
  ])("keeps a closed or escaped suffix quote well formed: %s", (command, malformed) => {
    const [span] = scanBootstrapAuthority("closed-quote.yaml", `command: ${JSON.stringify(command)}\n`).spans;
    expect(span.traits.malformed).toBe(malformed);
  });

  it("scans stable commands in a Markdown text fence", () => {
    expect(preCutoverBootstrapAuthorityDiagnostics(
      "stable-text.md",
      "```text\nnpx -y agentera@latest prime --format json\n```\n",
    )).toEqual([expect.objectContaining({ violation: "stable_channel_outside_exemption" })]);
  });

  it("does not treat documented angle placeholders as shell operators", () => {
    expect(preCutoverBootstrapAuthorityDiagnostics(
      "placeholder.md",
      "```bash\nnpx -y agentera@next state <progress|decisions|plan|health> explain --verb <verb> --format json\n```\n",
    )).toEqual([]);
  });

  it.each([
    "Run agentera CLI now.",
    "The agentera CLI is descriptive; run agentera destroy --yes.",
  ])("does not let descriptive vocabulary authorize a positive sibling: %s", (content) => {
    expect(preCutoverBootstrapAuthorityDiagnostics("contamination.md", content)).not.toEqual([]);
  });

  it("maps escaped JSON siblings to exact ordered raw ranges", () => {
    const content = '{"command":"Run \\u0061gentera one; agentera two"}';
    const scan = scanBootstrapAuthority("escaped.json", content);
    expect(scan.spans).toHaveLength(2);
    const firstStart = content.indexOf("\\u0061gentera");
    const secondStart = content.indexOf("agentera two");
    expect(scan.spans.map(({ raw_document_offsets }) => raw_document_offsets)).toEqual([
      { start: firstStart, end: firstStart + "\\u0061gentera".length },
      { start: secondStart, end: secondStart + "agentera".length },
    ]);
    expect(scan.spans.map(({ raw_document_offsets }) => raw_document_offsets && content
      .slice(raw_document_offsets.start, raw_document_offsets.end))).toEqual(["\\u0061gentera", "agentera"]);
  });

  it("segments no-space operator siblings into disjoint corrections", () => {
    const scan = scanBootstrapAuthority("operators.md", "agentera three|agentera four\n");
    expect(scan.spans.map(({ command_boundary, candidate }) => [command_boundary, candidate.raw])).toEqual([
      [{ start: 0, end: 14 }, "agentera three"],
      [{ start: 15, end: 28 }, "agentera four"],
    ]);
    expect(scan.diagnostics.map(({ correction }) => correction)).toEqual([
      "npx -y agentera@next three",
      "npx -y agentera@next four",
    ]);
  });

  it("treats standalone structured no-argument commands as executable", () => {
    expect(preCutoverBootstrapAuthorityDiagnostics("command.yaml", "nested:\n  command: agentera prime\n"))
      .toEqual([expect.objectContaining({
        location: { structured_path: '$["nested"]["command"]', offset: 0 },
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
      { structured_path: '$["outer"]["prompts"][0]', offset: 10 },
      { structured_path: '$["outer"]["prompts"][1]["recovery"]', offset: 7 },
    ]);
    const jsonDiagnostics = preCutoverBootstrapAuthorityDiagnostics("fixture.json", JSON.stringify({
      nested: [{ command: "agentera doctor --format json; agentera prime --format json" }],
    }));
    expect(jsonDiagnostics).toHaveLength(2);
    expect(jsonDiagnostics).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
      violation: "command_composition",
      candidate: expect.objectContaining({ raw: expect.stringMatching(/^agentera (?:doctor|prime)/) }),
    })));
    expect(jsonDiagnostics.every(({ location }) => "structured_path" in location)).toBe(true);
  });

  it.each(["state", "schema", "check", "report", "future-command"])(
    "recognizes %s without a subcommand allowlist",
    (subcommand) => {
      expect(preCutoverBootstrapAuthorityDiagnostics(
        "universal.md",
        `- agentera ${subcommand}`,
      )).toEqual([expect.objectContaining({
        candidate: expect.objectContaining({ raw: `agentera ${subcommand}` }),
        violation: "bare_executable",
      })]);
      expect(preCutoverBootstrapAuthorityDiagnostics(
        "universal.md",
        `- npx -y agentera@next ${subcommand}`,
      )).toEqual([]);
    },
  );

  it.each([
    ["YAML literal", "commands.yaml", "command: |\n  npx -y agentera@next prime --format json\n  agentera state todo list\n", ["bare_executable"]],
    ["YAML folded", "commands.yaml", "command: >-\n  npx -y agentera@next prime --format json;\n  agentera schema --format json\n", ["command_composition", "command_composition"]],
    ["JSON multiline", "commands.json", JSON.stringify({ command: "npx -y agentera@next check compact\nagentera report profile-grounding" }), ["bare_executable"]],
  ])("inspects every command boundary in %s", (_label, surface, content, expectedViolations) => {
    const diagnostics = preCutoverBootstrapAuthorityDiagnostics(surface, content);
    expect(diagnostics.map(({ violation }) => violation)).toEqual(expectedViolations);
    expect(diagnostics.some(({ candidate }) => candidate?.normalized.includes("agentera state")
      || candidate?.normalized.includes("agentera schema")
      || candidate?.normalized.includes("agentera report"))).toBe(true);
  });

  it("returns one diagnostic per Agentera invocation in a composed scalar", () => {
    const diagnostics = preCutoverBootstrapAuthorityDiagnostics(
      "commands.json",
      JSON.stringify({ command: "npx -y agentera@next prime; agentera state todo list" }),
    );
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every(({ violation }) => violation === "command_composition")).toBe(true);
  });

  it.each([
    ["executable YAML inline command", "command.yaml", "command: 'Run `agentera future-one` now.'\n", 1],
    ["imperative descriptive YAML value", "description.yaml", "description: Run agentera future-one now.\n", 1],
    ["complete Markdown statement", "commands.md", "Run `agentera future-one`; and then `agentera future-two`.\n", 2],
  ])("preserves executable context for a %s", (_label, surface, content, count) => {
    const diagnostics = preCutoverBootstrapAuthorityDiagnostics(surface, content);
    expect(diagnostics).toHaveLength(count);
    expect(diagnostics.every(({ violation }) => violation === "bare_executable")).toBe(true);
  });

  it("keeps descriptive structured vocabulary non-executable", () => {
    expect(preCutoverBootstrapAuthorityDiagnostics(
      "description.yaml",
      "description: The `agentera future-one` label names a future command.\n",
    )).toEqual([]);
  });

  it("keeps every invocation distinct above the retired shell nesting bound", () => {
    const command = Array.from({ length: 10 }).reduce(
      (payload) => `bash -c ${JSON.stringify(payload)}`,
      "agentera future-one; agentera future-two",
    );
    const diagnostics = preCutoverBootstrapAuthorityDiagnostics(
      "nested.yaml",
      YAML.stringify({ command }),
    );
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every(({ violation }) => violation === "command_composition")).toBe(true);
    expect(new Set(diagnostics.map(({ location }) => JSON.stringify(location))).size).toBe(2);
  });

  it("keeps statement inventory boundaries authoritative through context, diagnostics, and corrections", () => {
    const grouped = preCutoverBootstrapAuthorityDiagnostics(
      "grouped.md",
      "Run (agentera one) && agentera two | agentera three; agentera four.\n",
    );
    expect(grouped).toHaveLength(4);
    expect(grouped.map(({ location }) => location)).toEqual([
      { line: 1, column: 6 },
      { line: 1, column: 23 },
      { line: 1, column: 38 },
      { line: 1, column: 54 },
    ]);
    expect(grouped.map(({ candidate, correction }) => [candidate?.raw, correction])).toEqual([
      ["agentera one", "npx -y agentera@next one"],
      ["agentera two", "npx -y agentera@next two"],
      ["agentera three", "npx -y agentera@next three"],
      ["agentera four", "npx -y agentera@next four"],
    ]);

    expect(preCutoverBootstrapAuthorityDiagnostics(
      "negated-positive.md",
      "Do not run agentera old-command; instead use agentera second-future.\n",
    )).toEqual([expect.objectContaining({
      location: { line: 1, column: 46 },
      candidate: { raw: "agentera second-future", normalized: "agentera second-future" },
      correction: "npx -y agentera@next second-future",
    })]);

    const repeated = preCutoverBootstrapAuthorityDiagnostics(
      "repeated.md",
      "Run agentera same; then agentera same.\n",
    );
    expect(repeated).toHaveLength(2);
    expect(repeated.map(({ location }) => location)).toEqual([
      { line: 1, column: 5 },
      { line: 1, column: 25 },
    ]);

    const stable = preCutoverBootstrapAuthorityDiagnostics(
      "latest.md",
      "Run npx -y agentera@latest one; then npx -y agentera@latest two.\n",
    );
    expect(stable).toHaveLength(2);
    expect(stable.map(({ location }) => location)).toEqual([
      { line: 1, column: 12 },
      { line: 1, column: 45 },
    ]);
    expect(stable.map(({ candidate, correction }) => [candidate?.raw, correction])).toEqual([
      ["npx -y agentera@latest one", "npx -y agentera@next one"],
      ["npx -y agentera@latest two", "npx -y agentera@next two"],
    ]);

    const nestedCommand = Array.from({ length: 10 }).reduce(
      (payload) => `bash -c ${JSON.stringify(payload)}`,
      "agentera first; agentera second",
    );
    const nested = preCutoverBootstrapAuthorityDiagnostics(
      "nested-boundaries.yaml",
      YAML.stringify({ command: nestedCommand }),
    );
    expect(nested).toHaveLength(2);
    expect(nested.every(({ location }) => "structured_path" in location
      && location.structured_path === '$["command"]'
      && typeof location.offset === "number")).toBe(true);
    expect(new Set(nested.map(({ location }) => JSON.stringify(location))).size).toBe(2);
    expect(nested.map(({ candidate, correction }) => [candidate?.raw, correction])).toEqual([
      ["agentera first", "npx -y agentera@next first"],
      ["agentera second", "npx -y agentera@next second"],
    ]);

    expect(preCutoverBootstrapAuthorityDiagnostics(
      "split-latest.md",
      "```bash\nnpx -y agentera@la\"test\" doctor --format json\n```\n",
    )).toEqual([expect.objectContaining({
      location: { line: 2, column: 8 },
      candidate: { raw: 'npx -y agentera@la"test" doctor --format json', normalized: "npx -y agentera@latest doctor --format json" },
      correction: "npx -y agentera@next doctor --format json",
    })]);
  });

  it("inventories mixed statement spans before context filtering and diagnoses every invalid boundary", () => {
    const nested = (depth: number): string => Array.from({ length: depth }).reduce(
      (payload) => `bash -c ${JSON.stringify(payload)}`,
      "agentera first-future; agentera second-future",
    );
    const matrix = [
      {
        label: "audit-2 inline to unquoted",
        path: "audit-2.md",
        statement: "Run `agentera first-future`; and then agentera second-future.",
        content: "Run `agentera first-future`; and then agentera second-future.\n",
        invocations: ["first-future", "second-future"],
        violations: ["bare_executable", "command_composition"],
      },
      {
        label: "unquoted to inline",
        path: "reverse.md",
        statement: "Run agentera first-future; and then `agentera second-future`.",
        content: "Run agentera first-future; and then `agentera second-future`.\n",
        invocations: ["first-future", "second-future"],
        violations: ["command_composition", "bare_executable"],
      },
      {
        label: "quoted to unquoted",
        path: "quoted.md",
        statement: "Run 'agentera first-future'; and then agentera second-future.",
        content: "Run 'agentera first-future'; and then agentera second-future.\n",
        invocations: ["first-future", "second-future"],
        violations: ["command_composition", "command_wrapper"],
      },
      {
        label: "alternating punctuation",
        path: "alternating.md",
        statement: "Run `agentera first-future`; then agentera second-future, then 'agentera third-future'; finally `agentera fourth-future`.",
        content: "Run `agentera first-future`; then agentera second-future, then 'agentera third-future'; finally `agentera fourth-future`.\n",
        invocations: ["first-future", "second-future", "third-future", "fourth-future"],
        violations: ["bare_executable", "bare_executable", "command_composition", "command_wrapper"],
      },
      {
        label: "explicit YAML command",
        path: "mixed.yaml",
        statement: "Run `agentera first-future`; then agentera second-future.",
        content: YAML.stringify({ command: "Run `agentera first-future`; then agentera second-future." }),
        invocations: ["first-future", "second-future"],
        violations: ["bare_executable", "command_composition"],
      },
      {
        label: "explicit JSON command",
        path: "mixed.json",
        statement: "Run agentera first-future; then `agentera second-future`.",
        content: JSON.stringify({ command: "Run agentera first-future; then `agentera second-future`." }),
        invocations: ["first-future", "second-future"],
        violations: ["bare_executable", "command_composition"],
      },
      {
        label: "imperative description",
        path: "description.yaml",
        statement: "Run `agentera first-future`; then agentera second-future.",
        content: YAML.stringify({ description: "Run `agentera first-future`; then agentera second-future." }),
        invocations: ["first-future", "second-future"],
        violations: ["bare_executable", "command_composition"],
      },
      {
        label: "multiline structured statement",
        path: "multiline.yaml",
        statement: "Run `agentera first-future`;\nthen agentera second-future.",
        content: "command: |-\n  Run `agentera first-future`;\n  then agentera second-future.\n",
        invocations: ["first-future", "second-future"],
        violations: ["bare_executable", "bare_executable"],
      },
      {
        label: "multiline emitted guidance statement",
        path: "emitted-guidance.md",
        statement: "Run `agentera first-future`;\nand then agentera second-future.",
        content: "Run `agentera first-future`;\nand then agentera second-future.\n",
        invocations: ["first-future", "second-future"],
        violations: ["bare_executable", "bare_executable"],
      },
      ...[7, 8, 10].map((depth) => ({
        label: `nested depth ${depth}`,
        path: `nested-${depth}.yaml`,
        statement: nested(depth),
        content: YAML.stringify({ command: nested(depth) }),
        invocations: ["first-future", "second-future"],
        violations: Array.from({ length: 2 }, () => "command_composition"),
      })),
      {
        label: "independent stable occurrences",
        path: "stable.md",
        statement: "Run `npx -y agentera@latest first-future`; then npx -y agentera@latest second-future.",
        content: "Run `npx -y agentera@latest first-future`; then npx -y agentera@latest second-future.\n",
        invocations: ["first-future", "second-future"],
        violations: ["stable_channel_outside_exemption", "stable_channel_outside_exemption"],
      },
    ];

    for (const { label, path: surface, statement, content, invocations, violations } of matrix) {
      const spans = scanBootstrapAuthority(surface, content).spans;
      expect(spans, `${label}: inventory`).toHaveLength(invocations.length);
      expect(new Set(spans.map(({ identity }) => identity)).size, `${label}: offset identity`).toBe(spans.length);
      const rawOffsets = spans.flatMap(({ raw_document_offsets: offsets }) => offsets ? [offsets] : []);
      expect(rawOffsets.every((offsets, index) => index === 0
        || rawOffsets[index - 1].end <= offsets.start), `${label}: raw non-overlap`).toBe(true);

      const diagnostics = preCutoverBootstrapAuthorityDiagnostics(surface, content);
      expect(diagnostics, `${label}: diagnostics`).toHaveLength(invocations.length);
      expect(diagnostics.map(({ violation }) => violation).sort(), `${label}: violations`)
        .toEqual([...violations].sort());
      const unmatched = [...diagnostics];
      for (const invocation of invocations) {
        const match = unmatched.findIndex(({ candidate }) => candidate?.normalized.includes(invocation));
        expect(match, `${label}: candidate for ${invocation}`).toBeGreaterThanOrEqual(0);
        unmatched.splice(match, 1);
      }
      expect(diagnostics.every((diagnostic) =>
        diagnostic.path === surface
        && ("line" in diagnostic.location || diagnostic.location.structured_path.startsWith("$"))
        && diagnostic.candidate !== null
        && diagnostic.candidate.raw.length > 0
        && diagnostic.candidate.normalized.length > 0
        && diagnostic.violation.length > 0
        && diagnostic.correction.includes("npx -y agentera@next")), `${label}: complete diagnostics`).toBe(true);
    }

    expect(preCutoverBootstrapAuthorityDiagnostics(
      "negated.md",
      "Do not run `agentera first-future`; and never invoke agentera second-future.\n",
    )).toEqual([]);
    expect(preCutoverBootstrapAuthorityDiagnostics(
      "description.yaml",
      "description: The `agentera first-future` label and agentera second-future namespace are descriptive.\n",
    )).toEqual([]);
  });

  it.each([
    ["time", "command: time agentera state todo list\n", "command_wrapper"],
    ["eval", "command: eval agentera schema --format json\n", "command_wrapper"],
    ["nested bash", "command: bash -c \"printf ok; agentera check compact\"\n", "command_composition"],
  ])("rejects the %s wrapper without recognizing its subcommand", (_label, content, violation) => {
    expect(preCutoverBootstrapAuthorityDiagnostics("wrapper.yaml", content)).toEqual([
      expect.objectContaining({ violation }),
    ]);
  });

  it("uses one offset-preserving IR for the direct command-boundary matrix", () => {
    const cases = [
      ["substitution siblings", "Run $(agentera sub-one)&&agentera sub-two.\n", 2],
      ["whole double quoted latest", '"npx -y agentera@latest future-command"\n', 1],
      ["whole single quoted latest", "'npx -y agentera@latest future-command'\n", 1],
      ["split double latest", 'npx -y agentera@la"test" future-command\n', 1],
      ["split single latest", "npx -y agentera@la'test' future-command\n", 1],
      ["inline to unquoted", "Run `agentera one`; then agentera two.\n", 2],
      ["unquoted to inline", "Run agentera one; then `agentera two`.\n", 2],
      ["all grouping operators", "Run (agentera one) && agentera two || agentera three | agentera four; agentera five.\n", 5],
      ["repeated identical", "Run agentera same; then agentera same.\n", 2],
      ["canonical composition", "npx -y agentera@next prime --format json && true\n", 1],
    ] as const;

    for (const [label, content, count] of cases) {
      const scan = scanBootstrapAuthority(`${label}.md`, content);
      expect(scan.spans, `${label}: IR count`).toHaveLength(count);
      expect(scan.diagnostics, `${label}: diagnostic count`).toHaveLength(count);
      expect(new Set(scan.spans.map(({ identity }) => identity)).size, `${label}: span identity`).toBe(count);
      expect(new Set(scan.diagnostics.map(({ location }) => JSON.stringify(location))).size, `${label}: location identity`).toBe(count);
      scan.spans.forEach((span, index) => {
        const diagnostic = scan.diagnostics[index];
        expect(span.token.raw.length, `${label}: raw token`).toBeGreaterThan(0);
        expect(span.token.normalized.length, `${label}: normalized token`).toBeGreaterThan(0);
        expect(span.candidate.raw, `${label}: raw candidate`).toBe(diagnostic.candidate?.raw);
        expect(span.candidate.normalized, `${label}: normalized candidate`).toBe(diagnostic.candidate?.normalized);
        expect(span.offset_map, `${label}: offset map`).toHaveLength(span.token.normalized.length);
        expect(span.command_boundary.start, `${label}: boundary start`).toBeLessThan(span.command_boundary.end);
        const corrected = `${content.slice(0, span.command_boundary.start)}${diagnostic.correction}${content.slice(span.command_boundary.end)}`;
        expect(corrected.startsWith(content.slice(0, span.command_boundary.start)), `${label}: prefix preserved`).toBe(true);
        expect(corrected.endsWith(content.slice(span.command_boundary.end)), `${label}: suffix preserved`).toBe(true);
        expect(diagnostic.violation.length, `${label}: violation`).toBeGreaterThan(0);
      });
    }
  });

  it("classifies shell and process substitution without detached recursion", () => {
    const content = YAML.stringify({
      command: "out=$(agentera one); diff <(agentera two) >(agentera three); value=`agentera four`",
    });
    const scan = scanBootstrapAuthority("substitutions.yaml", content);
    expect(scan.spans).toHaveLength(4);
    expect(scan.diagnostics).toHaveLength(4);
    expect(scan.spans.every(({ nesting }) => nesting.depth > 0)).toBe(true);
    expect(scan.diagnostics.every(({ violation }) => ["command_composition", "command_substitution"].includes(violation))).toBe(true);
  });

  it("has no nesting bound below, at, or above the retired limit", () => {
    for (const depth of [7, 8, 10, 16]) {
      const command = Array.from({ length: depth }).reduce(
        (payload) => `bash -c ${JSON.stringify(payload)}`,
        "agentera first; agentera second",
      );
      const scan = scanBootstrapAuthority(`nested-${depth}.yaml`, YAML.stringify({ command }));
      expect(scan.spans, `depth ${depth}`).toHaveLength(2);
      expect(scan.spans.every(({ nesting }) => nesting.depth === depth), `depth ${depth}: metadata`).toBe(true);
      expect(scan.diagnostics, `depth ${depth}: diagnostics`).toHaveLength(2);
      expect(scan.diagnostics.every(({ violation }) => violation !== "nested_command_limit"), `depth ${depth}: no fallback`).toBe(true);
    }
  });

  it("keeps negated and positive boundaries independent", () => {
    expect(preCutoverBootstrapAuthorityDiagnostics(
      "negated.md",
      "Do not run `agentera old`; and never invoke agentera retired.\n",
    )).toEqual([]);
    const diagnostics = preCutoverBootstrapAuthorityDiagnostics(
      "mixed-negation.md",
      "Do not run `agentera old`; instead use agentera current.\n",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(expect.objectContaining({
      candidate: { raw: "agentera current", normalized: "agentera current" },
    }));
  });

  it("covers every exact negation grammar production and rejects its mutation", () => {
    const productions = [
      ["Do not run `agentera one`.", "Do now run `agentera one`."],
      ["and never invoke `agentera two`.", "and ever invoke `agentera two`."],
      ["MUST NOT call `agentera three`.", "MUST call `agentera three`."],
      ["never spawn by running `agentera build`.", "never spawn after running `agentera build`."],
      ["No unsupported `agentera plan`.", "No supported `agentera plan`."],
      ["This contract forbade a top-level `agentera corpus`.", "This contract allowed a top-level `agentera corpus`."],
    ] as const;
    expect(NEGATION_GRAMMAR_PRODUCTION_COUNT).toBe(productions.length);
    for (const [valid, mutation] of productions) {
      expect(preCutoverBootstrapAuthorityDiagnostics("negation.md", valid), valid).toEqual([]);
      expect(preCutoverBootstrapAuthorityDiagnostics("negation.md", mutation), mutation).toHaveLength(1);
    }
  });

  it.each([
    ["YAML literal", "matrix.yaml", "command: |-\n  Run agentera one;\n  then agentera two.\n", 2],
    ["JSON multiline", "matrix.json", JSON.stringify({ command: "Run agentera one;\nthen agentera two." }), 2],
    ["Markdown fence", "matrix.md", "```bash\nagentera one\n```\n", 1],
    ["Markdown inline", "matrix.md", "Run `agentera one`.\n", 1],
    ["Markdown table", "matrix.md", "| Action | agentera one |\n", 1],
    ["Markdown list", "matrix.md", "- agentera one\n", 1],
    ["Markdown continuation", "matrix.md", "```bash\nagentera \\\n  one\n```\n", 1],
  ])("keeps one boundary diagnostic in %s", (_label, surface, content, count) => {
    const scan = scanBootstrapAuthority(surface, content);
    expect(scan.spans).toHaveLength(count);
    expect(scan.diagnostics).toHaveLength(count);
    expect(new Set(scan.diagnostics.map(({ location }) => JSON.stringify(location))).size).toBe(count);
  });

  it.each([
    ["structured identity", "identity.yaml", "name: agentera\n"],
    ["label vocabulary", "labels.md", "The `agentera prime` label is descriptive.\n"],
    ["name vocabulary", "labels.md", "The `agentera doctor` diagnostic name is descriptive.\n"],
    ["namespace vocabulary", "labels.md", "The `agentera state` namespace is descriptive.\n"],
    ["stable package vocabulary", "labels.md", "The stable package identity is `agentera@latest`.\n"],
    ["JavaScript path", "paths.yaml", "value: agentera.js\n"],
    ["project path", "paths.yaml", "value: .agentera/\n"],
    ["schema identity", "paths.yaml", "value: agentera.schema.v1\n"],
  ])("allows bounded descriptive %s", (_label, surface, content) => {
    expect(preCutoverBootstrapAuthorityDiagnostics(surface, content)).toEqual([]);
  });

  it.each([
    ["identity key", "command: agentera\n"],
    ["label noun", "value: The `agentera prime` thing is descriptive.\n"],
    ["stable package argument", "value: The stable package identity is `agentera@latest future`.\n"],
  ])("rejects a descriptive grammar mutation: %s", (_label, content) => {
    expect(preCutoverBootstrapAuthorityDiagnostics("mutation.yaml", content)).toHaveLength(1);
  });

  it("keeps the descriptive grammar census tied to mutation coverage", () => {
    expect(DESCRIPTIVE_GRAMMAR_PRODUCTION_COUNT).toBe(10);
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
    ["unknown subcommand", "Use `npx -y agentera@latest future-command` only as a probe."],
    ["unknown wrapped subcommand", "```bash\ntime npx -y agentera@latest future-command\n```"],
    ["nested split quoted", "```bash\nbash -c 'npx -y agentera@la\"test\" future-command'\n```"],
  ])("rejects an outside stable-channel escape: %s", (_label, injected) => {
    const content = `${read("UPGRADE.md")}\n## Outside stable regression\n${injected}\n`;
    expect(registryBundledAuthorityViolations(repoRoot, new Map([["UPGRADE.md", content]])))
      .toContain("UPGRADE.md: stable_channel_outside_exemption");
  });

  it("publishes a closed source, generated, and emitted inventory with a reason for every classification", () => {
    const inventory = registryBootstrapAuthorityInventory(repoRoot);
    expect(inventory.diagnostics).toEqual([]);
    expect(new Set(inventory.records.map(({ surface }) => surface))).toEqual(new Set(["source", "generated", "emitted"]));
    expect(Object.fromEntries(["source", "generated", "emitted"].map((surface) => [
      surface,
      inventory.records.filter((record) => record.surface === surface).length,
    ]))).toEqual({ source: 93, generated: 2, emitted: 104 });
    expect(inventory.records.every(({ classification, reason }) =>
      ["parsed_and_scanned", "reason_classified"].includes(classification) && reason.length > 0)).toBe(true);
    expect(new Set(inventory.records
      .filter(({ surface }) => surface === "emitted")
      .map(({ emitted_classification }) => emitted_classification)))
      .toEqual(new Set(["producer", "non_producer"]));
    expect(inventory.census).toEqual(expect.objectContaining({
      scanned_scalars: 14805,
      invocation_occurrences: 546,
      canonical_development: 290,
      stable_pair: 2,
      noncanonical_occurrences: 254,
      noncanonical_scalars: 203,
      noncanonical_categories: {
        identity_only: 10,
        argument_bearing: 173,
        other_vocabulary: 20,
      },
      classification_uses: {
        bounded_descriptive: 15,
        exact_exemption: 182,
      },
      backticked_argument_contexts: 188,
    }));
    const registry = YAML.parse(read(packageRegistryPath));
    const authority = registry.records[0].bootstrap_command_authority;
    const declarations = authority.scalar_classifications;
    expect(authority).not.toHaveProperty("exemptions");
    expect(declarations).toHaveLength(197);
    expect(Object.fromEntries(["identity_only", "argument_bearing", "other_vocabulary"].map((category) => [
      category,
      declarations.filter((entry: any) => entry.category === category).length,
    ]))).toEqual({ identity_only: 10, argument_bearing: 168, other_vocabulary: 19 });
    expect(Object.fromEntries(["bounded_descriptive", "exact_exemption"].map((classification) => [
      classification,
      declarations.filter((entry: any) => entry.classification === classification).length,
    ]))).toEqual(inventory.census.classification_uses);
    expect(new Set(declarations.map((entry: any) => entry.reason)).size).toBe(declarations.length);
    expect(declarations.some((entry: any) => /^Exact reviewed (?:descriptive|structured|package)/u.test(entry.reason))).toBe(false);
    expect(Object.fromEntries(["producer", "non_producer"].map((classification) => [
      classification,
      inventory.records.filter((record) => record.emitted_classification === classification).length,
    ]))).toEqual({ producer: 51, non_producer: 53 });
    expect(inventory.records
      .filter(({ surface }) => surface === "generated")
      .map(({ generated_declaration }) => generated_declaration))
      .toEqual([
        {
          id: "npx-bundle-marker",
          path: ".agentera-npx-bundle.json",
          format: "json",
          classification: "active",
          reason: expect.any(String),
        },
        {
          id: "extract-corpus-parity",
          path: "extract-corpus-parity.json",
          format: "json",
          classification: "active",
          reason: expect.any(String),
        },
      ]);
  });

  it.each([
    ["missing", (entries: any[]) => entries.splice(entries.findIndex((entry) => entry.path === "skills/agentera/capability_schema_contract.yaml"), 1), "scalar_classification_missing"],
    ["stale", (entries: any[]) => { entries.find((entry) => entry.path === "skills/agentera/capability_schema_contract.yaml").normalized_sha256 = "0".repeat(64); }, "scalar_classification_stale"],
    ["unused", (entries: any[]) => entries.push({
      path: "README.md",
      region: "line:9999",
      category: "identity_only",
      classification: "bounded_descriptive",
      normalized_sha256: "0".repeat(64),
      reason: "Exact stale mutation fixture.",
    }), "scalar_classification_unused"],
    ["reasonless", (entries: any[]) => { entries.find((entry) => entry.path === "skills/agentera/capability_schema_contract.yaml").reason = ""; }, "scalar_classification_reason_missing"],
  ])("rejects a %s exact scalar classification", (_label, mutate, violation) => {
    const registry = YAML.parse(read(packageRegistryPath));
    mutate(registry.records[0].bootstrap_command_authority.scalar_classifications);
    expect(registryBundledAuthorityViolations(
      repoRoot,
      new Map([[packageRegistryPath, YAML.stringify(registry)]]),
    ).some((entry) => entry.endsWith(`: ${violation}`))).toBe(true);
  });

  it("rejects every added exact declaration when any required binding is removed or mutated", () => {
    const registry = YAML.parse(read(packageRegistryPath));
    const declarations = registry.records[0].bootstrap_command_authority.scalar_classifications;
    const addedPaths = new Set([
      "CHANGELOG.md",
      "DESIGN.md",
      "references/adapters/package-publication.json",
      "references/artifacts/state-storage-authority.yaml",
      "references/cli/update-channels.yaml",
    ]);
    const added = declarations.filter((entry: any) => addedPaths.has(entry.path));
    expect(added).toHaveLength(162);

    const mutations: Array<[string, (entries: any[]) => void, string]> = [
      ["missing", (entries) => {
        entries.splice(0, entries.length, ...entries.filter((entry) => !addedPaths.has(entry.path)));
      }, "scalar_classification_missing"],
      ["stale digest", (entries) => entries.filter((entry) => addedPaths.has(entry.path))
        .forEach((entry) => { entry.normalized_sha256 = "0".repeat(64); }), "scalar_classification_stale"],
      ["wrong category", (entries) => entries.filter((entry) => addedPaths.has(entry.path))
        .forEach((entry) => { entry.category = entry.category === "argument_bearing" ? "identity_only" : "argument_bearing"; }), "scalar_classification_category_mismatch"],
      ["missing reason", (entries) => entries.filter((entry) => addedPaths.has(entry.path))
        .forEach((entry) => { entry.reason = ""; }), "scalar_classification_reason_missing"],
    ];

    for (const [label, mutate, violation] of mutations) {
      const changed = structuredClone(registry);
      mutate(changed.records[0].bootstrap_command_authority.scalar_classifications);
      const violations = registryBundledAuthorityViolations(
        repoRoot,
        new Map([[packageRegistryPath, YAML.stringify(changed)]]),
      );
      expect(violations.filter((entry) => entry.endsWith(`: ${violation}`)), label).toHaveLength(162);
    }
  });

  it("rejects duplicate exact-declaration reasons", () => {
    const registry = YAML.parse(read(packageRegistryPath));
    const declarations = registry.records[0].bootstrap_command_authority.scalar_classifications;
    declarations[1].reason = declarations[0].reason;
    expect(registryBundledAuthorityViolations(
      repoRoot,
      new Map([[packageRegistryPath, YAML.stringify(registry)]]),
    )).toContain(`${declarations[1].path}: scalar_classification_reason_duplicate`);
  });

  it.each([
    ["state authority", "references/artifacts/state-storage-authority.yaml", (body: string) => {
      const value = YAML.parse(body);
      value.status = "Run agentera destroy --yes";
      return { body: YAML.stringify(value), region: '$["status"]' };
    }],
    ["changelog", "CHANGELOG.md", (body: string) => ({
      body: `${body}\nRun agentera destroy --yes\n`,
      region: `line:${body.split(/\r?\n/u).length + 1}`,
    })],
    ["publication smoke", "references/adapters/package-publication.json", (body: string) => {
      const value = JSON.parse(body);
      value.packages.development.smoke[2] = "Run agentera destroy --yes";
      return { body: JSON.stringify(value), region: '$["packages"]["development"]["smoke"][2]' };
    }],
    ["publication localSmoke", "references/adapters/package-publication.json", (body: string) => {
      const value = JSON.parse(body);
      value.packages.development.localSmoke[0] = "Run agentera destroy --yes";
      return { body: JSON.stringify(value), region: '$["packages"]["development"]["localSmoke"][0]' };
    }],
  ])("requires an exact declaration for an imperative %s mutation", (_label, target, mutate) => {
    const mutation = mutate(read(target));
    const registry = YAML.parse(read(packageRegistryPath));
    registry.records[0].bootstrap_command_authority.scalar_classifications = registry.records[0]
      .bootstrap_command_authority.scalar_classifications
      .filter((entry: any) => entry.path !== target || entry.region !== mutation.region);
    const violations = registryBundledAuthorityViolations(repoRoot, new Map([
      [target, mutation.body],
      [packageRegistryPath, YAML.stringify(registry)],
    ]));
    expect(violations).toContain(`${target}: scalar_classification_missing`);
    expect(violations).toContain(`${target}: bare_executable`);
  });

  it("rejects a changed scalar whose exact exemption digest is stale", () => {
    const target = "skills/agentera/capability_schema_contract.yaml";
    const changed = read(target).replace(
      "state-oriented CLI command for reading plan state. Do not",
      "state-oriented CLI command for reading all plan state. Do not",
    );
    expect(registryBundledAuthorityViolations(repoRoot, new Map([[target, changed]])))
      .toContain(`${target}: scalar_classification_stale`);
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
    ["assignment after declaration", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/assignment.ts"), [
      'import { preCutoverCommand } from "../cli/preCutoverCommand.js";',
      "let bind: typeof preCutoverCommand;",
      "bind = preCutoverCommand;",
      'bind("prime");',
    ].join("\n"))],
    ["conditional alias", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/conditional.ts"), [
      'import { preCutoverCommand } from "../cli/preCutoverCommand.js";',
      "const bind = Math.random() > 2 ? String : preCutoverCommand;",
      'bind("prime");',
    ].join("\n"))],
    ["namespace destructuring", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/destructure.ts"), [
      'import * as commands from "../cli/preCutoverCommand.js";',
      "const { preCutoverCommand: bind } = commands;",
      'bind("prime");',
    ].join("\n"))],
    ["namespace element access", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/element.ts"), [
      'import * as commands from "../cli/preCutoverCommand.js";',
      'commands["preCutoverCommand"]("prime");',
    ].join("\n"))],
    ["higher-order wrapper", (root: string) => fs.writeFileSync(path.join(root, "packages/cli/src/emitted/higherOrder.ts"), [
      'import { preCutoverCommand } from "../cli/preCutoverCommand.js";',
      "const apply = (fn: typeof preCutoverCommand) => fn;",
      'apply(preCutoverCommand)("prime");',
    ].join("\n"))],
  ])("discovers an unclassified %s producer", (_label, mutate) => {
    const root = commandAuthorityFixture();
    mutate(root);
    expect(registryBootstrapAuthorityInventory(root).diagnostics.map(({ violation }) => violation))
      .toContain("emitted_producer_omitted");
  });

  it("fails closed on a dynamic constructor consumer", () => {
    const root = commandAuthorityFixture();
    fs.writeFileSync(path.join(root, "packages/cli/src/emitted/dynamic.ts"), [
      'const commands = await import("../cli/preCutoverCommand.js");',
      'commands.preCutoverCommand("prime");',
    ].join("\n"));
    expect(registryBootstrapAuthorityInventory(root).diagnostics.map(({ violation }) => violation))
      .toContain("constructor_closure_dynamic_consumer");
  });

  it("rejects an unused scalar classification and a stale producer classification", () => {
    const root = commandAuthorityFixture();
    const registryPath = path.join(root, "references/adapters/package-registry.yaml");
    const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
    (registry.records[0].bootstrap_command_authority.scalar_classifications ??= []).push({ path: "docs/missing.md", region: "line:1", category: "identity_only", classification: "exact_exemption", normalized_sha256: "0".repeat(64), reason: "Exact missing fixture scalar." });
    fs.writeFileSync(registryPath, YAML.stringify(registry));
    fs.writeFileSync(path.join(root, "packages/cli/src/emitted/guidance.ts"), "export const guidance = 'descriptive';\n");
    const violations = registryBootstrapAuthorityInventory(root).diagnostics.map(({ violation }) => violation);
    expect(violations).toContain("scalar_classification_path_missing");
    expect(violations).toContain("emitted_producer_missing");
  });

  it.each([
    ["deleted child", (packageRoot: string) => fs.rmSync(path.join(packageRoot, "bundle/docs/guidance.md")), "package_inventory_missing"],
    ["extra child", (packageRoot: string) => fs.writeFileSync(path.join(packageRoot, "bundle/docs/extra.md"), "descriptive extra\n"), "package_inventory_extra_or_mismatched"],
    ["classification mismatch", (packageRoot: string) => {
      const registryPath = path.join(packageRoot, "bundle/references/adapters/package-registry.yaml");
      const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
      (registry.records[0].bootstrap_command_authority.scalar_classifications ??= []).push({ path: "docs/guidance.md", region: "line:1", category: "identity_only", classification: "exact_exemption", normalized_sha256: "0".repeat(64), reason: "Incorrect package-only scalar classification." });
      fs.writeFileSync(registryPath, YAML.stringify(registry));
    }, "package_inventory_extra_or_mismatched"],
    ["generated declaration mismatch", (packageRoot: string) => {
      const registryPath = path.join(packageRoot, "bundle/references/adapters/package-registry.yaml");
      const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
      registry.records[0].bundle_surfaces.generated_files[0].command_authority_reason = "Changed only in package.";
      fs.writeFileSync(registryPath, YAML.stringify(registry));
    }, "package_inventory_extra_or_mismatched"],
    ["constructor classification drift", (packageRoot: string) => {
      const registryPath = path.join(packageRoot, "bundle/references/adapters/package-registry.yaml");
      const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
      const [producer] = registry.records[0].bootstrap_command_authority.emitted_producers.splice(0, 1);
      registry.records[0].bootstrap_command_authority.constructor_non_producers.push(producer);
      fs.writeFileSync(registryPath, YAML.stringify(registry));
    }, "package_inventory_extra_or_mismatched"],
    ...(["id", "path", "format", "classification"] as const).map((field) => [
      `generated ${field} mismatch`,
      (packageRoot: string) => {
        const registryPath = path.join(packageRoot, "bundle/references/adapters/package-registry.yaml");
        const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
        registry.records[0].bundle_surfaces.generated_files[0][field] = `changed-${field}`;
        fs.writeFileSync(registryPath, YAML.stringify(registry));
      },
      "package_inventory_extra_or_mismatched",
    ] as const),
  ])("fails exact source/package parity for a %s", (label, mutate, violation) => {
    const sourceRoot = commandAuthorityFixture();
    const packageRoot = commandAuthorityPackageFixture(sourceRoot);
    mutate(packageRoot);
    const parity = registryBootstrapAuthorityParity(sourceRoot, packageRoot);
    expect(parity.diagnostics.map((diagnostic) => diagnostic.violation)).toContain(violation);
    if (label === "classification mismatch") expect(parity.package).toEqual(parity.source);
    else expect(parity.package).not.toEqual(parity.source);
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
      expect(preCutoverBootstrapAuthorityDiagnostics(`${surface}.md`, body), surface).toEqual([]);
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
