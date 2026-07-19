import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_INSTRUCTIONS,
  capabilityInstructionModulePath,
} from "../../src/capabilities/index.js";
import { statusStartupInstructions } from "../../src/capabilities/status/startupInstructions.js";
import { loadRegistry as loadPackageRegistry } from "../../src/registries/packageRegistry.js";
import { loadRegistry as loadRuntimeAdapterRegistry } from "../../src/registries/runtimeAdapterRegistry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const runtimeRegistryPath = "references/adapters/runtime-adapter-registry.yaml";
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
] as const;

const publicInstallSurfaceRoots = [
  "README.md",
  "packages/cli/README.md",
  "packages/cli/shim",
  "packages/cli/src/cli/help.ts",
  "packages/mobile/README.md",
  "packages/mobile/DESIGN.md",
  "packages/web/src/components/InstallTabs.astro",
  "packages/web/src/content/docs/docs",
  "UPGRADE.md",
  "references/adapters/package-surface-characterization.md",
  "references/adapters/runtime-adapter-characterization.md",
] as const;

const primaryLifecycleDocs = [
  "README.md",
  "packages/cli/README.md",
  "UPGRADE.md",
  "packages/web/src/content/docs/docs/getting-started/install.mdx",
  "references/adapters/runtime-feature-parity.md",
] as const;

const retiredInstallerSurfaces = [
  "packages/web/src/content/docs/docs/getting-started/install.mdx",
  "packages/web/src/components/InstallTabs.astro",
  "packages/cli/shim/lib/exec.mjs",
  "references/adapters/package-registry.yaml",
  "references/adapters/package-manifest-interface-model.yaml",
  "references/adapters/package-surface-characterization.md",
  "references/adapters/cursor.md",
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
  const marker = "JSON.parse(String.raw`";
  const start = source.indexOf(marker);
  const end = source.indexOf("`);", start + marker.length);
  expect(start, `${relativePath} instruction marker`).toBeGreaterThanOrEqual(0);
  expect(end, `${relativePath} instruction terminator`).toBeGreaterThan(start);
  return JSON.parse(source.slice(start + marker.length, end)) as string;
}

function currentSupportViolations(content: string): string[] {
  return forbiddenCurrentSupportPatterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([label]) => label);
}

function collectTextSurfaces(relativePath: string, surfaces: Set<string>): void {
  if (
    path.isAbsolute(relativePath)
    || relativePath.startsWith("~")
    || relativePath.includes("{")
  ) {
    return;
  }

  const wildcard = relativePath.search(/[?*[]/);
  if (wildcard >= 0) {
    const prefix = relativePath.slice(0, wildcard);
    collectTextSurfaces(prefix.endsWith("/") ? prefix.slice(0, -1) : path.dirname(prefix), surfaces);
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

function declaredCurrentSurfacePaths(): string[] {
  const surfaces = new Set<string>([runtimeRegistryPath, packageRegistryPath]);
  const runtimeRegistry = loadRuntimeAdapterRegistry(path.join(repoRoot, runtimeRegistryPath));
  for (const record of runtimeRegistry.records) {
    const dispatch = record.subagent_dispatch as Record<string, unknown>;
    const config = record.config_targets as Record<string, unknown>;
    const docs = record.documentation_claims as Record<string, unknown>;
    for (const value of [
      ...(dispatch.descriptor_sources as string[]),
      ...(config.hook_targets as string[]),
      ...(config.plugin_targets as string[]),
      ...(docs.reference_paths as string[]),
    ]) {
      collectTextSurfaces(value, surfaces);
    }
  }

  const packageRegistry = loadPackageRegistry(
    path.join(repoRoot, packageRegistryPath),
    repoRoot,
  );
  const packageRecord = packageRegistry.get();
  for (const value of [
    ...packageRecord.runtime_package_manifests.manifests.map((entry) => entry.path),
    ...packageRecord.runtime_package_manifests.shared_paths.map((entry) => entry.path),
  ]) {
    collectTextSurfaces(value, surfaces);
  }
  for (const value of publicInstallSurfaceRoots) collectTextSurfaces(value, surfaces);
  surfaces.add("references/cli/vocabulary.md");
  return [...surfaces].sort();
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

  it("describes only registry-declared active orchestration substrates", () => {
    const runtimeRegistry = loadRuntimeAdapterRegistry(path.join(repoRoot, runtimeRegistryPath));
    expect([...runtimeRegistry.adapterIds].sort()).toEqual(["codex", "copilot", "cursor", "opencode"]);

    const orchestrate = CAPABILITY_INSTRUCTIONS.orchestrate;
    for (const record of runtimeRegistry.records) {
      const mechanism = (record.subagent_dispatch as Record<string, string>).mechanism;
      expect(orchestrate, `${record.identity.runtime_id} substrate`).toContain(mechanism);
    }
    expect(orchestrate).toContain("Cursor IDE and cursor-agent are one Cursor identity");
  });

  it("keeps every registry-declared support surface and public install tree free of active Claude claims", () => {
    const surfaces = declaredCurrentSurfacePaths();
    expect(surfaces).toEqual(expect.arrayContaining([
      "README.md",
      "packages/cli/README.md",
      "packages/cli/shim/lib/exec.mjs",
      "packages/web/src/components/InstallTabs.astro",
      "packages/web/src/content/docs/docs/index.mdx",
      "packages/web/src/content/docs/docs/getting-started/index.mdx",
      "packages/web/src/content/docs/docs/getting-started/install.mdx",
      "references/adapters/opencode.md",
      "references/adapters/runtime-feature-parity.md",
    ]));
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

  it("documents four active IDs, the inactive Cursor alias, and retired Claude only", () => {
    const parity = read("references/adapters/runtime-feature-parity.md");
    expect(parity).toContain("exactly `opencode`, `codex`, `cursor`, and `copilot`");
    expect(parity).toContain("`cursor-agent` is an inactive compatibility alias");
    expect(parity).not.toMatch(/^\| Claude Code \|/m);

    const vocabulary = read("references/cli/vocabulary.md");
    expect(vocabulary).toContain("Canonical active runtime names are OpenCode, Codex, Cursor, and GitHub Copilot");
    expect(vocabulary).toContain("Claude Code is a retired migration and consent-gated historical-import source");
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
      "references/cli/agent-ready-state-contract.yaml",
      "references/cli/prime-consumer-compatibility.yaml",
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
    expect(read("packages/cli/src/cli/help.ts")).toContain("Home directory for shared-skill diagnosis");
    expect(read("references/cli/agent-ready-state-contract.yaml")).toContain("canonical shared-skill diagnosis");
    expect(read("references/cli/prime-consumer-compatibility.yaml")).toContain(
      "app and project-state recommendation",
    );
  });

  it("keeps active upgrade guidance free of current runtime selectors", () => {
    for (const surface of ["README.md", "UPGRADE.md"]) {
      const content = read(surface);
      expect(content, surface).not.toMatch(/--runtime\s+(?:all|opencode|codex|cursor|copilot)/);
      expect(content, surface).toContain("--legacy-cleanup claude");
    }
  });

  it("keeps active install contracts on the shared skill and explicit lifecycle path", () => {
    for (const surface of retiredInstallerSurfaces) {
      const content = read(surface);
      expect(content, surface).not.toMatch(/npx\s+skills\s+add\s+jgabor\/agentera/);
      expect(content, surface).not.toContain("install-agentera-skill");
      expect(content, surface).not.toMatch(/OpenCode portable-skill install/i);
    }
    expect(read("packages/web/src/components/InstallTabs.astro")).toContain("upgrade --runtime opencode --dry-run");
    expect(read("packages/web/src/content/docs/docs/getting-started/install.mdx")).toContain("upgrade --runtime opencode --yes");
    expect(read("packages/cli/shim/lib/exec.mjs")).toContain("upgrade --runtime all --dry-run");
  });
});
