import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("retired runtime current-surface policy", () => {
  it("serves orchestration substrates for only the four active runtime identities", () => {
    const orchestrate = CAPABILITY_INSTRUCTIONS.orchestrate;
    expect(orchestrate).toContain("OpenCode: `~/.config/opencode/agents/*.md`");
    expect(orchestrate).toContain("Codex CLI: `~/.codex/agents/*.toml`");
    expect(orchestrate).toContain("Cursor: `.cursor/agents/*.md`");
    expect(orchestrate).toContain("Copilot CLI: user-driven `/fleet`");
    expect(orchestrate).not.toContain("Claude Code: Task tool");
  });

  it("does not advertise Claude in current install surfaces", () => {
    const installSurfaces = [
      "README.md",
      "packages/cli/README.md",
      "packages/cli/shim/lib/exec.mjs",
      "packages/web/src/components/InstallTabs.astro",
      "packages/web/src/content/docs/docs/index.mdx",
      "packages/web/src/content/docs/docs/getting-started/index.mdx",
      "packages/web/src/content/docs/docs/getting-started/install.mdx",
    ];
    for (const surface of installSurfaces) {
      expect(read(surface), surface).not.toMatch(/Claude Code|claude-code/);
    }
  });

  it("documents four active IDs, the inactive Cursor alias, and retired Claude only", () => {
    const parity = read("references/adapters/runtime-feature-parity.md");
    expect(parity).toContain("exactly `opencode`, `codex`, `cursor`, and `copilot`");
    expect(parity).toContain("`cursor-agent` is an inactive compatibility alias");
    expect(parity).not.toMatch(/^\| Claude Code \|/m);

    const vocabulary = read("references/cli/vocabulary.md");
    expect(vocabulary).toContain("Canonical active runtime names are OpenCode, Codex CLI, Cursor IDE, and Copilot CLI");
    expect(vocabulary).toContain("Claude Code is a retired migration and consent-gated historical-import source");
  });
});
