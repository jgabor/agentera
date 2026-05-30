import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_HOOK_MATCHER,
  InstallRootError,
  classifyToml,
  codexHookStateEntries,
  codexHookTrustedHash,
  codexPluginHooksEnabled,
  emitSetInlineTable,
  renderCodexHooksConfig,
  renderFreshConfig,
  resolveInstallRoot,
} from "../../src/setup/codex.js";
import { resolvePath } from "../../src/core/paths.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-codex-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedFresh(root: string): void {
  for (const entry of ["scripts/validate_capability.py", "skills/agentera/SKILL.md"]) {
    fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
    fs.writeFileSync(path.join(root, entry), "x");
  }
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
}

describe("setup codex: install root", () => {
  it("resolves an explicit managed root and rejects an invalid one", () => {
    const root = path.join(tmp, "managed");
    managedFresh(root);
    expect(resolveInstallRoot(root, {})).toBe(resolvePath(root));
    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad);
    expect(() => resolveInstallRoot(bad, {})).toThrow(InstallRootError);
  });
});

describe("setup codex: TOML classification + emission", () => {
  it("classifies a present set table", () => {
    const state = classifyToml('[shell_environment_policy]\nset = { AGENTERA_HOME = "/x", FOO = "bar" }\n');
    expect(state).toEqual({ sectionPresent: true, setPresent: true, setTable: { AGENTERA_HOME: "/x", FOO: "bar" } });
  });
  it("classifies an empty document and a section without set", () => {
    expect(classifyToml("")).toEqual({ sectionPresent: false, setPresent: false, setTable: {} });
    expect(classifyToml("[shell_environment_policy]\n")).toEqual({ sectionPresent: true, setPresent: false, setTable: {} });
  });
  it("emits an inline table with basic-string escaping", () => {
    expect(emitSetInlineTable({ AGENTERA_HOME: "/x", FOO: 'b"q' })).toBe('{ AGENTERA_HOME = "/x", FOO = "b\\"q" }');
    expect(emitSetInlineTable({})).toBe("{ }");
  });
  it("renders a fresh config", () => {
    const text = renderFreshConfig("/opt/agentera");
    expect(text).toContain('[shell_environment_policy]\nset = { AGENTERA_HOME = "/opt/agentera" }');
    expect(text).toContain("[agents]\nmax_depth = 1");
    expect(text).toContain("[features.multi_agent_v2]");
  });
});

describe("setup codex: hook trust hashing", () => {
  it("produces a deterministic sha256 trust hash", () => {
    const h = codexHookTrustedHash("pre_tool_use", CODEX_HOOK_MATCHER);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(codexHookTrustedHash("pre_tool_use", CODEX_HOOK_MATCHER)).toBe(h);
    // Different optional fields change the hash.
    expect(codexHookTrustedHash("post_tool_use", null, "uv run x", 5, null)).not.toBe(h);
  });
  it("builds [hooks.state] entries keyed by resolved hooks path", () => {
    const entries = codexHookStateEntries("/opt/a/hooks/codex-hooks.json");
    expect(Object.keys(entries).sort()).toEqual([
      "/opt/a/hooks/codex-hooks.json:post_tool_use:0:0",
      "/opt/a/hooks/codex-hooks.json:pre_tool_use:0:0",
    ]);
    expect(entries["/opt/a/hooks/codex-hooks.json:pre_tool_use:0:0"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("renders the apply_patch hooks config", () => {
    const config = JSON.parse(renderCodexHooksConfig("uv run X"));
    expect(config.hooks.PreToolUse[0].matcher).toBe(CODEX_HOOK_MATCHER);
    expect(config.hooks.PostToolUse[0].hooks[0].command).toBe("uv run X");
  });
});

describe("setup codex: plugin enabled", () => {
  it("detects an enabled plugin entry", () => {
    expect(codexPluginHooksEnabled('[plugins."agentera@agentera"]\nenabled = true\n')).toBe(true);
    expect(codexPluginHooksEnabled("")).toBe(false);
    expect(codexPluginHooksEnabled('[plugins."agentera@agentera"]\nenabled = false\n')).toBe(false);
  });
});
