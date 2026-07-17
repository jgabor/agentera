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
interface Exception { surface: string; pointer: string; match: string; reason: string }

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

const AUTHORITATIVE_SOURCE_MANIFEST = [
  "README.md",
  "packages/cli/README.md",
  "skills/agentera/SKILL.md",
  "skills/agentera/protocol.yaml",
  "registry.json",
  "references/artifacts/state-storage-authority.yaml",
  "references/cli/agent-ready-state-contract.yaml",
  "references/cli/capability-instruction-contract.yaml",
  "references/adapters/package-registry.yaml",
  ...files("packages/cli/src/capabilities", "instructions.ts"),
  ...files("skills/agentera/capabilities", ".yaml"),
  ...files("skills/agentera/schemas/artifacts", ".yaml"),
].sort();

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
  if (relative.endsWith("state-storage-authority.yaml")) {
    const value = parseYaml(text) as Record<string, unknown>;
    return [
      ...semanticFindings(relative, value.entity_target, "/entity_target"),
      ...semanticFindings(relative, value.entity_migration, "/entity_migration"),
      ...semanticFindings(relative, value.consumer_matrix, "/consumer_matrix"),
      ...semanticFindings(relative, (value.api as Record<string, unknown>)?.backfill, "/api/backfill"),
    ];
  }
  if (relative.endsWith(".yaml") || relative.endsWith(".yml")) return semanticFindings(relative, parseYaml(text));
  if (relative.endsWith(".json")) return semanticFindings(relative, JSON.parse(text));
  return textFindings(relative, text);
}

function exactExceptions(findings: Finding[], runtime: any): Exception[] {
  expect(runtime.explain.stdout.guidance).toContain("number is assigned by the CLI; do not pass --number");
  expect(runtime.legacy_explain.stdout).toMatchObject({ classification: "legacy_migration_evidence", recovery_only: true });
  return findings.flatMap((finding): Exception[] => {
    const negative = finding.pointer.startsWith("/entity_target/public_schema/forbidden_canonical_aliases/") || /\/entity_target\/entities\/\d+\/record\/forbidden_fields\//.test(finding.pointer) || finding.pointer.includes("/forbidden_fields/");
    const migration = finding.pointer.startsWith("/entity_migration/") || finding.pointer.startsWith("/schema/entity_migration/") || finding.pointer.startsWith("/schema/state_migration/");
    const backfill = finding.pointer.startsWith("/api/backfill/") || finding.pointer.startsWith("/schema/state_backfill/");
    const experimentSource = finding.pointer.startsWith("/PUBLICATION/4/") || /\/artifact_schemas\/\d+\/schema\/PUBLICATION\/4\//.test(finding.pointer);
    const canonicalNegativeGuidance = finding.surface === "runtime://public-structured-outputs" && finding.pointer === "/explain/stdout/guidance/0" && finding.match === "--number";
    const evidenceWriter = finding.surface === "runtime://public-structured-outputs" && finding.pointer === "/legacy_explain/stdout/guidance/0";
    const reason = negative || canonicalNegativeGuidance ? "exact negative prohibition" : migration ? "entity migration preview/apply source contract" : backfill ? "explicit Git backfill source contract" : experimentSource ? "exact legacy experiment migration source envelope" : evidenceWriter ? "explicit legacy_migration_evidence writer" : null;
    return reason ? [{ surface: finding.surface, pointer: finding.pointer, match: finding.match, reason }] : [];
  });
}

function allowed(finding: Finding, exceptions: Exception[]): boolean {
  return exceptions.some((exception) => exception.surface === finding.surface && exception.pointer === finding.pointer && exception.match === finding.match);
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
  it("declares every active source surface explicitly and keeps generated copies byte-equal", () => {
    expect(new Set(AUTHORITATIVE_SOURCE_MANIFEST).size).toBe(AUTHORITATIVE_SOURCE_MANIFEST.length);
    expect(AUTHORITATIVE_SOURCE_MANIFEST).toContain("README.md");
    expect(AUTHORITATIVE_SOURCE_MANIFEST).toContain("packages/cli/README.md");
    expect(AUTHORITATIVE_SOURCE_MANIFEST.filter((file) => file.endsWith("/instructions.ts"))).toHaveLength(CAPABILITY_NAMES.length);
    expect(AUTHORITATIVE_SOURCE_MANIFEST.filter((file) => /skills\/agentera\/capabilities\/[^/]+\/schemas\/.+\.yaml$/.test(file))).toHaveLength(CAPABILITY_NAMES.length * 4);
    for (const [source, generated] of copyOwnedPairs()) {
      expect(fs.readFileSync(path.join(ROOT, generated)), generated).toEqual(fs.readFileSync(path.join(ROOT, source)));
    }
  });

  it("rejects retired public identity and selector vocabulary on source, generated, and runtime surfaces", () => {
    const findings = AUTHORITATIVE_SOURCE_MANIFEST.filter((file) => !file.endsWith("/instructions.ts")).flatMap(fileFindings);
    const copied = new Map(copyOwnedPairs());
    for (const source of AUTHORITATIVE_SOURCE_MANIFEST) {
      const generated = copied.get(source);
      if (generated) findings.push(...fileFindings(generated));
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
    expect(unexpected.map(({ surface, pointer, match }) => ({ surface, pointer, match }))).toEqual([]);
    for (const exception of exceptions) {
      expect(findings.some((finding) => finding.surface === exception.surface && finding.pointer === exception.pointer && finding.match === exception.match), exception.reason).toBe(true);
    }
  });
});
