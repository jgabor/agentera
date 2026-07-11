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
  it("returns adapter catalog records in deterministic order", () => {
    const registry = loadRegistry(REGISTRY_PATH);

    expect(registry.adapterIds).toEqual(["opencode", "copilot", "codex", "cursor"]);
    expect(registry.adapterIds.length).toBe(new Set(registry.adapterIds).size);
    expect(registry.adapterIds.map((id) => registry.get(id).identity.display_name)).toEqual([
      "OpenCode",
      "Copilot CLI",
      "Codex CLI",
      "Cursor IDE",
    ]);
    const opencodeLifecycle = registry.get("opencode").lifecycle_events;
    expect(opencodeLifecycle.supported_events).toContain("tool.execute.before");
    expect(opencodeLifecycle.supported_events).toContain("session.created");
    expect(opencodeLifecycle.supported_events).toContain("session.idle");
    expect(opencodeLifecycle.unsupported_events).not.toContain("session.created");
    expect(opencodeLifecycle.unsupported_events).not.toContain("session.idle");
    expect(opencodeLifecycle.event_status["session.created"]).toBe("supported_via_event");
    expect(opencodeLifecycle.event_status["session.idle"]).toBe("supported_via_event");
    expect(registry.get("opencode").subagent_dispatch.invocation_pattern.startsWith("Use @agentera")).toBe(true);
    expect(registry.get("codex").subagent_dispatch.descriptor_sources).toContain(
      "skills/agentera/agents/*.toml",
    );
    expect(registry.get("opencode").subagent_dispatch.tool_configuration).toBe("per_agent_permission");
    expect(registry.get("copilot").subagent_dispatch.tool_configuration).toBe("none");
    expect(registry.get("codex").subagent_dispatch.tool_configuration).toBe("global_sandbox_policy");
    expect(registry.get("cursor").subagent_dispatch.tool_configuration).toBe("global_full_access");
    expect(() => registry.get("claude")).toThrow("unknown runtime id: claude");
    expect(() => registry.get("cursor-agent")).toThrow("unknown runtime id: cursor-agent");
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
    malformed.records[2].identity.runtime_id = "opencode";
    malformed.records[3].lifecycle_events.supported_events.push("AfterEverything");
    malformed.records[3].install_root = { default_durable_root: "~/.agents/agentera" };

    const errors = validateRegistryData(malformed);

    expect(errors).toContain("records[0]: missing required group diagnostics");
    expect(errors).toContain("records[1].identity.runtime_id unknown adapter record id: ghost");
    expect(errors).toContain("duplicate runtime id: opencode");
    expect(errors).toContain(
      "records[3].lifecycle_events.supported_events: unsupported event name AfterEverything",
    );
    expect(errors).toContain("records[3]: forbidden ownership field install_root");
  });

  it("routes active lifecycle inventory ownership to the lifecycle authority", () => {
    const fixture = registryFixture();
    expect(fixture.lifecycle_authority).toBe(
      "references/adapters/runtime-lifecycle-authority.yaml",
    );
    expect(fixture.runtime_order).toBeUndefined();

    fixture.lifecycle_authority = "references/adapters/drifted-runtime-list.yaml";
    expect(validateRegistryData(fixture)).toContain(
      "registry.lifecycle_authority must point to references/adapters/runtime-lifecycle-authority.yaml",
    );
  });

  it.each(["claude", "cursor-agent"])("rejects %s as an active adapter record", (runtimeId) => {
    const fixture = registryFixture();
    fixture.adapter_record_order.push(runtimeId);
    const retired = structuredClone(fixture.records[0]);
    retired.identity.runtime_id = runtimeId;
    fixture.records.push(retired);
    const errors = validateRegistryData(fixture);
    expect(errors).toContain("registry.adapter_record_order must contain active runtime records only");
    expect(errors).toContain(`records[4].identity.runtime_id cannot be an active adapter record: ${runtimeId}`);
  });

  it("consumer views share changed fixture facts", () => {
    const fixture = registryFixture();
    const changed = structuredClone(fixture);
    changed.records[1].identity.display_name = "Copilot Canary";

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
