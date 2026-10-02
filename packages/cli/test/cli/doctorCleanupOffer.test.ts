import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { main } from "../../src/cli/dispatch.js";
import { loadHostSkillSource } from "../../src/setup/hostSkillLifecycle.js";
import { historicalPluginFixture } from "../helpers/git.js";
import { observeLifecyclePath } from "../../src/runtime/lifecyclePublication.js";
import { appendLifecycleOwnershipJournal, lifecycleOwnershipJournalPath } from "../../src/runtime/lifecycleOwnershipJournal.js";
import { LIFECYCLE_LEDGER_SCHEMA } from "../../src/runtime/lifecycleOperations.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
let root: string, home: string, project: string, data: string, oldCwd: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function capture(args: string[]) {
  let out = "",
    err = "";
  const code = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { code, payload: JSON.parse(out), err };
}
const doctor = () => capture(["doctor", "--home", home, "--project", project, "--format", "json"]);
const apply = (command: string) => capture(command.split(" ").slice(3));
function snapshot(directory = root): Record<string, unknown> {
  return Object.fromEntries(
    fs
      .readdirSync(directory)
      .sort()
      .map((name) => {
        const file = path.join(directory, name),
          stat = fs.lstatSync(file);
        return [name, stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString("base64")];
      }),
  );
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-doctor-cleanup-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  data = path.join(home, ".local/share/agentera");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(project);
  write(path.join(home, ".agents/skills/agentera/SKILL.md"), loadHostSkillSource(repo).content);
  write(path.join(home, ".config/opencode/opencode.json"), '{"shared":true}\n');
  write(path.join(root, "external.md"), "not owned\n");
  vi.stubEnv("XDG_DATA_HOME", path.join(home, ".local/share"));
  vi.stubEnv("AGENTERA_HOME", undefined);
  vi.stubEnv("AGENTERA_PROFILE_DIR", undefined);
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", repo);
  oldCwd = process.cwd();
  process.chdir(project);
});
afterEach(() => {
  process.chdir(oldCwd);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function retired(name: string, text = `# agentera_managed: true\nname = '${name}'\n`) {
  write(path.join(home, ".codex/agents", `${name}.toml`), text);
}

it("separates healthy runtime and shared skill from retired attention with exact offered leaves", () => {
  retired("build");
  retired("plan");
  fs.symlinkSync(path.join(root, "external.md"), path.join(home, ".codex/agents/status.toml"));
  const before = snapshot();
  const result = doctor();
  expect(result.code).toBe(1);
  expect(result.payload).toMatchObject({
    status: "manual_review_needed",
    current_health: {
      cli: "up_to_date",
      shared_skill: "pass",
      runtime_package_root: repo,
      durable_user_data_root: data,
    },
    userDataRoot: data,
    cleanup_attention: {
      manual_review_resource_ids: ["codex.agent-descriptor.status"],
      pending_resource_ids: expect.arrayContaining(["codex.agent-descriptor.build", "codex.agent-descriptor.plan"]),
    },
  });
  const offer = result.payload.cleanup_offer;
  expect(offer.approval).toBe("explicit_yes_only");
  expect(offer.operations.map((op: { id: string }) => op.id)).toEqual(["codex.agent-descriptor.build", "codex.agent-descriptor.plan"]);
  expect(offer.question).toContain("ownership-proven retired Agentera resources");
  expect(offer.manual_review_resource_ids).toContain("codex.agent-descriptor.status");
  for (const operation of offer.operations) {
    expect(operation.apply_command).toContain(`--legacy-cleanup ${operation.id}`);
    expect(operation.apply_command).toContain("--authorization cleanup-sha256:");
    expect(operation.apply_command).not.toContain("--channel");
  }
  // No and silence mean the host does not invoke any operation.
  expect(snapshot()).toEqual(before);
});

it("applies only the approved leaves, preserving ambiguous links, their targets, siblings and shared config", () => {
  retired("build");
  retired("plan");
  fs.symlinkSync(path.join(root, "external.md"), path.join(home, ".codex/agents/status.toml"));
  const offer = doctor().payload.cleanup_offer;
  for (const operation of offer.operations) {
    const result = apply(operation.apply_command);
    expect(result.payload.phases[0].name).toBe("cleanup");
    expect(result.payload.phases[0].items.some((item: { action: string }) => item.action === "retire-declared-resource")).toBe(true);
    expect(doctor().payload.cleanup_attention.manual_review_resource_ids).toContain("codex.agent-descriptor.status");
  }
  expect(fs.existsSync(path.join(home, ".codex/agents/build.toml"))).toBe(false);
  expect(fs.existsSync(path.join(home, ".codex/agents/plan.toml"))).toBe(false);
  expect(fs.lstatSync(path.join(home, ".codex/agents/status.toml")).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(root, "external.md"), "utf8")).toBe("not owned\n");
  expect(fs.readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8")).toBe('{"shared":true}\n');
  expect(doctor().payload.cleanup_offer).toBeNull();
  expect(doctor().code).toBe(1);
});

it("refuses changed marker-owned content after offer and reports actual remaining state without migration", () => {
  retired("build");
  retired("plan");
  const offer = doctor().payload.cleanup_offer;
  const first = apply(offer.operations[0].apply_command);
  expect([0, 1]).toContain(first.code);
  retired("plan", "# agentera_managed: true\nname = 'plan'\nchanged = true\n");
  const before = snapshot();
  const stale = apply(offer.operations[1].apply_command);
  expect(stale.code).toBe(1);
  expect(stale.payload).toMatchObject({
    mode: "apply",
    status: "blocked",
    summary: { blocked: 1 },
  });
  expect(stale.payload.remaining_cleanup).toMatchObject({
    status: "action_required",
    resources: expect.arrayContaining([expect.objectContaining({ id: "codex.agent-descriptor.plan" })]),
    recovery_command: expect.stringContaining("doctor --home"),
  });
  expect(stale.payload.remaining_cleanup.resources.map((entry: { id: string }) => entry.id)).not.toContain("codex.agent-descriptor.build");
  expect(snapshot()).toEqual(before);
  const remaining = doctor();
  expect(remaining.code).toBe(1);
  expect(remaining.payload.cleanup_attention.pending_resource_ids).toContain("codex.agent-descriptor.plan");
  expect(remaining.payload.cleanup_attention.pending_resource_ids).not.toContain("codex.agent-descriptor.build");
  expect(remaining.payload.cleanup_offer.operations[0].apply_command).not.toBe(offer.operations[1].apply_command);
  expect(remaining.payload.applyCommand).toBeNull();
});

it("offers an ownership-ledger-proven plugin as a focused leaf, never as a full app migration", () => {
  const plugin = path.join(home, ".config/opencode/plugins/agentera.js");
  write(plugin, historicalPluginFixture(repo));
  const observed = observeLifecyclePath(plugin, [home]);
  appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(data), {
    schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
    owner: "agentera",
    records: [
      {
        resourceId: "opencode.plugin",
        destination: plugin,
        kind: "file",
        scope: "whole",
        status: "managed",
        fingerprint: observed.fingerprint!,
        identity: observed.identity!,
      },
    ],
  });
  const diagnosed = doctor();
  expect(diagnosed.payload.cleanup_offer.operations.map((entry: { id: string }) => entry.id)).toContain("opencode.plugin.agentera");
  const operation = diagnosed.payload.cleanup_offer.operations.find((entry: { id: string }) => entry.id === "opencode.plugin.agentera");
  expect(operation.apply_command).toContain("--legacy-cleanup opencode.plugin.agentera");
  expect(operation.apply_command).not.toContain("--channel");
  const result = apply(operation.apply_command);
  expect(result.payload.phases[0].name).toMatch(/lifecycle|cleanup/);
  expect(fs.existsSync(plugin)).toBe(false);
  expect(fs.readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8")).toBe('{"shared":true}\n');
});

it("refuses a plugin whose ownership journal changes after the offer", () => {
  const plugin = path.join(home, ".config/opencode/plugins/agentera.js");
  write(plugin, historicalPluginFixture(repo));
  const observed = observeLifecyclePath(plugin, [home]);
  const ledger = {
    schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
    owner: "agentera",
    records: [
      {
        resourceId: "opencode.plugin",
        destination: plugin,
        kind: "file" as const,
        scope: "whole" as const,
        status: "managed" as const,
        fingerprint: observed.fingerprint!,
        identity: observed.identity!,
      },
    ],
  };
  appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(data), ledger);
  const offer = doctor().payload.cleanup_offer.operations.find((entry: { id: string }) => entry.id === "opencode.plugin.agentera");
  appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(data), {
    ...ledger,
    records: [{ ...ledger.records[0]!, fingerprint: `sha256:${"0".repeat(64)}` }],
  });
  const before = snapshot();
  const rejected = apply(offer.apply_command);
  expect(rejected.code).toBe(1);
  expect(rejected.payload.status).toMatch(/blocked|failed/);
  expect(fs.readFileSync(plugin)).toEqual(historicalPluginFixture(repo));
  expect(snapshot()).toEqual(before);
  expect(doctor().payload.cleanup_attention.manual_review_resource_ids).toContain("opencode.plugin.agentera");
});

it("does not let a scoped offer migrate, retarget, or follow a newly linked parent", () => {
  retired("build");
  const command = doctor().payload.cleanup_offer.operations[0].apply_command as string;
  const retargeted = capture(command.replace(`--project ${project}`, `--project ${root}`).split(" ").slice(3));
  expect(retargeted.code).toBe(1);
  expect(retargeted.payload.status).toBe("blocked");
  expect(fs.existsSync(path.join(home, ".codex/agents/build.toml"))).toBe(true);
  const oldParent = path.join(home, ".codex/agents");
  fs.renameSync(oldParent, path.join(home, ".codex/retained-agents"));
  fs.symlinkSync(path.join(home, ".codex/retained-agents"), oldParent);
  const before = snapshot();
  const changed = apply(command);
  expect(changed.code).toBe(1);
  expect(changed.payload.status).toBe("blocked");
  expect(snapshot()).toEqual(before);
  expect(fs.readFileSync(path.join(home, ".codex/retained-agents/build.toml"), "utf8")).toContain("agentera_managed");
});

it("keeps packaged runtime location separate from durable selected data root", () => {
  // The local build's packaged bundle has the same sentinel-gated shape as the npm bundle.
  const bundle = path.join(repo, "packages/cli/bundle");
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", bundle);
  write(path.join(home, ".agents/skills/agentera/SKILL.md"), loadHostSkillSource(bundle).content);
  const result = doctor();
  expect(result.payload).toMatchObject({
    status: "repair_needed",
    userDataRoot: data,
    managedAppRoot: path.join(repo, "packages/cli/bundle"),
    current_health: {
      cli: "up_to_date",
      shared_skill: "pass",
      durable_user_data_root: data,
      runtime_package_root: path.join(repo, "packages/cli/bundle"),
    },
    cleanup_offer: null,
  });
});

function configuredCommand(variable: "OPENCODE_CONFIG_DIR" | "XDG_CONFIG_HOME", withDefault: boolean) {
  vi.stubEnv("OPENCODE_CONFIG_DIR", undefined);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
  const selected = variable === "OPENCODE_CONFIG_DIR" ? path.join(home, "custom-opencode") : path.join(home, "custom-config");
  vi.stubEnv(variable, selected);
  const configured = path.join(variable === "XDG_CONFIG_HOME" ? path.join(selected, "opencode") : selected, "commands/agentera.md");
  const defaultCommand = path.join(home, ".config/opencode/commands/agentera.md");
  write(configured, "---\nagentera_managed: true\n---\nowned custom command\n");
  if (withDefault) write(defaultCommand, "---\nagentera_managed: true\n---\nowned default command\n");
  return { configured, defaultCommand, selected };
}

it.each(["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const)("offers and applies the exact %s custom-only cleanup", (variable) => {
  const { configured } = configuredCommand(variable, false);
  const diagnosed = doctor();
  const operation = diagnosed.payload.cleanup_offer?.operations.find((entry: { id: string }) => entry.id === "opencode.command.agentera");
  expect(operation, JSON.stringify(diagnosed.payload.cleanup_attention)).toBeDefined();
  expect(operation.paths).toEqual([configured]);
  const result = apply(operation.apply_command);
  expect(result.payload.summary.applied).toBeGreaterThan(0);
  expect(fs.existsSync(configured)).toBe(false);
  expect(fs.readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8")).toBe('{"shared":true}\n');
});

it.each(["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const)("offers and applies both %s custom and default leaves under one bound operation", (variable) => {
  const { configured, defaultCommand } = configuredCommand(variable, true);
  const diagnosed = doctor();
  const operation = diagnosed.payload.cleanup_offer?.operations.find((entry: { id: string }) => entry.id === "opencode.command.agentera");
  expect(operation, JSON.stringify(diagnosed.payload.cleanup_attention)).toBeDefined();
  expect(operation.paths).toEqual([defaultCommand, configured].sort());
  const result = apply(operation.apply_command);
  expect(result.payload.summary.applied).toBeGreaterThan(0);
  expect(fs.existsSync(configured)).toBe(false);
  expect(fs.existsSync(defaultCommand)).toBe(false);
  expect(fs.readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8")).toBe('{"shared":true}\n');
});

it.each(["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const)("refuses %s offer after custom evidence changes", (variable) => {
  const { configured } = configuredCommand(variable, false);
  const operation = doctor().payload.cleanup_offer?.operations.find((entry: { id: string }) => entry.id === "opencode.command.agentera");
  expect(operation).toBeDefined();
  fs.appendFileSync(configured, "changed after offer\n");
  const before = snapshot();
  const result = apply(operation.apply_command);
  expect(result).toMatchObject({ code: 1, payload: { status: "blocked" } });
  expect(snapshot()).toEqual(before);
});

it.each(["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const)("refuses %s offer after configured root changes while default leaf remains", (variable) => {
  const { defaultCommand } = configuredCommand(variable, true);
  const operation = doctor().payload.cleanup_offer?.operations.find((entry: { id: string }) => entry.id === "opencode.command.agentera");
  expect(operation).toBeDefined();
  vi.stubEnv(variable, path.join(home, "different-config"));
  const before = snapshot();
  const result = apply(operation.apply_command);
  expect(result).toMatchObject({ code: 1, payload: { status: "blocked" } });
  expect(snapshot()).toEqual(before);
  expect(fs.existsSync(defaultCommand)).toBe(true);
});
