import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  RegistryError,
  RuntimeAdapterRegistry,
  loadRegistry,
  validateRegistryData,
} from "../../src/registries/runtimeAdapterRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REGISTRY_PATH = path.join(REPO_ROOT, "references/adapters/runtime-adapter-registry.yaml");

function registryFixture(): any {
  const data = YAML.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  expect(typeof data).toBe("object");
  return data;
}

describe("runtime adapter registry", () => {
  it("returns current runtimes in deterministic order", () => {
    const registry = loadRegistry(REGISTRY_PATH);

    expect(registry.runtimeIds).toEqual(["claude", "opencode", "copilot", "codex", "cursor", "cursor-agent"]);
    expect(registry.runtimeIds.length).toBe(new Set(registry.runtimeIds).size);
    expect(registry.runtimeIds.map((id) => registry.get(id).identity.display_name)).toEqual([
      "Claude Code",
      "OpenCode",
      "Copilot CLI",
      "Codex CLI",
      "Cursor IDE",
      "Cursor Agent CLI",
    ]);
    const opencodeLifecycle = registry.get("opencode").lifecycle_events;
    expect(opencodeLifecycle.supported_events).toContain("chat.message");
    expect(opencodeLifecycle.supported_events).toContain("session.created");
    expect(opencodeLifecycle.supported_events).toContain("session.idle");
    expect(opencodeLifecycle.unsupported_events).not.toContain("session.created");
    expect(opencodeLifecycle.unsupported_events).not.toContain("session.idle");
    expect(opencodeLifecycle.event_status["session.created"]).toBe("supported_via_event");
    expect(opencodeLifecycle.event_status["session.idle"]).toBe("supported_via_event");
    expect(registry.get("opencode").subagent_dispatch.invocation_pattern.startsWith("Use @<capability>")).toBe(true);
    expect(registry.get("codex").subagent_dispatch.descriptor_sources).toContain(
      "skills/agentera/agents/*.toml",
    );
    expect(registry.get("claude").subagent_dispatch.tool_configuration).toBe("none");
    expect(registry.get("opencode").subagent_dispatch.tool_configuration).toBe("per_agent_permission");
    expect(registry.get("copilot").subagent_dispatch.tool_configuration).toBe("none");
    expect(registry.get("codex").subagent_dispatch.tool_configuration).toBe("global_sandbox_policy");
    expect(registry.get("cursor").subagent_dispatch.tool_configuration).toBe("global_full_access");
    expect(registry.get("cursor-agent").subagent_dispatch.tool_configuration).toBe("global_full_access");
  });

  it("gives clear diagnostics for known and unknown ids", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    expect(registry.get("codex").identity.display_name).toBe("Codex CLI");
    expect(() => registry.get("ghost")).toThrow(RegistryError);
    try {
      registry.get("ghost");
    } catch (err) {
      expect((err as Error).message).toBe("unknown runtime id: ghost");
    }
  });

  it("reports malformed fixtures clearly", () => {
    const fixture = registryFixture();
    const malformed = structuredClone(fixture);
    delete malformed.records[0].diagnostics;
    malformed.records[1].identity.runtime_id = "ghost";
    malformed.records[2].identity.runtime_id = "codex";
    malformed.records[3].lifecycle_events.supported_events.push("AfterEverything");
    malformed.records[3].install_root = { default_durable_root: "~/.agents/agentera" };

    const errors = validateRegistryData(malformed);

    expect(errors).toContain("records[0]: missing required group diagnostics");
    expect(errors).toContain("records[1].identity.runtime_id unknown runtime id: ghost");
    expect(errors).toContain("duplicate runtime id: codex");
    expect(errors).toContain(
      "records[3].lifecycle_events.supported_events: unsupported event name AfterEverything",
    );
    expect(errors).toContain("records[3]: forbidden ownership field install_root");
  });

  it("consumer views share changed fixture facts", () => {
    const fixture = registryFixture();
    const changed = structuredClone(fixture);
    changed.records[2].identity.display_name = "Copilot Canary";

    expect(validateRegistryData(changed)).toEqual([]);
    const registry = new RuntimeAdapterRegistry(changed.records);

    const observed: Record<string, string> = {};
    for (const consumer of ["lifecycle", "doctor", "upgrade", "docs", "tests"]) {
      observed[consumer] = registry.consumerView(consumer, "copilot").identity.display_name;
    }
    expect(observed).toEqual({
      lifecycle: "Copilot Canary",
      doctor: "Copilot Canary",
      upgrade: "Copilot Canary",
      docs: "Copilot Canary",
      tests: "Copilot Canary",
    });
    expect("subagent_dispatch" in registry.consumerView("upgrade", "copilot")).toBe(true);
    expect("subagent_dispatch" in registry.consumerView("tests", "copilot")).toBe(true);
  });

  it("rejects package-metadata and install-root ownership fields", () => {
    for (const forbiddenField of [
      "version_authority",
      "package_manifest_schemas",
      "install_root_classification",
      "root_diagnostics",
    ]) {
      const fixture = registryFixture();
      fixture.records[0].identity[forbiddenField] = "not-runtime-owned";
      const errors = validateRegistryData(fixture);
      expect(errors).toContain(`records[0].identity: forbidden ownership field ${forbiddenField}`);
    }
  });
});
