import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdDoctor } from "../../src/cli/commands/doctor.js";
import { main } from "../../src/cli/dispatch.js";
import { loadNativeResourceCleanupContract, retiredResourceDiagnosticIds } from "../../src/runtime/nativeResourceCleanup.js";
import { diagnoseRetiredResources } from "../../src/upgrade/retiredResourceDiagnostics.js";
import { appendLifecycleOwnershipJournal, lifecycleOwnershipJournalPath } from "../../src/runtime/lifecycleOwnershipJournal.js";
import { observeLifecyclePath } from "../../src/runtime/lifecyclePublication.js";
import { LIFECYCLE_LEDGER_SCHEMA } from "../../src/runtime/lifecycleOperations.js";

let root: string;
let home: string;
let project: string;
let installRoot: string;
let environmentBefore: Record<string, string | undefined>;

const ENGLISH_CAPABILITIES = ["audit", "build", "design", "discuss", "document", "optimize", "orchestrate", "plan", "profile", "research", "status", "vision"] as const;
const SWEDISH_CAPABILITIES = ["dokumentera", "hej", "inspektera", "inspirera", "optimera", "orkestrera", "planera", "profilera", "realisera", "resonera", "visionera", "visualisera"] as const;
const CODEX_DESCRIPTORS = ["status", "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate", ...SWEDISH_CAPABILITIES] as const;
const INSTALLED_HOOKS = ["validate_artifact.py", "cursor_session_start.py", "cursor_pre_tool_use.py", "cursor_session_stop.py", "session_start.py", "session_stop.py", "codex-hooks.json"] as const;
const EXPECTED_RETIRED_RESOURCE_IDS = [
  "claude.agentera-skill-link",
  ...CODEX_DESCRIPTORS.map((name) => `codex.agent-descriptor.${name}`),
  "opencode.plugin.agentera",
  "opencode.command.agentera",
  "opencode.command.hej",
  "copilot.hook.agentera",
  "copilot.hook.postToolUse",
  "copilot.hook.preToolUse",
  "copilot.hook.sessionEnd",
  "copilot.hook.sessionStart",
  "cursor.agent.agentera",
  "opencode.agent.agentera",
  ...[...ENGLISH_CAPABILITIES, ...SWEDISH_CAPABILITIES].flatMap((name) => [`cursor.agent.${name}`, `opencode.agent.${name}`]),
  "opencode.skill-link.agentera",
  "opencode.skill-link.status",
  ...INSTALLED_HOOKS.map((name) => `agentera.installed-hook.${name}`),
  "agentera.registration.marketplace.cursor",
  "agentera.registration.plugin.codex",
  "agentera.registration.restorer.codex",
].sort();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-retired-resource-doctor-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  installRoot = path.join(home, ".local", "share", "agentera");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  environmentBefore = Object.fromEntries(["AGENTERA_HOME", "AGENTERA_DEFAULT_INSTALL_ROOT", "AGENTERA_PROFILE_DIR", "XDG_DATA_HOME"].map((key) => [key, process.env[key]]));
  delete process.env.AGENTERA_HOME;
  delete process.env.AGENTERA_DEFAULT_INSTALL_ROOT;
  delete process.env.AGENTERA_PROFILE_DIR;
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
});

afterEach(() => {
  for (const [key, value] of Object.entries(environmentBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function expand(template: string, name = ""): string {
  return template
    .replace("{home}", home)
    .replace("{project}", project)
    .replace("{install_root}", installRoot)
    .replace("{opencode_config}", path.join(home, ".config", "opencode"))
    .replace("{name}", name);
}

function captureDoctor(opts: { retiredResource?: string; installRoot?: string } = {}): {
  rc: number;
  payload: Record<string, any>;
} {
  let output = "";
  const rc = cmdDoctor(
    {
      home,
      project,
      retiredResource: opts.retiredResource,
      installRoot: opts.installRoot ?? installRoot,
      format: "json",
    },
    { out: (text) => (output += text) },
  );
  return { rc, payload: JSON.parse(output) as Record<string, any> };
}

function previewInstallRoot(preview: string, expectedRoot: string): string {
  const match = /--install-root ([^ ]+)/.exec(preview);
  if (!match || match[1] !== expectedRoot) {
    throw new Error(`retired-resource preview must carry install root ${expectedRoot}`);
  }
  return match[1];
}

function replayPreview(preview: string, expectedRoot: string, resourceId: string): { rc: number; payload: Record<string, any> } {
  const root = previewInstallRoot(preview, expectedRoot);
  if (!preview.includes(`--legacy-cleanup ${resourceId}`)) {
    throw new Error(`retired-resource preview must carry ${resourceId}`);
  }
  let output = "";
  const rc = main(["node", "agentera", "doctor", "--home", home, "--project", project, "--install-root", root, "--retired-resource", resourceId, "--format", "json"], {
    out: (text) => (output += text),
  });
  return { rc, payload: JSON.parse(output) as Record<string, any> };
}

describe("retired native resource doctor diagnostics", () => {
  it("maps the independent exact retirement inventory to stale evidence and ID-scoped previews", () => {
    const contract = loadNativeResourceCleanupContract();
    const bodies = new Map<string, string[]>();
    const expected = new Set(EXPECTED_RETIRED_RESOURCE_IDS);
    expect(contract.resourceVocabulary.flatMap((definition) => definition.resourceIds).sort()).toEqual(EXPECTED_RETIRED_RESOURCE_IDS);
    expect(retiredResourceDiagnosticIds(contract)).toEqual(EXPECTED_RETIRED_RESOURCE_IDS);
    for (const definition of contract.diagnosticResources) {
      const names = definition.id.includes("{name}") || definition.destinations.some((item) => item.includes("{name}")) ? definition.names : [""];
      for (const name of names) {
        for (const destination of definition.destinations) {
          const pathname = expand(destination, name);
          const markers = bodies.get(pathname) ?? [];
          markers.push(definition.contains ?? "USER_SECRET_MUST_NOT_LEAK");
          bodies.set(pathname, markers);
        }
      }
    }
    for (const [pathname, markers] of bodies) {
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      fs.writeFileSync(pathname, markers.join("\n"));
    }
    const before = [...bodies.keys()].map((pathname) => [pathname, fs.readFileSync(pathname, "utf8")]);

    const diagnosis = diagnoseRetiredResources({ home, project, installRoot, contract });
    const { payload } = captureDoctor();
    const resources = payload.retired_resources.resources as Array<Record<string, any>>;

    expect(diagnosis.status).toBe("action_required");
    expect(new Set(diagnosis.resources.map((resource) => resource.id))).toEqual(expected);
    expect(diagnosis.resources).toHaveLength(expected.size);
    expect(diagnosis.resources.length).toBeLessThanOrEqual(contract.diagnosticMaximumResources);
    expect(new Set(resources.map((resource) => resource.id))).toEqual(expected);
    for (const resource of resources) {
      expect(resource.preview_command).toContain("npx -y agentera@next upgrade");
      expect(resource.preview_command).toContain(" upgrade ");
      expect(resource.preview_command).toContain(`--install-root ${installRoot}`);
      expect(resource.preview_command).toContain(`--legacy-cleanup ${resource.id}`);
      expect(resource.preview_command).toContain("--dry-run");
    }
    expect(JSON.stringify(diagnosis)).not.toContain("USER_SECRET_MUST_NOT_LEAK");
    expect(JSON.stringify(payload)).not.toContain("USER_SECRET_MUST_NOT_LEAK");
    for (const [pathname, content] of before) {
      expect(fs.readFileSync(pathname, "utf8")).toBe(content);
    }
  });

  it("reports clean state without a retired-resource signal", () => {
    const { payload } = captureDoctor();

    expect(payload.status).toBe("manual_review_needed");
    expect(payload.retired_resources).toMatchObject({
      status: "clean",
      resources: [],
      omittedResourceCount: 0,
    });
    expect(payload.signals.some((signal: { kind: string }) => signal.kind === "retired_native_resources")).toBe(false);
  });

  it("accepts an authority-declared Swedish Codex alias and canonicalizes its marker cleanup", () => {
    const descriptor = path.join(home, ".codex", "agents", "hej.toml");
    fs.mkdirSync(path.dirname(descriptor), { recursive: true });
    fs.writeFileSync(descriptor, "# agentera_managed: true\nname = 'hej'\n");
    let output = "";
    const rc = main(["node", "agentera", "upgrade", "--home", home, "--project", project, "--install-root", installRoot, "--legacy-cleanup", "codex.agents.hej", "--dry-run", "--format", "json"], {
      out: (text) => {
        output += text;
      },
    });
    const payload = JSON.parse(output) as Record<string, any>;

    expect(rc).toBe(1);
    expect(payload.lifecycle).toBeNull();
    expect(payload.phases).toHaveLength(1);
    expect(payload.phases[0].items).toContainEqual(
      expect.objectContaining({
        resourceId: "codex.agent-descriptor.hej",
        source: descriptor,
        status: "pending",
        action: "retire-declared-resource",
      }),
    );
  });

  it.each([false, true])("reports an exact marked Codex descriptor as cleanup-eligible with mismatched ledger=%s", (mismatchedLedger) => {
    const descriptor = path.join(home, ".codex", "agents", "build.toml");
    fs.mkdirSync(path.dirname(descriptor), { recursive: true });
    fs.writeFileSync(descriptor, "# agentera_managed: true\nname = 'build'\n");
    if (mismatchedLedger) {
      const observed = observeLifecyclePath(descriptor, [home]);
      appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(installRoot), {
        schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
        owner: "agentera",
        records: [
          {
            resourceId: "codex.agent-descriptor.build",
            destination: descriptor,
            kind: "file",
            scope: "whole",
            status: "managed",
            fingerprint: `sha256:${"0".repeat(64)}`,
            identity: observed.identity!,
          },
        ],
      });
    }

    const { payload } = captureDoctor({ retiredResource: "codex.agent-descriptor.build" });
    expect(payload.retired_resources.resources).toEqual([
      expect.objectContaining({
        id: "codex.agent-descriptor.build",
        status: "pending_automatic_removal",
        next_action: expect.stringContaining("--legacy-cleanup codex.agent-descriptor.build"),
      }),
    ]);
  });

  it("reports a proven plugin as pending automatic removal through normal upgrade in JSON and default text", () => {
    const plugin = path.join(home, ".config", "opencode", "plugins", "agentera.js");
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    const historical = spawnSync("git", ["show", "aa33870df05d53745ebad5351b8a352b7dad7780:.opencode/plugins/agentera.js"], {
      cwd: path.resolve(import.meta.dirname, "../../../.."),
      encoding: null,
    });
    expect(historical.status).toBe(0);
    fs.writeFileSync(plugin, historical.stdout);
    const observed = observeLifecyclePath(plugin, [home]);
    appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(installRoot), {
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

    const { payload } = captureDoctor();
    const resource = payload.retired_resources.resources[0];

    expect(resource).toMatchObject({
      id: "opencode.plugin.agentera",
      status: "pending_automatic_removal",
    });
    expect(resource.next_action).toContain(" upgrade ");
    expect(resource.next_action).not.toContain("--legacy-cleanup");
    expect(resource).not.toHaveProperty("preview_command");
    expect(payload.signals).toContainEqual(
      expect.objectContaining({
        kind: "retired_native_resources_pending_automatic_removal",
      }),
    );

    let text = "";
    const rc = cmdDoctor({ home, project, installRoot }, { out: (output) => (text += output) });

    expect(rc).toBe(1);
    expect(text).toContain("  - pending automatic removal: opencode.plugin.agentera");
    expect(text).toContain(`    Next action: ${resource.next_action}`);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("explicit cleanup");
  });

  it("runs an exact read-only diagnostic preview without accepting a cleanup selector", () => {
    const plugin = path.join(home, ".config", "opencode", "plugins", "agentera.js");
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, "USER_SECRET_MUST_NOT_LEAK");
    let output = "";

    const rc = main(["node", "agentera", "doctor", "--home", home, "--project", project, "--retired-resource", "opencode.plugin.agentera", "--format", "json"], { out: (text) => (output += text) });
    const payload = JSON.parse(output) as Record<string, any>;

    expect(rc).toBe(1);
    expect(payload.retired_resources.selectedResourceId).toBe("opencode.plugin.agentera");
    expect(payload.retired_resources.resources.map((resource: { id: string }) => resource.id)).toEqual(["opencode.plugin.agentera"]);
    expect(payload.retired_resources.resources[0]).toMatchObject({ status: "manual_review" });
    expect(payload.retired_resources.resources[0]).not.toHaveProperty("next_action");
    expect(JSON.stringify(payload)).not.toContain("USER_SECRET_MUST_NOT_LEAK");
  });

  it.each(INSTALLED_HOOKS)("replays %s under its explicit non-default install root", (name) => {
    const explicitInstallRoot = path.join(root, "explicit-agentera");
    const resourceId = `agentera.installed-hook.${name}`;
    const hook = path.join(explicitInstallRoot, "hooks", name);
    const secret = "USER_SECRET_MUST_NOT_LEAK";
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, secret);

    const diagnosed = captureDoctor({ installRoot: explicitInstallRoot });
    const candidate = (diagnosed.payload.retired_resources.resources as Array<Record<string, any>>).find((resource) => resource.id === resourceId);
    expect(candidate).toBeDefined();
    const replayed = replayPreview(candidate.preview_command, explicitInstallRoot, resourceId);

    expect(replayed.rc).toBe(1);
    expect(replayed.payload.retired_resources.selectedResourceId).toBe(resourceId);
    expect(replayed.payload.retired_resources.resources).toEqual([
      expect.objectContaining({
        id: resourceId,
        evidence: expect.objectContaining({ paths: [hook] }),
      }),
    ]);
    expect(fs.readFileSync(hook, "utf8")).toBe(secret);
  });

  it("fails closed when installed-hook root evidence is omitted or mismatched", () => {
    const explicitInstallRoot = path.join(root, "explicit-agentera");
    const resourceId = "agentera.installed-hook.validate_artifact.py";
    const hook = path.join(explicitInstallRoot, "hooks", "validate_artifact.py");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "USER_SECRET_MUST_NOT_LEAK");
    const candidate = (captureDoctor({ installRoot: explicitInstallRoot }).payload.retired_resources.resources as Array<Record<string, any>>).find((resource) => resource.id === resourceId)!;
    const omittedRoot = candidate.preview_command.replace(` --install-root ${explicitInstallRoot}`, "");
    const mismatchedRoot = candidate.preview_command.replace(explicitInstallRoot, installRoot);

    expect(() => replayPreview(omittedRoot, explicitInstallRoot, resourceId)).toThrow(`retired-resource preview must carry install root ${explicitInstallRoot}`);
    expect(() => replayPreview(mismatchedRoot, explicitInstallRoot, resourceId)).toThrow(`retired-resource preview must carry install root ${explicitInstallRoot}`);
    expect(fs.readFileSync(hook, "utf8")).toBe("USER_SECRET_MUST_NOT_LEAK");
  });

  it("preserves user-owned collisions, fails closed on unsafe candidates, and leaks no contents", () => {
    const descriptor = path.join(home, ".codex", "agents", "build.toml");
    const pluginConfig = path.join(home, ".codex", "config.toml");
    const secret = "USER_SECRET_MUST_NOT_LEAK";
    fs.mkdirSync(path.dirname(descriptor), { recursive: true });
    fs.writeFileSync(descriptor, secret);
    fs.mkdirSync(path.dirname(pluginConfig), { recursive: true });
    fs.writeFileSync(pluginConfig, secret);
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(pluginConfig, path.join(home, ".claude", "skills", "agentera"), "file");
    const descriptorBefore = fs.readFileSync(descriptor, "utf8");
    const pluginBefore = fs.readFileSync(pluginConfig, "utf8");

    const { payload } = captureDoctor();
    const resources = payload.retired_resources.resources as Array<Record<string, any>>;

    expect(payload.status).toBe("manual_review_needed");
    expect(resources).toContainEqual(
      expect.objectContaining({
        id: "codex.agent-descriptor.build",
        status: "manual_review",
        evidence: expect.objectContaining({ observation: "path_present", paths: [descriptor] }),
      }),
    );
    expect(resources).toContainEqual(
      expect.objectContaining({
        id: "claude.agentera-skill-link",
        evidence: expect.objectContaining({ observation: "path_present" }),
      }),
    );
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(fs.readFileSync(descriptor, "utf8")).toBe(descriptorBefore);
    expect(fs.readFileSync(pluginConfig, "utf8")).toBe(pluginBefore);
    expect(fs.lstatSync(path.join(home, ".claude", "skills", "agentera")).isSymbolicLink()).toBe(true);
  });

  it.each(loadNativeResourceCleanupContract().diagnosticResources)("fails closed for the %s diagnostic class", (definition) => {
    const name = definition.names[0] ?? "";
    const target = path.join(root, `target-${definition.vocabulary}`);
    const destination = expand(definition.destinations[0]!, name);
    fs.writeFileSync(target, "USER_SECRET_MUST_NOT_LEAK");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(target, destination, "file");

    const diagnosis = diagnoseRetiredResources({ home, project, installRoot });
    const id = definition.id.replace("{name}", name);

    expect(diagnosis.resources).toContainEqual(
      expect.objectContaining({
        id,
        status: "action_required",
        evidence: expect.objectContaining({ paths: [destination] }),
      }),
    );
    expect(JSON.stringify(diagnosis)).not.toContain("USER_SECRET_MUST_NOT_LEAK");
    expect(fs.readFileSync(target, "utf8")).toBe("USER_SECRET_MUST_NOT_LEAK");
  });
});
