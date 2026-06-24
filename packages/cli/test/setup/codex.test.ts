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
  codexMain,
  planAgentDescriptorChanges,
  planChange,
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
  // Node-era managed app evidence: app data surfaces (no Python scripts/hooks).
  for (const entry of ["skills/agentera/SKILL.md", "registry.json"]) {
    fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
    fs.writeFileSync(path.join(root, entry), "x");
  }
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
    expect(state).toEqual({ sectionPresent: true, setPresent: true, setTable: { AGENTERA_HOME: "/x", FOO: "bar" }, sectionLevelHome: null });
  });
  it("classifies an empty document and a section without set", () => {
    expect(classifyToml("")).toEqual({ sectionPresent: false, setPresent: false, setTable: {}, sectionLevelHome: null });
    expect(classifyToml("[shell_environment_policy]\n")).toEqual({ sectionPresent: true, setPresent: false, setTable: {}, sectionLevelHome: null });
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


const AGENT_NAMES = [
  "status", "vision", "discuss", "research", "plan", "build",
  "optimize", "audit", "document", "profile", "design", "orchestrate",
];

function managedRootWithAgents(root: string): void {
  managedFresh(root);
  const agentsDir = path.join(root, "skills", "agentera", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of AGENT_NAMES) {
    fs.writeFileSync(path.join(agentsDir, `${name}.toml`), `# agent ${name}\nname = "${name}"\n`);
  }
}

describe("setup codex: planChange branches", () => {
  const R = "/opt/agentera";
  it("plans a fresh write when the file is absent", () => {
    const o = planChange(null, R, { force: false });
    expect(o.action).toBe("fresh");
    expect(o.newText).toContain('AGENTERA_HOME = "/opt/agentera"');
  });
  it("inserts a set line into an empty section", () => {
    const o = planChange("[shell_environment_policy]\n", R, { force: false });
    expect(o.action).toBe("insert");
  });
  it("is a noop when AGENTERA_HOME already matches", () => {
    const o = planChange(renderFreshConfig(R), R, { force: false });
    expect(o.action).toBe("noop");
  });
  it("conflicts on sibling keys without --force", () => {
    const o = planChange('[shell_environment_policy]\nset = { FOO = "bar" }\n', R, { force: false });
    expect(o.action).toBe("conflict");
    expect(o.message).toContain("sibling keys (FOO)");
  });
  it("force-merges alongside siblings", () => {
    const o = planChange('[shell_environment_policy]\nset = { FOO = "bar" }\n', R, { force: true });
    expect(o.action).toBe("force-merge");
    expect(o.newText).toContain('FOO = "bar"');
    expect(o.newText).toContain('AGENTERA_HOME = "/opt/agentera"');
  });
});

describe("setup codex: agent descriptors", () => {
  it("plans install/refresh/noop/blocked by ownership", () => {
    const root = path.join(tmp, "root");
    managedRootWithAgents(root);
    const agentsDir = path.join(tmp, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    // user-owned status.toml blocks; managed vision refreshes; current discuss noops
    fs.writeFileSync(path.join(agentsDir, "status.toml"), "user owned\n");
    fs.writeFileSync(path.join(agentsDir, "vision.toml"), "# agentera_managed: true\nold\n");
    fs.writeFileSync(path.join(agentsDir, "discuss.toml"), '# agent discuss\nname = "discuss"\n');
    const changes = planAgentDescriptorChanges(root, agentsDir, { force: false });
    const by = Object.fromEntries(changes.map((c) => [c.name, c.action]));
    expect(by.status).toBe("blocked");
    expect(by.vision).toBe("pending");
    expect(by.discuss).toBe("noop");
    expect(by.plan).toBe("pending");
  });
});

describe("setup codex: codexMain end-to-end", () => {
  function run(argv: string[]): { rc: number; out: string; err: string } {
    let out = "";
    let err = "";
    const rc = codexMain(argv, { out: (s) => (out += s), err: (s) => (err += s), env: {} });
    return { rc, out, err };
  }

  it("installs fresh config + descriptors, then is idempotent", () => {
    const root = path.join(tmp, "root");
    managedRootWithAgents(root);
    const cfg = path.join(tmp, "home", ".codex", "config.toml");
    fs.mkdirSync(path.dirname(cfg), { recursive: true });

    const first = run(["--install-root", root, "--config-file", cfg]);
    expect(first.rc).toBe(0);
    expect(fs.existsSync(cfg)).toBe(true);
    expect(fs.readFileSync(cfg, "utf8")).toContain(`AGENTERA_HOME = "${resolvePath(root)}"`);
    const agentsDir = path.join(tmp, "home", ".codex", "agents");
    expect(fs.readdirSync(agentsDir).sort()).toEqual(AGENT_NAMES.map((n) => `${n}.toml`).sort());

    const second = run(["--install-root", root, "--config-file", cfg]);
    expect(second.rc).toBe(0);
  });

  it("dry-run reports a pending change and writes nothing (rc 1)", () => {
    const root = path.join(tmp, "root");
    managedRootWithAgents(root);
    const cfg = path.join(tmp, "dry", ".codex", "config.toml");
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const r = run(["--install-root", root, "--config-file", cfg, "--dry-run"]);
    expect(r.rc).toBe(1);
    expect(fs.existsSync(cfg)).toBe(false);
  });

  it("conflicts (rc 2) on sibling keys without --force", () => {
    const root = path.join(tmp, "root");
    managedRootWithAgents(root);
    const cfg = path.join(tmp, "conf", ".codex", "config.toml");
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '[shell_environment_policy]\nset = { FOO = "bar" }\n');
    const r = run(["--install-root", root, "--config-file", cfg]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("sibling keys");
  });

  it("rejects an invalid install root (rc 2)", () => {
    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad, { recursive: true });
    const cfg = path.join(tmp, "x", ".codex", "config.toml");
    const r = run(["--install-root", bad, "--config-file", cfg]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("not a valid Agentera directory");
  });
});
describe("setup codex: misplaced shell_environment_policy", () => {
  const R = "/opt/agentera";
  it("normalizes section-level AGENTERA_HOME and empty .set subtable", () => {
    const current =
      "[shell_environment_policy]\n" +
      `AGENTERA_HOME = "${R}"\n` +
      "\n" +
      "[shell_environment_policy.set]\n" +
      "\n" +
      "[agents]\n" +
      "max_depth = 1\n";
    const o = planChange(current, R, { force: false });
    expect(o.action).toBe("normalize");
    expect(o.newText).toContain(`set = { AGENTERA_HOME = "${R}" }`);
    expect(o.newText).not.toContain("[shell_environment_policy.set]");
  });
});
