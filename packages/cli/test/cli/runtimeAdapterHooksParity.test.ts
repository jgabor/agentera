import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { loadRegistry } from "../../src/registries/runtimeAdapterRegistry.js";
import {
  validateCodex,
  validateCopilot,
  validateCopilotHooks,
  validateCursor,
  validateCursorHooks,
  validateOpencode,
} from "../../src/validate/lifecycleAdapters.js";
import { codexHookStateEntries, codexHookTrustedHash } from "../../src/setup/codex.js";
import { isParityFamilyClosed } from "../upgrade/gapRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REGISTRY = loadRegistry(path.join(REPO_ROOT, "references/adapters/runtime-adapter-registry.yaml"));

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
} {
  let out = "";
  const rc = fn({ out: (t) => (out += t), err: () => {} });
  return { rc, out };
}

describe("runtime adapter hooks parity (D56 T7)", () => {
  it("registers runtime_adapter_hooks as a closed parity family", () => {
    expect(isParityFamilyClosed("runtime_adapter_hooks")).toBe(true);
  });

  it("passes check validate descriptors with 24 codex+opencode checks", () => {
    const { rc, out } = capture((io) =>
      main(["node", "agentera", "check", "validate", "descriptors", "--format", "json"], io),
    );
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.target_family).toBe("descriptors");
    expect(payload.target).toBe("agent-descriptors");
    expect(payload.checks).toHaveLength(24);
    expect(payload.summary.passed).toBe(24);
    expect(payload.summary.failed).toBe(0);
    expect(JSON.stringify(payload)).not.toContain("Read ${AGENTERA_HOME}/app/skills/agentera/capabilities");
    expect(JSON.stringify(payload)).not.toContain("experimental.session.compacting missing");
  });

  it.each([
    ["opencode", () => validateOpencode(REPO_ROOT, REGISTRY)],
    ["codex", () => validateCodex(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".codex-plugin/plugin.json"), "utf8")), REGISTRY)],
    [
      "cursor",
      () => [
        ...validateCursor(REPO_ROOT, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".cursor-plugin/plugin.json"), "utf8")), REGISTRY),
        ...validateCursorHooks(REPO_ROOT, REGISTRY),
      ],
    ],
    [
      "copilot",
      () => {
        const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8"));
        return [...validateCopilot(plugin, REPO_ROOT, REGISTRY), ...validateCopilotHooks(REPO_ROOT, plugin, REGISTRY)];
      },
    ],
  ] as const)("pass: %s lifecycle adapter metadata validates cleanly", (_runtime, run) => {
    expect(run()).toEqual([]);
  });

  it.each([
    ["opencode", () => validateOpencode(path.join(REPO_ROOT, "missing-opencode-root"), REGISTRY)],
    ["codex", () => validateCodex({}, REGISTRY)],
    ["cursor", () => validateCursorHooks(path.join(REPO_ROOT, "missing-cursor-root"), REGISTRY)],
    [
      "copilot",
      () => validateCopilot({ lifecycleHooks: {}, skills: "skills", hooks: "hooks" }, REPO_ROOT, REGISTRY),
    ],
  ] as const)("fail: %s lifecycle adapter validator reports contract violations", (_runtime, run) => {
    expect(run().length).toBeGreaterThan(0);
  });

  it("pass: codex hook trust hashes are deterministic for apply_patch", () => {
    const entries = codexHookStateEntries(path.join(REPO_ROOT, "hooks/codex-hooks.json"));
    expect(Object.keys(entries)).toHaveLength(2);
    const hash = codexHookTrustedHash("pre_tool_use", "^apply_patch$");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(codexHookTrustedHash("pre_tool_use", "^apply_patch$")).toBe(hash);
  });

  it("fail: codex trust hash changes when apply_patch matcher drifts", () => {
    const baseline = codexHookTrustedHash("pre_tool_use", "^apply_patch$");
    expect(codexHookTrustedHash("pre_tool_use", "^write$")).not.toBe(baseline);
  });
});
