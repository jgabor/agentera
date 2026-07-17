import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseYaml as loadYaml } from "../../src/core/yaml.js";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { printStateHelp } from "../../src/cli/help.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const RETIRED = /\b(?:stable_id|artifact_id|entry_number|task_number|experiment_number|plan_id|objective_id)\b|--(?:number|plan|task)(?=$|[\s=])|\b(?:plan|objective|progress|decisions|health):[0-9a-f]{8}-[0-9a-f-]{27,}\b/g;

function matches(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(RETIRED)].map((match) => match[0]);
}

function activeYaml(value: unknown, section = "root"): unknown {
  if (Array.isArray(value)) return value.map((entry) => activeYaml(entry, section)).filter((entry) => entry !== undefined);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (String(record.classification ?? "").startsWith("legacy_migration_")) return undefined;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "ARCHIVE" && !(section === "root" && key === "archive"))
    .map(([key, child]) => [key, activeYaml(child, key)]));
}

function capabilitySchemas(root: string): unknown[] {
  const capabilities = path.join(root, "skills/agentera/capabilities");
  return fs.readdirSync(capabilities).sort().map((name) => {
    const file = path.join(capabilities, name, "schemas/artifacts.yaml");
    return activeYaml(loadYaml(fs.readFileSync(file, "utf8")));
  });
}

describe("active final-protocol deny scan", () => {
  it("keeps ordinary help, schema projections, capability instructions, skills, and authority consumers free of retired identity", () => {
    const help = ["progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs"].map(printStateHelp);
    const schema = buildSchemaPayload();
    const authority = loadYaml(fs.readFileSync(path.join(ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8")) as any;
    const skill = fs.readFileSync(path.join(ROOT, "skills/agentera/SKILL.md"), "utf8");
    const experimentSchema = activeYaml(loadYaml(fs.readFileSync(path.join(ROOT, "skills/agentera/schemas/artifacts/experiments.yaml"), "utf8")));
    const active = {
      help,
      schema: { state_writer: schema.state_writer, state_retrieval: { commands: (schema.state_retrieval as any).commands, collections: (schema.state_retrieval as any).collections } },
      instructions: CAPABILITY_INSTRUCTIONS,
      capability_schemas: capabilitySchemas(ROOT),
      skill,
      artifact_schema: experimentSchema,
      authority: { public_retrieval: authority.entity_target.public_retrieval, consumers: authority.consumer_matrix.access_contract },
    };
    expect(Object.fromEntries(Object.entries(active).map(([name, value]) => [name, matches(value)]).filter(([, found]) => found.length))).toEqual({});
  });

  it("keeps generated bundle skill consumers semantically equal to source", () => {
    const bundle = path.join(ROOT, "packages/cli/bundle");
    expect(capabilitySchemas(bundle)).toEqual(capabilitySchemas(ROOT));
    expect(fs.readFileSync(path.join(bundle, "skills/agentera/SKILL.md"), "utf8"))
      .toBe(fs.readFileSync(path.join(ROOT, "skills/agentera/SKILL.md"), "utf8"));
    expect(activeYaml(loadYaml(fs.readFileSync(path.join(bundle, "references/artifacts/state-storage-authority.yaml"), "utf8"))))
      .toEqual(activeYaml(loadYaml(fs.readFileSync(path.join(ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"))));
  });
});
