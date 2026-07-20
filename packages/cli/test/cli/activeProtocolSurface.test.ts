import fs from "node:fs";
import crypto from "node:crypto";
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
const RETIRED = /\b(?:stable_id|artifact_id|entry_number|task_number|experiment_number|plan_id|objective_id)\b|--(?:number|plan|task)(?=$|[\s=])|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:plan|task|objective|experiment|progress|decision|health):(?:[a-z]{10}|\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b|\b[a-z]{10}\/experiment:\d+\b/g;

interface Finding { surface: string; pointer: string; match: string; excerpt: string; contextHash: string }
interface Exception { surface: string; pointer: string; match: string; contextHash: string; reason: string }
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
  return found.sort();
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
  "references/adapters/package-manifest-interface-model.yaml": { kind: "active" },
  "references/adapters/package-registry.yaml": { kind: "active" },
  "references/adapters/package-surface-characterization.md": { kind: "active" },
  "references/adapters/runtime-lifecycle-adapters.yaml": { kind: "excluded", reason: "migration input/apply internals" },
  "references/adapters/runtime-lifecycle-authority.yaml": { kind: "excluded", reason: "migration input/apply internals" },
  "references/adapters/runtime-lifecycle-operation-contract.yaml": { kind: "excluded", reason: "migration input/apply internals" },
  "references/adapters/runtime-retired-resources.yaml": { kind: "excluded", reason: "migration input/apply internals" },
  "references/analysis/benchmark.md": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/analytics-boundary-proportional-2026-07-20/source-focused-1.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/analytics-boundary-proportional-2026-07-20/source-focused-2.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/analytics-boundary-proportional-2026-07-20/source-focused-3.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/migration-pagination-proportional-2026-07-20/source-focused-1.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/migration-pagination-proportional-2026-07-20/source-focused-2.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/migration-pagination-proportional-2026-07-20/source-focused-3.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/verification-baseline-2026-07-20/precommit-cli-route.log.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/verification-baseline-2026-07-20/precommit-cli.log.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/verification-baseline-2026-07-20/precommit-documentation.log.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/verification-baseline-2026-07-20/recompute.mjs": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/verification-baseline-2026-07-20/source-1.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/verification-baseline-2026-07-20/source-2.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence/verification-baseline-2026-07-20/source-3.json.gz": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/evidence-tier-authority.yaml": { kind: "active" },
  "references/analysis/startup-measurement-contract.yaml": { kind: "active" },
  "references/analysis/analytics-boundary-proportional-2026-07-20.yaml": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/migration-pagination-proportional-2026-07-20.yaml": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/verification-baseline-2026-07-20.yaml": { kind: "excluded", reason: "evaluator fixture" },
  "references/analysis/verification-policy.yaml": { kind: "active" },
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

const RETIRED_NATIVE_CLAIMS = [
  "runtime writes require an explicit selector",
  "Canonical active runtime names are OpenCode, Codex, Cursor, and GitHub Copilot",
  "managed runtime config, plugins, hooks, commands, and safe cleanup",
  "External package manager changes require `--update-packages`",
  "Compatibility selector for narrow app-file work",
  "Runtime-specific Agentera adapter support for skill loading, hooks, artifact validation",
  "Hooks that are shipped by active runtime plugin package surfaces",
  "worker execution through OpenCode, Codex CLI, Cursor IDE, Copilot CLI",
  "Diagnostic command surface for install/runtime health",
] as const;

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
  ["/identity/stable_id", "stable_id"], ["/identity/components/artifact_id", "artifact_id"], ["/identity/components/entry_number", "entry_number"], ["/identity/uniqueness", "stable_id"], ["/identity/ordering/list", "entry_number"], ["/identity/ordering/tie_breaker", "stable_id"], ["/identity/ordering/get", "stable_id"],
  ["/identity/legacy_rows/canonical_number", "entry_number"], ["/identity/legacy_rows/unaddressable", "stable_id"], ["/identity/legacy_rows/unaddressable", "entry_number"], ["/identity/legacy_rows/ambiguous", "stable_id"],
  ["/envelope/required_fields/1", "artifact_id"], ["/envelope/required_fields/2", "entry_number"], ["/envelope/field_contract/artifact_id", "artifact_id"], ["/envelope/field_contract/entry_number", "entry_number"], ["/envelope/identity_checks/0", "artifact_id"], ["/envelope/identity_checks/1", "entry_number"], ["/envelope/identity_checks/2", "entry_number"],
  ["/projections/summary/required_item_fields/0", "stable_id"], ["/projections/summary/required_item_fields/1", "artifact_id"], ["/projections/summary/required_item_fields/2", "entry_number"], ["/projections/summary/nullable_item_fields/0", "stable_id"], ["/projections/summary/nullable_item_fields/1", "entry_number"],
  ["/api/direct_get/command", "--number"], ["/api/direct_get/examples/progress", "--number"], ["/api/direct_get/examples/decisions", "--number"], ["/api/direct_get/examples/health", "--number"], ["/api/direct_get/required_selector", "--number"], ["/api/direct_get/result", "stable_id"],
  ["/api/list/response_fields/entry/0", "stable_id"], ["/api/list/response_fields/entry/1", "artifact_id"], ["/api/list/response_fields/entry/2", "entry_number"],
  ["/api/durability/command", "--number"], ["/api/durability/response_fields/entry/0", "stable_id"], ["/api/durability/response_fields/entry/1", "artifact_id"], ["/api/durability/response_fields/entry/2", "entry_number"],
  ["/failures/envelope/error_optional_fields/0", "artifact_id"], ["/failures/envelope/error_optional_fields/1", "entry_number"], ["/failures/envelope/error_optional_fields/2", "stable_id"],
];

const RUNTIME_EXACT: Array<[string, string, string]> = [];

const SOURCE_CONTEXT_HASHES: Record<string, string> = {
  "references/artifacts/state-storage-authority.yaml": "d5c386de575cbfb3cedc14338d78e8da876c61b3e4995e6315c95175aa7e39b5",
  "skills/agentera/schemas/artifacts/experiments.yaml": "d4785335dad4babfa3d19c1d995f1505df19605970d3863f4bed656101cfd0ce",
  "references/cli/prime-consumer-compatibility.yaml": "6501b072defa61a56b2fdb53fc1e67a9db8c27178c0b84e306122a16a5a3e9a8",
};

function pointerEscape(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }

function hash(value: string | Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

function semanticFindings(surface: string, value: unknown, pointer = "", parent: unknown = null): Finding[] {
  const findings: Finding[] = [];
  if (Array.isArray(value)) value.forEach((child, index) => findings.push(...semanticFindings(surface, child, `${pointer}/${index}`, value)));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPointer = `${pointer}/${pointerEscape(key)}`;
      const contextHash = hash(JSON.stringify(canonical({ value: key, parent: value })));
      for (const match of key.matchAll(RETIRED)) findings.push({ surface, pointer: childPointer, match: match[0], excerpt: key, contextHash });
      findings.push(...semanticFindings(surface, child, childPointer, value));
    }
  } else if (typeof value === "string") {
    const contextHash = hash(JSON.stringify(canonical({ value, parent })));
    for (const match of value.matchAll(RETIRED)) findings.push({ surface, pointer: pointer || "/", match: match[0], excerpt: value, contextHash });
  }
  return findings;
}

function textFindings(surface: string, text: string): Finding[] {
  let section = "preamble";
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line); if (heading) section = heading[2].trim();
    const excerpt = line.trim();
    const contextHash = hash(JSON.stringify({ section, line: excerpt }));
    for (const match of line.matchAll(RETIRED)) findings.push({ surface, pointer: `section=${section};line=${index + 1}`, match: match[0], excerpt, contextHash });
  });
  return findings;
}

function fileFindings(relative: string): Finding[] {
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  const text = bytes.toString("utf8");
  const findings = relative.endsWith(".yaml") || relative.endsWith(".yml")
    ? semanticFindings(relative, parseYaml(text))
    : relative.endsWith(".json") ? semanticFindings(relative, JSON.parse(text)) : textFindings(relative, text);
  return findings.map((finding) => ({ ...finding, contextHash: hash(bytes) }));
}

function exactExceptions(runtime: any): Exception[] {
  expect(runtime.explain.stdout.guidance).toContain("a bare ten-letter ID is assigned by the CLI; do not pass an identity");
  expect(runtime.marker_absent_explain.stdout).toMatchObject({ artifact: "progress", command: "state progress explain" });
  const exceptions: Exception[] = [];
  const add = (surface: string, pointer: string, match: string, contextHash: string, reason: string): void => {
    exceptions.push({ surface, pointer, match, contextHash, reason });
  };

  for (const [pointer, match] of STATE_STORAGE_EXACT) {
    const negative = pointer.includes("/forbidden_");
    add("references/artifacts/state-storage-authority.yaml", pointer, match, SOURCE_CONTEXT_HASHES["references/artifacts/state-storage-authority.yaml"], negative ? "exact internal adapter prohibition semantics" : "exact internal adapter migration semantics");
  }
  for (const [pointer, match, contextHash] of RUNTIME_EXACT) add("runtime://public-structured-outputs", pointer, match, contextHash, pointer.includes("/guidance/") ? "exact legacy evidence writer guidance" : "exact migration input/apply runtime contract");
  for (const [pointer, match] of [["/PUBLICATION/4/required_fields/1", "stable_id"], ["/PUBLICATION/4/required_fields/2", "objective_id"], ["/PUBLICATION/4/required_fields/3", "experiment_number"], ["/PUBLICATION/4/provenance_fields/1", "objective_id"]] as Array<[string, string]>) {
    add("skills/agentera/schemas/artifacts/experiments.yaml", pointer, match, SOURCE_CONTEXT_HASHES["skills/agentera/schemas/artifacts/experiments.yaml"], "exact legacy experiment migration source envelope");
  }
  add("references/cli/prime-consumer-compatibility.yaml", "/plan", "plan:634c092e-a7bc-48f4-80ee-2c91940e54f1", SOURCE_CONTEXT_HASHES["references/cli/prime-consumer-compatibility.yaml"], "exact immutable plan evidence reference");
  return exceptions;
}

function identity(item: Pick<Finding | Exception, "surface" | "pointer" | "match">): string {
  return JSON.stringify([item.surface, item.pointer, item.match]);
}

function reconcile(findings: Finding[], exceptions: Exception[]): string[] {
  const errors: string[] = [];
  const findingGroups = Map.groupBy(findings, identity);
  const exceptionGroups = Map.groupBy(exceptions, identity);
  for (const [key, group] of findingGroups) if (group.length !== 1) errors.push(`duplicate finding ${key} x${group.length}`);
  for (const [key, group] of exceptionGroups) if (group.length !== 1) errors.push(`duplicate exception ${key} x${group.length}`);
  for (const finding of findings) {
    const candidates = exceptionGroups.get(identity(finding)) ?? [];
    if (candidates.length !== 1 || candidates[0].contextHash !== finding.contextHash) errors.push(`prohibited finding ${identity(finding)} context=${finding.contextHash}`);
  }
  for (const exception of exceptions) {
    const candidates = findingGroups.get(identity(exception)) ?? [];
    if (candidates.length !== 1 || candidates[0].contextHash !== exception.contextHash) errors.push(`unconsumed exception ${identity(exception)} context=${exception.contextHash}`);
  }
  return errors;
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

function expectMigrationOnlyLifecycleContracts(): void {
  const authority = parseYaml(fs.readFileSync(
    path.join(ROOT, "references/adapters/runtime-lifecycle-authority.yaml"),
    "utf8",
  )) as Record<string, unknown>;
  expect(authority.status).toBe("migration_only_authority");
  expect(authority.active_runtimes).toEqual([]);

  const adaptersPath = path.join(ROOT, "references/adapters/runtime-lifecycle-adapters.yaml");
  const adaptersText = fs.readFileSync(adaptersPath, "utf8");
  const adapters = parseYaml(adaptersText) as Record<string, unknown>;
  expect(adapters.status).toBe("migration_only_contract");
  expect(adapters.shared_resources).toEqual([]);
  expect(adapters.managed_resources).toEqual([]);
  expect(adapters.adapters).toEqual([]);
  for (const retiredSource of [
    ".opencode/plugins/agentera.js",
    ".opencode/agents/agentera.md",
    "hooks/codex-hooks.json",
    ".cursor/hooks.json",
    ".cursor/agents/agentera.md",
  ]) expect(adaptersText, retiredSource).not.toContain(retiredSource);
}

function copyOwnedPairs(): Array<[string, string]> {
  const surfaces = bundleSurfaces();
  const pairs: Array<[string, string]> = [];
  for (const file of surfaces.files) {
    if (fs.existsSync(path.join(ROOT, file.path))) {
      pairs.push([file.path, `packages/cli/bundle/${file.path}`]);
    }
  }
  for (const directory of surfaces.directories) {
    for (const source of files(directory.path).filter((file) => !file.split("/").some((part) => surfaces.skip_parts.includes(part)) && !surfaces.skip_suffixes.some((suffix: string) => file.endsWith(suffix)))) pairs.push([source, `packages/cli/bundle/${source}`]);
  }
  return pairs;
}

function bundleSurfaces(): any {
  const registry = parseYaml(fs.readFileSync(path.join(ROOT, "references/adapters/package-registry.yaml"), "utf8")) as any;
  return registry.records.find((entry: any) => entry.identity.id === "agentera").bundle_surfaces;
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
  it("emits only the retained doctor adjacency from the active contract", () => {
    const contract = parseYaml(fs.readFileSync(
      path.join(ROOT, "references/cli/agent-ready-state-contract.yaml"),
      "utf8",
    )) as { doctor: { adjacent_surfaces: Record<string, string> } };
    const adjacentSurfaces = {
      codebase_audit: "/agentera audit routes to inspektera",
    };

    expect(contract.doctor.adjacent_surfaces).toEqual(adjacentSurfaces);
    expect((buildSchemaPayload().doctor as Record<string, unknown>).adjacent_surfaces).toEqual(adjacentSurfaces);
  });

  it("classifies the complete registry-owned source inventory", () => {
    const pairs = copyOwnedPairs();
    const references = pairs.map(([source]) => source).filter((source) => source.startsWith("references/"));
    expect(references).toEqual(files("references"));
    expect(Object.keys(REFERENCE_CLASSIFICATIONS).sort()).toEqual(references);
    expect(() => classifyReference("references/cli/new-contract.yaml")).toThrow("unclassified copied reference");
    expect(classifyReference("references/cli/vocabulary.md")).toEqual({ kind: "active" });
    expect(classifyReference("references/cli/prime-consumer-compatibility.yaml")).toEqual({ kind: "active" });
    expectMigrationOnlyLifecycleContracts();
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST).toContain("README.md");
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST).toContain("packages/cli/README.md");
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST.filter((file) => file.endsWith("/instructions.ts"))).toHaveLength(CAPABILITY_NAMES.length);
    expect(ALWAYS_ACTIVE_SOURCE_MANIFEST.filter((file) => /skills\/agentera\/capabilities\/[^/]+\/schemas\/.+\.yaml$/.test(file))).toHaveLength(CAPABILITY_NAMES.length * 4);
    for (const source of references) expect(classifyReference(source)).toBeDefined();
    for (const [source] of pairs) {
      const classification = classifyCopiedSurface(source);
      expect(["active", "excluded"], source).toContain(classification.kind);
    }
    const generated = bundleSurfaces().generated_files as Array<{ path: string; format: string; classification: string }>;
    for (const output of generated) {
      expect(output.format, output.path).toBe("json");
      expect(output.classification, output.path).toBe("active");
    }
  });

  it("rejects retired public identity and selector vocabulary on source and runtime surfaces", () => {
    const activeCopiedSources = copyOwnedPairs().map(([source]) => source).filter((source) => classifyCopiedSurface(source).kind === "active");
    const activeSources = [...new Set([...ALWAYS_ACTIVE_SOURCE_MANIFEST.filter((file) => !file.endsWith("/instructions.ts")), ...activeCopiedSources])].sort();
    const findings = activeSources.flatMap(fileFindings);
    const runtime = {
      help: ["progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs"].map(printStateHelp),
      schema: buildSchemaPayload(),
      instructions: CAPABILITY_INSTRUCTIONS,
      explain: capture(["state", "progress", "explain", "--format", "json"]),
      marker_absent_explain: capture(["state", "progress", "explain", "--format", "json"], legacyProject),
      error: capture(["state", "plan", "get", "--id", "zzzzzzzzzz", "--format", "json"]),
      prime: capture(["prime", "--format", "json"]),
      contexts: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, capture(["prime", "--context", name, "--format", "json"])])),
    };
    findings.push(...semanticFindings("runtime://public-structured-outputs", runtime));
    const exceptions = exactExceptions(runtime);
    expect(reconcile(findings, exceptions)).toEqual([]);
  });

  it("keeps active protocol sources free of exact retired native-integration claims", () => {
    const activeCopiedSources = copyOwnedPairs().map(([source]) => source)
      .filter((source) => classifyCopiedSurface(source).kind === "active");
    const activeSources = [...new Set([...ALWAYS_ACTIVE_SOURCE_MANIFEST, ...activeCopiedSources])];
    for (const source of activeSources) {
      const content = fs.readFileSync(path.join(ROOT, source), "utf8");
      for (const claim of RETIRED_NATIVE_CLAIMS) {
        expect(content, `${source}: ${claim}`).not.toContain(claim);
      }
    }
  });
});

describe("retired finding reconciliation", () => {
  const finding: Finding = { surface: "source.yaml", pointer: "/command", match: "--number", excerpt: "command --number", contextHash: "context" };
  const exception: Exception = { surface: finding.surface, pointer: finding.pointer, match: finding.match, contextHash: finding.contextHash, reason: "migration apply" };

  it("consumes one exact finding with one exact exception", () => expect(reconcile([finding], [exception])).toEqual([]));
  it("rejects a duplicate exception", () => expect(reconcile([finding], [exception, exception]).some((error) => error.includes("duplicate exception"))).toBe(true));
  it("rejects a duplicated finding at the same pointer", () => expect(reconcile([finding, finding], [exception]).some((error) => error.includes("duplicate finding"))).toBe(true));
  it("rejects changed context retaining the token", () => expect(reconcile([{ ...finding, contextHash: "changed" }], [exception]).some((error) => error.includes("prohibited finding"))).toBe(true));
  it("rejects a moved pointer or heading", () => expect(reconcile([{ ...finding, pointer: "/moved" }], [exception]).some((error) => error.includes("prohibited finding"))).toBe(true));
  it("rejects an added occurrence", () => expect(reconcile([finding, { ...finding, pointer: "/added" }], [exception]).some((error) => error.includes("prohibited finding"))).toBe(true));
});
