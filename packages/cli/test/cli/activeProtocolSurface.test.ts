import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { printStateHelp } from "../../src/cli/help.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { semanticFindings } from "./retiredVocabulary.js";

let project = "";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function entity(artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const file = path.join(project, ".agentera/entities", artifact, boundary, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, dumpYamlMapping({ id, artifact, record }));
}

function capture(args: string[]): { rc: number; output: unknown; stderr: string } {
  const previous = process.cwd();
  let stdout = "", stderr = "";
  process.chdir(project);
  try {
    const rc = main(["node", "agentera", ...args], { out: (text) => stdout += text, err: (text) => stderr += text });
    const trimmed = stdout.trim();
    return { rc, output: trimmed.startsWith("{") ? JSON.parse(trimmed) : trimmed, stderr };
  } finally {
    process.chdir(previous);
  }
}

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-active-protocol-"));
  fs.mkdirSync(path.join(project, ".agentera"));
  fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  entity("progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "scan", context: { intent: "test" } });
  entity("plan", "plan", "bbbbbbbbbb", { header: { level: "light", created: "2026-07-17", status: "open", title: "Scan plan" }, what: "test", why: "test", scope: { included: ["state"], excluded: [] } });
});

afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

describe("public runtime vocabulary", () => {
  it("does not emit retired identity or selector vocabulary", () => {
    const rootHelp = capture(["--help"]);
    const stateHelp = ["progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs"].map(printStateHelp);
    const schema = capture(["schema", "--format", "json"]);
    const explain = capture(["state", "progress", "explain", "--format", "json"]);
    const error = capture(["state", "plan", "get", "--id", "zzzzzzzzzz", "--format", "json"]);
    const prime = capture(["prime", "--format", "json"]);

    expect(rootHelp.rc).toBe(0);
    expect(schema.rc).toBe(0);
    expect(explain.rc).toBe(0);
    expect(error.rc).toBe(1);
    expect(prime.rc).toBe(0);
    expect(semanticFindings("runtime://public-cli", { rootHelp, stateHelp, schema, explain, error, prime })).toEqual([]);
  });

  it("keeps the two-phase routing boundary and receipt authorization current", () => {
    const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/SKILL.md"), "utf8");
    const routingModel = fs.readFileSync(path.join(REPO_ROOT, "references/cli/routing-model.md"), "utf8");
    const hybridRouteContract = fs.readFileSync(path.join(REPO_ROOT, "references/cli/hybrid-route-contract.yaml"), "utf8");
    const vocabulary = fs.readFileSync(path.join(REPO_ROOT, "references/cli/vocabulary.md"), "utf8");
    const enrichment = fs.readFileSync(path.join(REPO_ROOT, "references/cli/trigger-schema-enrichment.md"), "utf8");
    const triggerContract = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/capability_schema_contract.yaml"), "utf8");
    const routingVocabulary = vocabulary.slice(
      vocabulary.indexOf("## Invocation and routing grammar"),
      vocabulary.indexOf("CLI-visible `agentera prime` labels"),
    );
    const descriptionExample = enrichment.slice(
      enrichment.indexOf("### 1.1 `description`"),
      enrichment.indexOf("### 1.2 `disambiguates_against`"),
    );

    expect(skill).toContain("The CLI first applies deterministic explicit and curated route tiers.");
    expect(skill).toContain("Only after the shared route contract returns `semantic_required`");
    expect(skill).toContain("complete nullable API receipt");
    expect(skill).toContain("semantic_capsule_sha256");
    expect(skill).toContain("only through that returned authorization");
    expect(skill).toMatch(/next_action` is a readiness suggestion for bare\/status\s+orientation after classification; it never classifies or overrides a non-status\s+request/);
    expect(skill).not.toContain("next_action.capability");
    expect(skill).toMatch(/no scores, thresholds, or\s+borderline band/);
    expect(hybridRouteContract).toContain("open-ended semantic judgment only after deterministic abstention");
    expect(hybridRouteContract).toContain("all startup authorization");
    expect(hybridRouteContract).toContain("must submit a receipt");
    expect(hybridRouteContract).toContain("semantic_capsule_binding");
    expect(routingModel).toContain("no scoring engine, no confidence threshold, and no borderline band");
    expect(routingModel).toMatch(/Every other request returns\s+`semantic_required`/);
    expect(routingModel).toMatch(/the CLI validates it\s+before capability startup/);
    expect(routingModel).toContain("semantic_capsule_sha256");
    expect(routingModel).toMatch(/next_action`\s+informs readiness only after classification and cannot override the message\s+intent/);
    expect(routingModel).toContain("route to status for orientation only after no capability matches");
    expect(routingModel).toContain("not semantic generalization or an end-to-end latency commitment");
    expect(routingModel).not.toContain("ambiguous inputs");
    expect(routingVocabulary).toContain("only after deterministic routing returns `semantic_required`");
    expect(routingVocabulary).toContain("receipt the CLI validates before startup");
    expect(enrichment).toContain("Current boundary and obsolete layer numbering");
    expect(enrichment).toContain("Only a `semantic_required` response may expose these fields to a host.");
    expect(enrichment).not.toContain("Authority for Layer 3 LLM-native capability routing.");
    expect(enrichment).not.toContain("clear intent routes directly");
    expect(descriptionExample).toContain("disambiguates_against:");
    expect(descriptionExample).not.toContain("patterns:");
    expect(triggerContract).toContain("active semantic trigger model");
    expect(triggerContract).toContain("never returns a RegExp or matches it");
  });
});
