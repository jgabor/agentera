import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseYaml, dumpYamlMapping } from "../../src/core/yaml.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";
import { printStateHelp } from "../../src/cli/help.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch/index.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const BUNDLE = path.join(ROOT, "packages/cli/bundle");
const RETIRED = /\b(?:stable_id|artifact_id|entry_number|task_number|experiment_number|plan_id|objective_id)\b|--(?:number|plan|task)(?=$|[\s=])|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:plan|task|objective|experiment|progress|decision|health):(?:[a-z]{10}|\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b|\b[a-z]{10}\/experiment:\d+\b/g;

interface Finding { surface: string; pointer: string; match: string; excerpt: string }
interface Exception { surface: string; pointer: string; match: string; expected: string; reason: string }
type ReferenceClassification = { kind: "active" } | { kind: "excluded"; reason: "immutable history" | "migration input/apply internals" | "evaluator fixture" | "internal adapter not public identity" };

function files(patternRoot: string, suffix?: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (!suffix || entry.name.endsWith(suffix)) found.push(path.relative(ROOT, absolute).split(path.sep).join("/"));
    }
  };
  walk(path.join(ROOT, patternRoot));
  return found;
}

const ALWAYS_ACTIVE_SOURCE_MANIFEST = [
  "README.md",
  "packages/cli/README.md",
  "skills/agentera/SKILL.md",
  "skills/agentera/protocol.yaml",
  "registry.json",
  ...files("packages/cli/src/capabilities", "instructions.ts"),
  ...files("skills/agentera/capabilities", ".yaml"),
  ...files("skills/agentera/schemas/artifacts", ".yaml"),
].sort();

const REFERENCE_CLASSIFICATIONS: Record<string, ReferenceClassification> = {
  "references/adapters/cursor.md": { kind: "active" },
  "references/adapters/opencode.md": { kind: "active" },
  "references/adapters/package-manifest-interface-model.yaml": { kind: "active" },
  "references/adapters/package-registry.yaml": { kind: "active" },
  "references/adapters/package-surface-characterization.md": { kind: "active" },
  "references/adapters/runtime-adapter-characterization.md": { kind: "active" },
  "references/adapters/runtime-adapter-interface-model.yaml": { kind: "active" },
  "references/adapters/runtime-adapter-registry.yaml": { kind: "active" },
  "references/adapters/runtime-feature-parity.md": { kind: "active" },
  "references/adapters/runtime-lifecycle-adapters.yaml": { kind: "active" },
  "references/adapters/runtime-lifecycle-authority.yaml": { kind: "active" },
  "references/adapters/runtime-lifecycle-operation-contract.yaml": { kind: "active" },
  "references/adapters/runtime-retired-resources.yaml": { kind: "active" },
  "references/analysis/benchmark.md": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence-tier-authority.yaml": { kind: "active" },
  "references/analysis/startup-measurement-contract.yaml": { kind: "active" },
  "references/artifacts/artifact-registry-interface-model.yaml": { kind: "excluded", reason: "internal adapter not public identity" },
  "references/artifacts/state-storage-authority.yaml": { kind: "active" },
  "references/artifacts/verbosity-budget-authority.yaml": { kind: "excluded", reason: "internal adapter not public identity" },
  "references/cli/agent-ready-state-contract.yaml": { kind: "active" },
  "references/cli/app-lifecycle-vocabulary.yaml": { kind: "active" },
  "references/cli/audience-namespace-cli-migration.yaml": { kind: "excluded", reason: "migration input/apply internals" },
  "references/cli/bundle-skill-vocabulary.yaml": { kind: "active" },
  "references/cli/capability-instruction-contract.yaml": { kind: "active" },
  "references/cli/capability-instruction-structure.md": { kind: "active" },
  "references/cli/capability-tool-classification.yaml": { kind: "active" },
  "references/cli/coexistence-probe.yaml": { kind: "excluded", reason: "evaluator fixture" },
  "references/cli/parity-expected-actual-template.md": { kind: "excluded", reason: "evaluator fixture" },
  "references/cli/prime-consumer-compatibility.yaml": { kind: "active" },
  "references/cli/routing-execution-vocabulary.yaml": { kind: "active" },
  "references/cli/routing-model.md": { kind: "active" },
  "references/cli/single-name-protocol.yaml": { kind: "active" },
  "references/cli/trigger-schema-enrichment.md": { kind: "active" },
  "references/cli/update-channels.yaml": { kind: "active" },
  "references/cli/upgrade-repair-wording.md": { kind: "active" },
  "references/cli/v3-handoff-manifest.schema.yaml": { kind: "excluded", reason: "migration input/apply internals" },
  "references/cli/vocabulary-index.yaml": { kind: "active" },
  "references/cli/vocabulary.md": { kind: "active" },
  "references/meta/documentation-inventory.md": { kind: "active" },
};

const STATE_STORAGE_EXACT: Array<[string, string]> = [
  ["/entity_target/public_schema/forbidden_canonical_aliases/0", "stable_id"],
  ["/entity_target/public_schema/forbidden_canonical_aliases/1", "artifact_id"],
  ["/entity_target/public_schema/forbidden_canonical_aliases/2", "entry_number"],
  ["/entity_target/public_schema/forbidden_canonical_aliases/4", "task_number"],
  ["/entity_target/public_schema/forbidden_canonical_aliases/5", "experiment_number"],
  ["/entity_target/public_schema/forbidden_canonical_aliases/6", "plan_id"],
  ["/entity_target/public_schema/forbidden_canonical_aliases/7", "objective_id"],
  ["/entity_target/entities/0/record/forbidden_fields/3", "stable_id"], ["/entity_target/entities/0/record/forbidden_fields/4", "artifact_id"], ["/entity_target/entities/0/record/forbidden_fields/5", "entry_number"],
  ["/entity_target/entities/1/record/forbidden_fields/3", "stable_id"], ["/entity_target/entities/1/record/forbidden_fields/4", "artifact_id"], ["/entity_target/entities/1/record/forbidden_fields/5", "entry_number"],
  ["/entity_target/entities/2/record/forbidden_fields/3", "stable_id"], ["/entity_target/entities/2/record/forbidden_fields/4", "artifact_id"], ["/entity_target/entities/2/record/forbidden_fields/5", "entry_number"],
  ["/entity_target/entities/3/record/forbidden_fields/3", "stable_id"], ["/entity_target/entities/3/record/forbidden_fields/4", "artifact_id"], ["/entity_target/entities/3/record/forbidden_fields/5", "entry_number"],
  ["/entity_target/entities/4/record/forbidden_fields/3", "stable_id"], ["/entity_target/entities/4/record/forbidden_fields/4", "artifact_id"], ["/entity_target/entities/4/record/forbidden_fields/5", "entry_number"],
  ["/entity_target/entities/5/record/forbidden_fields/2", "stable_id"], ["/entity_target/entities/5/record/forbidden_fields/3", "plan_id"],
  ["/entity_target/entities/6/record/forbidden_fields/3", "task_number"], ["/entity_target/entities/6/record/forbidden_fields/4", "stable_id"], ["/entity_target/entities/6/record/forbidden_fields/5", "plan_id"],
  ["/entity_target/entities/7/record/forbidden_fields/2", "stable_id"], ["/entity_target/entities/7/record/forbidden_fields/3", "objective_id"],
  ["/entity_target/entities/8/record/forbidden_fields/3", "experiment_number"], ["/entity_target/entities/8/record/forbidden_fields/4", "stable_id"], ["/entity_target/entities/8/record/forbidden_fields/5", "objective_id"],
  ["/entity_target/entities/9/record/forbidden_fields/3", "stable_id"], ["/entity_target/entities/9/record/forbidden_fields/4", "artifact_id"], ["/entity_target/entities/9/record/forbidden_fields/5", "entry_number"],
  ["/entity_target/entities/10/record/forbidden_fields/3", "stable_id"], ["/entity_target/entities/10/record/forbidden_fields/4", "artifact_id"], ["/entity_target/entities/10/record/forbidden_fields/5", "entry_number"],
  ["/scope/supported_artifacts/0/artifact_id", "artifact_id"], ["/scope/supported_artifacts/1/artifact_id", "artifact_id"], ["/scope/supported_artifacts/2/artifact_id", "artifact_id"],
  ["/retrieval/envelope/entry_required_fields/0", "stable_id"], ["/retrieval/identity/plan/test_vectors/0/stable_id", "stable_id"], ["/retrieval/identity/task/selector", "--task"], ["/retrieval/identity/objective/test_vectors/0/stable_id", "stable_id"],
  ["/retrieval/identity/experiment/publication/command", "--number"], ["/retrieval/identity/experiment/publication/identity_assignment", "--number"],
  ["/retrieval/commands/plan_tasks/list", "--plan"], ["/retrieval/commands/plan_tasks/get", "--plan"], ["/retrieval/commands/plan_tasks/get", "--task"], ["/retrieval/commands/plans/get", "--plan"], ["/retrieval/commands/experiments/get", "--number"], ["/retrieval/commands/experiments/publish", "--number"],
  ["/retrieval/collections/0/artifact_id", "artifact_id"], ["/retrieval/collections/0/get", "--number"], ["/retrieval/collections/1/artifact_id", "artifact_id"], ["/retrieval/collections/1/get", "--number"], ["/retrieval/collections/2/artifact_id", "artifact_id"], ["/retrieval/collections/2/get", "--number"],
  ["/retrieval/collections/3/artifact_id", "artifact_id"], ["/retrieval/collections/4/artifact_id", "artifact_id"], ["/retrieval/collections/5/artifact_id", "artifact_id"], ["/retrieval/collections/6/artifact_id", "artifact_id"], ["/retrieval/collections/7/artifact_id", "artifact_id"], ["/retrieval/collections/8/artifact_id", "artifact_id"],
  ["/retrieval/non_collections/0/artifact_id", "artifact_id"], ["/retrieval/non_collections/1/artifact_id", "artifact_id"], ["/retrieval/non_collections/2/artifact_id", "artifact_id"], ["/retrieval/non_collections/3/artifact_id", "artifact_id"], ["/retrieval/non_collections/4/artifact_id", "artifact_id"],
  ["/experiment_archival/identity/stable_id", "stable_id"], ["/experiment_archival/identity/path_selector", "experiment_number"], ["/experiment_archival/identity/objective_binding", "objective_id"], ["/experiment_archival/identity/content_binding", "experiment_number"],
  ["/experiment_archival/envelope/required_fields/1", "stable_id"], ["/experiment_archival/envelope/required_fields/2", "objective_id"], ["/experiment_archival/envelope/required_fields/3", "experiment_number"], ["/experiment_archival/envelope/provenance_required_fields/1", "objective_id"],
  ["/storage/archive/filename/entry_number", "entry_number"], ["/storage/archive/filename/directory_name", "artifact_id"], ["/storage/archive/retry_policy", "artifact_id"], ["/storage/archive/retry_policy", "entry_number"],
  ["/identity/stable_id", "stable_id"], ["/identity/components/artifact_id", "artifact_id"], ["/identity/components/artifact_id", "artifact_id"], ["/identity/components/entry_number", "entry_number"], ["/identity/uniqueness", "stable_id"], ["/identity/ordering/list", "entry_number"], ["/identity/ordering/tie_breaker", "stable_id"], ["/identity/ordering/get", "stable_id"],
  ["/identity/legacy_rows/canonical_number", "entry_number"], ["/identity/legacy_rows/unaddressable", "stable_id"], ["/identity/legacy_rows/unaddressable", "entry_number"], ["/identity/legacy_rows/ambiguous", "stable_id"],
  ["/envelope/required_fields/1", "artifact_id"], ["/envelope/required_fields/2", "entry_number"], ["/envelope/field_contract/artifact_id", "artifact_id"], ["/envelope/field_contract/entry_number", "entry_number"], ["/envelope/identity_checks/0", "artifact_id"], ["/envelope/identity_checks/1", "entry_number"], ["/envelope/identity_checks/2", "entry_number"],
  ["/projections/summary/required_item_fields/0", "stable_id"], ["/projections/summary/required_item_fields/1", "artifact_id"], ["/projections/summary/required_item_fields/2", "entry_number"], ["/projections/summary/nullable_item_fields/0", "stable_id"], ["/projections/summary/nullable_item_fields/1", "entry_number"],
  ["/api/direct_get/command", "--number"], ["/api/direct_get/examples/progress", "--number"], ["/api/direct_get/examples/decisions", "--number"], ["/api/direct_get/examples/health", "--number"], ["/api/direct_get/required_selector", "--number"], ["/api/direct_get/result", "stable_id"],
  ["/api/list/response_fields/entry/0", "stable_id"], ["/api/list/response_fields/entry/1", "artifact_id"], ["/api/list/response_fields/entry/2", "entry_number"],
  ["/api/durability/command", "--number"], ["/api/durability/response_fields/entry/0", "stable_id"], ["/api/durability/response_fields/entry/1", "artifact_id"], ["/api/durability/response_fields/entry/2", "entry_number"],
  ["/api/backfill/command", "--number"], ["/api/backfill/apply_requires/4", "--number"], ["/api/backfill/response/entry_fields/1", "artifact_id"], ["/api/backfill/response/entry_fields/2", "entry_number"], ["/api/backfill/omission/continuation", "--number"],
  ["/api/migrate/command", "--number"], ["/api/migrate/selectors/number/flag", "--number"], ["/api/migrate/modes/apply/selectors_required/1", "--number"], ["/api/migrate/result/entry_fields/2", "artifact_id"], ["/api/migrate/result/entry_fields/3", "entry_number"], ["/api/migrate/result/omission/output_retry", "--number"],
  ["/api/migrate/failures/classes/0/example", "--number"], ["/api/migrate/failures/classes/3/example", "--number"], ["/api/migrate/failures/classes/4/example", "--number"], ["/api/migrate/failures/classes/5/example", "--number"], ["/api/migrate/failures/classes/6/example", "--number"], ["/api/migrate/failures/classes/7/example", "--number"],
  ["/failures/envelope/error_optional_fields/0", "artifact_id"], ["/failures/envelope/error_optional_fields/1", "entry_number"], ["/failures/envelope/error_optional_fields/2", "stable_id"],
];

const RUNTIME_EXACT: Array<[string, string]> = [
  ["/schema/state_migration/command", "--number"], ["/schema/state_migration/selectors/number/flag", "--number"], ["/schema/state_migration/modes/apply/selectors_required/1", "--number"], ["/schema/state_migration/result/entry_fields/2", "artifact_id"], ["/schema/state_migration/result/entry_fields/3", "entry_number"], ["/schema/state_migration/result/omission/output_retry", "--number"],
  ["/schema/state_migration/failures/classes/0/example", "--number"], ["/schema/state_migration/failures/classes/3/example", "--number"], ["/schema/state_migration/failures/classes/4/example", "--number"], ["/schema/state_migration/failures/classes/5/example", "--number"], ["/schema/state_migration/failures/classes/6/example", "--number"], ["/schema/state_migration/failures/classes/7/example", "--number"],
  ["/schema/state_backfill/command", "--number"], ["/schema/state_backfill/apply_requires/4", "--number"], ["/schema/state_backfill/response/entry_fields/1", "artifact_id"], ["/schema/state_backfill/response/entry_fields/2", "entry_number"], ["/schema/state_backfill/recovery/omission", "--number"],
  ["/explain/stdout/guidance/0", "--number"], ["/legacy_explain/stdout/guidance/0", "--number"],
];

function pointerEscape(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }

function semanticFindings(surface: string, value: unknown, pointer = ""): Finding[] {
  const findings: Finding[] = [];
  if (Array.isArray(value)) value.forEach((child, index) => findings.push(...semanticFindings(surface, child, `${pointer}/${index}`)));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPointer = `${pointer}/${pointerEscape(key)}`;
      for (const match of key.matchAll(RETIRED)) findings.push({ surface, pointer: childPointer, match: match[0], excerpt: key });
      findings.push(...semanticFindings(surface, child, childPointer));
    }
  } else if (typeof value === "string") {
    for (const match of value.matchAll(RETIRED)) findings.push({ surface, pointer: pointer || "/", match: match[0], excerpt: value });
  }
  return findings;
}

function textFindings(surface: string, text: string): Finding[] {
  let section = "preamble";
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line); if (heading) section = heading[2].trim();
    for (const match of line.matchAll(RETIRED)) findings.push({ surface, pointer: `section=${section};line=${index + 1}`, match: match[0], excerpt: line.trim() });
  });
  return findings;
}

function fileFindings(relative: string): Finding[] {
  const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
  if (relative.endsWith(".yaml") || relative.endsWith(".yml")) return semanticFindings(relative, parseYaml(text));
  if (relative.endsWith(".json")) return semanticFindings(relative, JSON.parse(text));
  return textFindings(relative, text);
}

function exactExceptions(findings: Finding[], runtime: any): Exception[] {
  expect(runtime.explain.stdout.guidance).toContain("number is assigned by the CLI; do not pass --number");
  expect(runtime.legacy_explain.stdout).toMatchObject({ classification: "legacy_migration_evidence", recovery_only: true });
  const exceptions: Exception[] = [];
  const add = (surface: string, pointer: string, match: string, expected: string, reason: string): void => {
    exceptions.push({ surface, pointer, match, expected, reason });
  };
  const addPaired = (surface: string, pointer: string, match: string, expected: string, reason: string): void => {
    add(surface, pointer, match, expected, reason);
    const generated = new Map(copyOwnedPairs()).get(surface);
    if (generated) add(generated, pointer, match, expected, reason);
  };

  for (const [pointer, match] of STATE_STORAGE_EXACT) {
    const negative = pointer.includes("/forbidden_");
    addPaired("references/artifacts/state-storage-authority.yaml", pointer, match, match, negative ? "exact negative prohibition" : "exact pre-cutover migration input/apply contract");
  }
  for (const [pointer, match] of RUNTIME_EXACT) add("runtime://public-structured-outputs", pointer, match, match, pointer.includes("/guidance/") ? "exact negative prohibition" : "exact migration input/apply runtime contract");
  for (const [pointer, match] of [["/PUBLICATION/4/required_fields/1", "stable_id"], ["/PUBLICATION/4/required_fields/2", "objective_id"], ["/PUBLICATION/4/required_fields/3", "experiment_number"], ["/PUBLICATION/4/provenance_fields/1", "objective_id"]] as Array<[string, string]>) {
    addPaired("skills/agentera/schemas/artifacts/experiments.yaml", pointer, match, match, "exact legacy experiment migration source envelope");
  }
  addPaired("references/cli/prime-consumer-compatibility.yaml", "/plan", "plan:634c092e-a7bc-48f4-80ee-2c91940e54f1", "plan:634c092e-a7bc-48f4-80ee-2c91940e54f1", "exact immutable plan evidence reference");
  for (const [line, text] of [[202, "npx -y agentera@next state migrate --project \"$PWD\" --artifact progress --number N --dry-run --format json"], [203, "npx -y agentera@next state migrate --project \"$PWD\" --artifact progress --number N --apply --force --format json"], [214, "npx -y agentera@next state backfill --project \"$PWD\" --artifact progress --number N --dry-run --format json"], [215, "npx -y agentera@next state backfill --project \"$PWD\" --artifact progress --number N --apply --force --format json"]] as Array<[number, string]>) {
    addPaired("UPGRADE.md", `section=Legacy state and optional Git enrichment;line=${line}`, "--number", text, "exact migration input/apply command");
  }
  return exceptions;
}

function allowed(finding: Finding, exceptions: Exception[]): boolean {
  return exceptions.some((exception) => exception.surface === finding.surface && exception.pointer === finding.pointer && exception.match === finding.match && (exception.expected === finding.match || exception.expected === finding.excerpt));
}

function classifyReference(relative: string): ReferenceClassification {
  const classification = REFERENCE_CLASSIFICATIONS[relative];
  if (!classification) throw new Error(`unclassified copied reference: ${relative}`);
  return classification;
}

function classifyCopiedSurface(relative: string): ReferenceClassification {
  if (relative.startsWith("references/")) return classifyReference(relative);
  if (relative === "CHANGELOG.md") return { kind: "excluded", reason: "immutable history" };
  return { kind: "active" };
}

function copyOwnedPairs(): Array<[string, string]> {
  const registry = parseYaml(fs.readFileSync(path.join(ROOT, "references/adapters/package-registry.yaml"), "utf8")) as any;
  const surfaces = registry.records.find((entry: any) => entry.identity.id === "agentera").bundle_surfaces;
  const pairs: Array<[string, string]> = [];
  for (const file of surfaces.files) pairs.push([file.path, `packages/cli/bundle/${file.path}`]);
  for (const directory of surfaces.directories) {
    for (const source of files(directory.path).filter((file) => !file.split("/").some((part) => surfaces.skip_parts.includes(part)) && !surfaces.skip_suffixes.some((suffix: string) => file.endsWith(suffix)))) pairs.push([source, `packages/cli/bundle/${source}`]);
  }
  return pairs;
}

let project = "", legacyProject = "";
function entity(artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const file = path.join(project, ".agentera/entities", artifact, boundary, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, dumpYamlMapping({ id, artifact, record }));
}

function capture(args: string[], root = project): unknown {
  const previous = process.cwd(); let stdout = "", stderr = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], { out: (text) => stdout += text, err: (text) => stderr += text });
    return { rc, stdout: stdout.trim().startsWith("{") ? JSON.parse(stdout) : stdout, stderr };
  } finally { process.chdir(previous); }
}

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-active-protocol-"));
  legacyProject = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-legacy-evidence-protocol-"));
  fs.mkdirSync(path.join(project, ".agentera"));
  fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  entity("progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "scan", context: { intent: "test" } });
  entity("plan", "plan", "bbbbbbbbbb", { header: { level: "light", created: "2026-07-17", status: "open", title: "Scan plan" }, what: "test", why: "test", scope: { included: ["state"], excluded: [] } });
  entity("plan", "plan_task", "cccccccccc", { plan: "bbbbbbbbbb", name: "Scan task", status: "pending", depends_on: [], acceptance: ["pass"] });
});
afterAll(() => { fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(legacyProject, { recursive: true, force: true }); });

describe("authoritative active final-protocol surfaces", () => {
  it("classifies the complete registry-owned reference inventory and keeps every generated copy byte-equal", () => {
    const pairs = copyOwnedPairs();
    const references = pairs.map(([source]) => source).filter((source) => source.startsWith("references/"));
    expect(references).toEqual(files("references"));
    expect(Object.keys(REFERENCE_CLASSIFICATIONS).sort()).toEqual(references);
    expect(() => classifyReference("references/cli/new-contract.yaml")).toThrow("unclassified copied reference");
    expect(classifyReference("references/cli/vocabulary.md")).toEqual({ kind: "active" });
    expect(classifyReference("references/cli/prime-consumer-compatibility.yaml")).toEqual({ kind: "active" });
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST).toContain("README.md");
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST).toContain("packages/cli/README.md");
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST.filter((file) => file.endsWith("/instructions.ts"))).toHaveLength(CAPABILITY_NAMES.length);
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST.filter((file) => /skills\/agentera\/capabilities\/[^/]+\/schemas\/.+\.yaml$/.test(file))).toHaveLength(CAPABILITY_NAMES.length * 4);
    for (const source of references) expect(classifyReference(source)).toBeDefined();
    for (const [source, generated] of pairs) {
      const classification = classifyCopiedSurface(source);
      expect(["active", "excluded"], `${source} and ${generated}`).toContain(classification.kind);
      expect(fs.readFileSync(path.join(ROOT, generated)), generated).toEqual(fs.readFileSync(path.join(ROOT, source)));
    }
  });

  it("rejects retired public identity and selector vocabulary on source, generated, and runtime surfaces", () => {
    const activeCopiedSources = copyOwnedPairs().map(([source]) => source).filter((source) => classifyCopiedSurface(source).kind === "active");
    const activeSources = [...new Set([...ALWAYS_ACTIVE_SOURCE_MANIFEST.filter((file) => !file.endsWith("/instructions.ts")), ...activeCopiedSources])].sort();
    const findings = activeSources.flatMap(fileFindings);
    const copied = new Map(copyOwnedPairs());
    for (const source of activeSources) {
      const generated = copied.get(source);
      if (generated) {
        const sourceFindings = fileFindings(source);
        const generatedFindings = fileFindings(generated);
        expect(generatedFindings.map(({ pointer, match, excerpt }) => ({ pointer, match, excerpt })), generated).toEqual(sourceFindings.map(({ pointer, match, excerpt }) => ({ pointer, match, excerpt })));
        findings.push(...generatedFindings);
      }
    }
    const runtime = {
      help: ["progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs"].map(printStateHelp),
      schema: buildSchemaPayload(),
      instructions: CAPABILITY_INSTRUCTIONS,
      explain: capture(["state", "progress", "explain", "--format", "json"]),
      legacy_explain: capture(["state", "progress", "explain", "--format", "json"], legacyProject),
      error: capture(["state", "plan", "get", "--id", "zzzzzzzzzz", "--format", "json"]),
      prime: capture(["prime", "--format", "json"]),
      contexts: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, capture(["prime", "--context", name, "--format", "json"])])),
    };
    findings.push(...semanticFindings("runtime://public-structured-outputs", runtime));
    const exceptions = exactExceptions(findings, runtime);
    const unexpected = findings.filter((finding) => !allowed(finding, exceptions));
    expect(unexpected.map(({ surface, pointer, match, excerpt }) => ({ surface, pointer, match, excerpt }))).toEqual([]);
    for (const exception of exceptions) {
      expect(findings.some((finding) => finding.surface === exception.surface && finding.pointer === exception.pointer && finding.match === exception.match), exception.reason).toBe(true);
    }
  });
});
