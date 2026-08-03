import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_INSTRUCTIONS,
  capabilityInstructionModulePath,
} from "../../src/capabilities/index.js";
import { statusStartupInstructions } from "../../src/capabilities/status/startupInstructions.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const packageRegistryPath = "references/adapters/package-registry.yaml";

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
  it("serves each capability module's canonical instruction export", async () => {
    for (const [capability, served] of Object.entries(CAPABILITY_INSTRUCTIONS)) {
      const modulePath = capabilityInstructionModulePath(capability);
      const raw = decodeRawCapabilityModule(modulePath);
      // Status keeps one canonical instruction vocabulary but publishes its
      // one-call startup wording through the same deterministic adapter used
      // by the runtime. Other capabilities remain raw and unchanged.
      const module = await import(pathToFileURL(path.join(repoRoot, modulePath)).href);
      const canonical = typeof module.default === "string" ? module.default : raw;
      const expected = capability === "status" ? statusStartupInstructions(canonical) : canonical;
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
