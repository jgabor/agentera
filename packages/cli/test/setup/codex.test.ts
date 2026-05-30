import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_HOOK_MATCHER,
  InstallRootError,
  classifyToml,
  codexCopiedHooksAreAgenteraOnly,
  codexHookStateEntries,
  codexHookTrustedHash,
  codexPluginHooksEnabled,
  emitSetInlineTable,
  ensureCodexAgentLimits,
  ensureCodexHookTrust,
  ensureCodexPluginHookTrust,
  insertSetLine,
  renderCodexHooksConfig,
  renderFreshConfig,
  resolveInstallRoot,
  rewriteSetLine,
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


describe("setup codex: TOML mutation engine", () => {
  it("inserts a set line directly under the section header", () => {
    const text = insertSetLine("[shell_environment_policy]\n\n[other]\nx = 1\n", "/opt/a");
    expect(text).toBe('[shell_environment_policy]\nset = { AGENTERA_HOME = "/opt/a" }\n\n[other]\nx = 1\n');
  });

  it("rewrites a set line by merging pairs", () => {
    const text = rewriteSetLine('[shell_environment_policy]\nset = { FOO = "bar" }\n', { FOO: "bar", AGENTERA_HOME: "/opt/a" });
    expect(text).toBe('[shell_environment_policy]\nset = { FOO = "bar", AGENTERA_HOME = "/opt/a" }\n');
  });

  it("refuses to rewrite a multi-line set value", () => {
    expect(() => rewriteSetLine("[shell_environment_policy]\nset = {\n  FOO = \"bar\"\n}\n", { FOO: "x" })).toThrow();
  });

  it("ensures default agent limits on an empty config", () => {
    const text = ensureCodexAgentLimits("");
    expect(text).toContain("[agents]\nmax_depth = 1");
    expect(text).toContain("[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 6");
  });

  it("ensures hook trust by enabling features.hooks and writing trust state", () => {
    const text = ensureCodexHookTrust("", "/opt/agentera/hooks/codex-hooks.json");
    expect(text).toContain("[features]\nhooks = true");
    expect(text).toContain("[hooks.state]");
    expect(text).toContain('/opt/agentera/hooks/codex-hooks.json:pre_tool_use:0:0');
    expect(text).toContain("trusted_hash = ");
    expect(text).toContain("enabled = true");
  });

  it("ensures plugin hook trust by enabling plugin_hooks", () => {
    const text = ensureCodexPluginHookTrust("");
    expect(text).toContain("hooks = true");
    expect(text).toContain("plugin_hooks = true");
    expect(text).toContain("agentera@agentera:hooks/codex-plugin-hooks.json:pre_tool_use:0:0");
  });

  it("detects an Agentera-only copied hooks.json", () => {
    const config = renderCodexHooksConfig('uv run "${AGENTERA_HOME}/hooks/validate_artifact.py"');
    expect(codexCopiedHooksAreAgenteraOnly(config)).toBe(true);
    expect(codexCopiedHooksAreAgenteraOnly("{}")).toBe(false);
    expect(codexCopiedHooksAreAgenteraOnly("not json")).toBe(false);
  });
});
