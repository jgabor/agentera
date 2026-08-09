import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";
import { describe, expect, inject, it } from "vitest";

import { runServedProfileFullWorkflow } from "../helpers/profileFullGlossaryWorkflow.js";
import {
  EXPECTED_PRODUCER_READINESS,
  runProducerReadinessWorkflow,
} from "../helpers/producerReadinessWorkflow.js";
import { ENTITY_LIST_RUNTIME_FAMILIES } from "../../src/state/entityListRuntimeRegistry.js";
import { projectEntityDevelopmentValue } from "../../src/core/developmentInvocation.js";
import { runtimeOperationSpecs } from "../../src/state/write/runtimeOperations.js";
import { shellCommandArgs } from "../helpers/shellCommand.js";
import { decodeListCursor, encodeListCursor } from "../../src/state/listCursor.js";
import { seedPrimeEvidenceProject } from "../helpers/primeEvidenceProject.js";
import {
  preCutoverBootstrapGuidanceViolations,
  registryBootstrapAuthorityInventory,
  registryBootstrapAuthorityParity,
  registryBundledAuthorityPaths,
  registryBundledAuthorityViolations,
  retiredStartupGuidanceViolations,
} from "../helpers/retiredStartupGuidance.js";

const fixture = inject("packageFixture");
const V2_PROJECT = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project");
const V2_APP_HOME = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-app-home");
const V2_RUNTIME = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-runtime-python");
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PLAN_ID = "plan:123e4567-e89b-42d3-a456-426614174000";
function run(command: string, args: string[], cwd: string, env = process.env, input?: string) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8", ...(input === undefined ? {} : { input }) });
}

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected action to reject");
}

function isolatedPackageEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  env.AGENTERA_HOME = path.join(fixture.packageRoot, "bundle");
  return env;
}

function publicListFamilies(): Array<{ key: string; commandTokens: readonly string[]; syntax: string; get: string; example: string; bareRead: "alias" | "correction" }> {
  const authority = YAML.parse(fs.readFileSync(path.join(CHECKOUT_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));
  const retrieval = authority.entity_target.public_retrieval;
  return ENTITY_LIST_RUNTIME_FAMILIES.map((runtime) => {
    const family = retrieval.list_help.families[runtime.key] as { command_tokens: string[]; example: string; bare_read: "alias" | "correction" };
    return {
      key: runtime.key,
      commandTokens: runtime.commandTokens,
      syntax: projectEntityDevelopmentValue(retrieval.commands[runtime.key].list, runtime.key, "list"),
      get: projectEntityDevelopmentValue(retrieval.commands[runtime.key].get, runtime.key, "get"),
      example: projectEntityDevelopmentValue(family.example, runtime.key, "example"),
      bareRead: family.bare_read,
    };
  });
}

function projectedListHelp(value: any): any {
  const projected = structuredClone(value);
  for (const runtime of ENTITY_LIST_RUNTIME_FAMILIES) {
    const source = value.families[runtime.key];
    const family = projected.families[runtime.key];
    family.example = projectEntityDevelopmentValue(source.example, runtime.key, "example");
    if (source.bare_recovery !== undefined) {
      family.bare_recovery = projectEntityDevelopmentValue(source.bare_recovery, runtime.key, "bareRecovery");
    }
  }
  return projected;
}

function seedPublicListExamples(project: string): void {
  const entities = path.join(project, ".agentera/entities");
  const planDirectory = path.join(entities, "plan/plan");
  const objectiveDirectory = path.join(entities, "objective/objective");
  const experimentDirectory = path.join(entities, "experiments/experiment");
  fs.mkdirSync(planDirectory, { recursive: true });
  fs.mkdirSync(objectiveDirectory, { recursive: true });
  fs.mkdirSync(experimentDirectory, { recursive: true });
  fs.writeFileSync(path.join(planDirectory, "abcdefghij.yaml"), YAML.stringify({
    id: "abcdefghij",
    artifact: "plan",
    record: {
      header: { level: "light", created: "2026-08-02", status: "open", title: "Executable retrieval examples" },
      what: "Exercise every authority-owned list example.",
      why: "Static corrections must execute against source and packaged runtimes.",
      scope: { included: ["retrieval examples"], excluded: ["mutations"] },
    },
  }));
  fs.writeFileSync(path.join(objectiveDirectory, "qjtrmnpvka.yaml"), YAML.stringify({
    id: "qjtrmnpvka",
    artifact: "objective",
    record: {
      header: { title: "Executable retrieval examples", status: "open", created: "2026-08-02" },
      objective: { description: "Exercise experiment retrieval", why: "The example requires an objective", measurement: "Command exits zero", constraints: [] },
      metric: { description: "exit status", direction: "minimize", unit: "failures" },
      baseline: { description: "zero failures" },
      gates: {},
      scope: { included: ["retrieval examples"], excluded: ["experiment publication"] },
    },
  }));
  fs.writeFileSync(path.join(experimentDirectory, "zzzzzzzzzz.yaml"), YAML.stringify({
    id: "zzzzzzzzzz",
    artifact: "experiments",
    record: {
      objective: "qjtrmnpvka",
      date: "2026-08-02 09:00",
      label: "documentation example",
      hypothesis: "Canonical examples execute",
      method: "Run the documented command",
      change: "None",
      metric: { primary_value: "0 failures", delta_vs_baseline: "0" },
      regression: "package verification",
      status: "baseline",
      conclusion: "Example remains executable",
      provenance: { command: "documentation-example", revision: "fixture" },
    },
  }));
}

function realisticTodoId(index: number): string {
  let value = index;
  return Array.from({ length: 10 }, () => {
    const character = String.fromCharCode(97 + value % 26);
    value = Math.floor(value / 26);
    return character;
  }).reverse().join("");
}

function seedRealisticTodos(project: string, count = 120): { orderedIds: string[]; criticalOpenIds: string[] } {
  const directory = path.join(project, ".agentera/entities/todo/todo_item");
  fs.mkdirSync(directory, { recursive: true });
  const rows: Record<"critical" | "normal" | "resolved", string[]> = { critical: [], normal: [], resolved: [] };
  const orders = { critical: 0, normal: 0, resolved: 0 };
  const criticalOpenIds: string[] = [];
  const criticalResolvedIds: string[] = [];
  const normalOpenIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = realisticTodoId(index);
    const resolved = index >= 100;
    const severity = index < 70 || resolved ? "critical" : "normal";
    const section = resolved ? "resolved" : severity;
    const status = resolved ? "resolved" : "open";
    const order = ++orders[section];
    const title = `Package retrieval item ${String(index + 1).padStart(3, "0")}: ${"retain every selected identity and exact recovery under realistic byte pressure; ".repeat(5).trim()}`;
    const description = `[fix:3.0.0] ${title}`;
    fs.writeFileSync(path.join(directory, `${id}.yaml`), YAML.stringify({
      id,
      artifact: "todo",
      record: {
        kind: "fix",
        target_version: "3.0.0",
        title,
        requirements: ["Preserve selected rows"],
        acceptance: ["Source and package agree"],
        release_blocker: false,
        severity,
        status,
        readiness: {
          capability: "build",
          reason: "Exercise the extracted package against realistic TODO state.",
          dependencies: [],
          blocked: null,
          gate: null,
          queue_rank: index + 1,
          order_reason: "Stable package fixture order.",
        },
        reconciliation: {
          schema_version: "agentera.todoReconciliation.v1",
          public: { present: true, description, severity, status, order },
        },
      },
    }));
    rows[section].push(`- [${resolved ? "x" : " "}] [id:${id}] ${description}`);
    if (resolved) criticalResolvedIds.push(id);
    else if (severity === "critical") criticalOpenIds.push(id);
    else normalOpenIds.push(id);
  }
  fs.writeFileSync(path.join(project, ".agentera/todo-reconciliation-activation.json"), `${JSON.stringify({ schema_version: "agentera.todoReconciliationActivation.v1", retained_legacy_rows: [] })}\n`);
  fs.writeFileSync(path.join(project, "TODO.md"), [
    "# TODO", "", "## ⇶ Critical", ...rows.critical, "", "## → Normal", ...rows.normal,
    "", "## ✓ Resolved", ...rows.resolved, "",
  ].join("\n"));
  return { orderedIds: [...criticalOpenIds, ...criticalResolvedIds, ...normalOpenIds], criticalOpenIds };
}

function seedUnsafeInactiveTodos(project: string, count = 161): string[] {
  const directory = path.join(project, ".agentera/entities/todo/todo_item");
  fs.mkdirSync(directory, { recursive: true });
  const rows = ["# TODO", "", "Unrelated package fixture note.", "", "## ⇶ Critical"];
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index === 2) rows.push("", "## Client-specific work");
    const id = realisticTodoId(index);
    const title = `PRIVATE_PACKAGED_STALE_TODO_${String(index).padStart(3, "0")}`;
    ids.push(id);
    fs.writeFileSync(path.join(directory, `${id}.yaml`), YAML.stringify({
      id,
      artifact: "todo",
      record: {
        kind: "task",
        target_version: "3.0.0",
        title,
        requirements: [],
        acceptance: [],
        release_blocker: false,
        severity: "critical",
        status: "open",
        ...(index === 0 ? {
          readiness: {
            capability: "build",
            reason: `${title} private readiness.`,
            dependencies: [],
            blocked: null,
            gate: null,
            queue_rank: 1,
            order_reason: "Exercise omitted unsafe status detail.",
          },
        } : {}),
      },
    }));
    rows.push(`${index % 2 ? "  " : ""}- [x] [task:3.0.0] ${title}`);
  }
  rows.push("", "Unrelated package fixture closing note.", "");
  fs.writeFileSync(path.join(project, "TODO.md"), rows.join("\n"));
  return ids;
}

function unsafeOwnerCorrectionInput(project: string, ids: readonly string[]): string {
  const sourceLines = fs.readFileSync(path.join(project, "TODO.md"), "utf8").split(/\r?\n/)
    .flatMap((line, index) => line.trimStart().startsWith("- [") ? [index + 1] : []);
  expect(sourceLines).toHaveLength(ids.length);
  return JSON.stringify({
    schema_version: "agentera.todoOwnerCorrection.v1",
    owners: ids.map((id, index) => ({ id, source_line: sourceLines[index] })),
  });
}

function seedCompetingOpenPlans(project: string, count: number): string[] {
  const planDirectory = path.join(project, ".agentera/entities/plan/plan");
  const taskDirectory = path.join(project, ".agentera/entities/plan/plan_task");
  fs.mkdirSync(planDirectory, { recursive: true });
  fs.mkdirSync(taskDirectory, { recursive: true });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = realisticTodoId(index);
    const taskId = realisticTodoId(10_000 + index);
    ids.push(id);
    fs.writeFileSync(path.join(planDirectory, `${id}.yaml`), YAML.stringify({
      id,
      artifact: "plan",
      record: {
        header: { level: "light", created: "2026-08-09", status: "open", title: `Competing package plan ${index}` },
        what: "Verify source and packed successor selection.",
        why: "Competing plans must remain explicit.",
        scope: { included: ["plan selection"], excluded: ["unrelated state"] },
      },
    }));
    fs.writeFileSync(path.join(taskDirectory, `${taskId}.yaml`), YAML.stringify({
      id: taskId,
      artifact: "plan",
      record: { plan: id, name: `Task ${index}`, status: "pending", depends_on: [], acceptance: [] },
    }));
  }
  return ids.sort();
}

function projectByteSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else result[path.relative(root, target)] = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    }
  };
  walk(root);
  return result;
}

interface ProgressPrimeObservation {
  json: unknown;
  status: unknown;
  text: string;
  publicationOrders: number[];
}

function sameMinuteProgressPrimeWorkflow(
  bin: string,
  root: string,
): ProgressPrimeObservation {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  const seedId = "aaaaaaaaaa";
  const seedWhat = "adversarial markerless lexical minimum";
  const seedDirectory = path.join(project, ".agentera/entities/progress/progress_cycle");
  fs.mkdirSync(seedDirectory, { recursive: true });
  fs.writeFileSync(path.join(seedDirectory, `${seedId}.yaml`), YAML.stringify({
    id: seedId,
    artifact: "progress",
    record: {
      timestamp: "2026-07-27 17:00",
      type: "fix",
      phase: "build",
      what: seedWhat,
      context: { intent: "prove publication order defeats opaque ID order" },
    },
  }));
  const env = isolatedPackageEnv({ HOME: home });
  const invoke = (args: string[], input?: string) => {
    const result = run(process.execPath, [bin, ...args], project, env, input);
    expect(result.status, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };
  const append = (what: string, flags: string[]) => {
    const caveat: Record<string, string> = {};
    const fields: Record<string, string> = { "--glossary-caveat-event": "event", "--glossary-caveat-reason": "reason", "--glossary-caveat-ownership-state": "ownership_state", "--glossary-caveat-id": "caveat_id", "--glossary-caveat-transition-id": "transition_id" };
    for (let index = 0; index < flags.length; index += 2) caveat[fields[flags[index]]] = flags[index + 1];
    return JSON.parse(invoke(["state", "progress", "append", "--input", "-", "--format", "json"], JSON.stringify({ timestamp: "2026-07-27 17:00", type: "fix", phase: "build", what, context: { intent: "verify source and package same-minute lifecycle parity" }, verified: "same-minute lifecycle publication verified", glossary_caveat: caveat })));
  };
  const current = append("current publication", [
    "--glossary-caveat-event", "current", "--glossary-caveat-reason", "inferred_equivalence",
    "--glossary-caveat-ownership-state", "review_required",
  ]);
  const successor = append("successor publication", [
    "--glossary-caveat-event", "current", "--glossary-caveat-reason", "authority_unavailable",
    "--glossary-caveat-ownership-state", "authority_unavailable",
  ]);
  const superseded = append("superseded publication", [
    "--glossary-caveat-event", "superseded", "--glossary-caveat-reason", "inferred_equivalence",
    "--glossary-caveat-ownership-state", "review_required",
    "--glossary-caveat-id", current.record.glossary_caveat.caveat_id,
    "--glossary-caveat-transition-id", successor.record.glossary_caveat.caveat_id,
  ]);
  const resolved = append("final resolved publication", [
    "--glossary-caveat-event", "resolved", "--glossary-caveat-reason", "authority_unavailable",
    "--glossary-caveat-ownership-state", "authority_unavailable",
    "--glossary-caveat-id", successor.record.glossary_caveat.caveat_id,
  ]);
  const publications = [current, successor, superseded, resolved];
  expect(publications.map((entry) => entry.record.publication_order)).toEqual([1, 2, 3, 4]);
  expect(superseded.record.glossary_caveat).toMatchObject({
    caveat_id: current.record.glossary_caveat.caveat_id,
    transition_id: successor.record.glossary_caveat.caveat_id,
  });
  expect(resolved.record.glossary_caveat).toMatchObject({
    caveat_id: successor.record.glossary_caveat.caveat_id,
    transition_id: null,
  });
  const listed = JSON.parse(invoke(["state", "progress", "list", "--format", "json"]));
  expect(listed.entries[0]).toMatchObject({ id: resolved.id, record: { what: "final resolved publication", publication_order: 4 } });
  expect(listed.entries.slice(0, 4).map((entry: any) => entry.id)).toEqual(publications.toReversed().map((entry) => entry.id));
  expect(listed.entries[4]).toMatchObject({ id: seedId, record: { what: seedWhat } });
  expect(listed.entries[4].record).not.toHaveProperty("publication_order");
  expect(listed.entries.map((entry: any) => entry.id).toSorted()[0]).toBe(seedId);
  expect(listed.entries[0].id).not.toBe(seedId);
  const idOnlyLatest = listed.entries.toSorted((left: any, right: any) =>
    right.record.timestamp.localeCompare(left.record.timestamp) || left.id.localeCompare(right.id));
  expect(idOnlyLatest[0]).toMatchObject({ id: seedId, record: { what: seedWhat } });
  const json = JSON.parse(invoke(["prime", "--format", "json"]));
  const status = JSON.parse(invoke(["prime", "--context", "status", "--format", "json"]));
  const text = invoke(["prime"]);
  expect(json.progress.latest).toMatchObject({ id: resolved.id, what: "final resolved publication" });
  expect(JSON.stringify(json.progress.latest)).not.toContain(seedWhat);
  expect(JSON.stringify(status.capability_context.context.status_context)).toContain("final resolved publication");
  expect(JSON.stringify(status.capability_context.context.status_context)).not.toContain(seedWhat);
  expect(text).toContain("final resolved publication");
  expect(text).not.toContain(seedWhat);
  expect(JSON.stringify(json.attention ?? [])).not.toContain("Glossary meaning review required");

  const replacements = new Map<string, string>([
    [current.id, "<cycle-current>"],
    [successor.id, "<cycle-successor>"],
    [superseded.id, "<cycle-superseded>"],
    [resolved.id, "<cycle-resolved>"],
    [current.record.glossary_caveat.caveat_id, "<caveat-current>"],
    [successor.record.glossary_caveat.caveat_id, "<caveat-successor>"],
  ]);
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") {
      let normalized = value;
      for (const [actual, replacement] of replacements) normalized = normalized.replaceAll(actual, replacement);
      return normalized;
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, normalize(item)]),
    );
    return value;
  };
  return {
    json: normalize(json),
    status: normalize(status),
    text: normalize(text) as string,
    publicationOrders: publications.map((entry) => entry.record.publication_order),
  };
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

type BundleSurfaces = {
  directories: Array<{ path: string }>;
  files: Array<{ path: string }>;
  generated_files: Array<{ path: string }>;
};

const NPM_METADATA_FILES = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);

function unclassifiedManifestPaths(files: Iterable<string>, surfaces: BundleSurfaces): string[] {
  const allowedBundleFiles = new Set([
    ...surfaces.files.map(({ path: ownedPath }) => `bundle/${ownedPath}`),
    ...surfaces.generated_files.map(({ path: ownedPath }) => `bundle/${ownedPath}`),
  ]);
  const allowedBundleDirectories = surfaces.directories
    .map(({ path: ownedPath }) => `bundle/${ownedPath}/`);
  return [...files].filter((file) => {
    if (NPM_METADATA_FILES.has(file) || file.startsWith("dist/")) return false;
    if (allowedBundleFiles.has(file)) return false;
    if (allowedBundleDirectories.some((prefix) => file.startsWith(prefix))) return false;
    return true;
  });
}

function currentDescriptorPaths(files: Iterable<string>): string[] {
  return [...files].filter((file) => file.startsWith("bundle/skills/agentera/agents/"));
}

function git(root: string, ...args: string[]): void {
  const result = run("git", args, root);
  if (result.status !== 0) throw new Error(result.stderr);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) hashes[relative] = `link:${fs.readlinkSync(absolute)}`;
      else hashes[relative] = sha256(fs.readFileSync(absolute));
    }
  };
  visit(root);
  return hashes;
}

function entityEnvelopes(project: string): Array<{ id: string; artifact: string; record: Record<string, unknown> }> {
  const root = path.join(project, ".agentera/entities");
  const envelopes: Array<{ id: string; artifact: string; record: Record<string, unknown> }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith(".yaml")) envelopes.push(YAML.parse(fs.readFileSync(absolute, "utf8")));
    }
  };
  visit(root);
  return envelopes.sort((a, b) => a.id.localeCompare(b.id));
}

describe("npm distribution boundary", () => {
  it("contains only regular, singly linked files and directories under packaged dist and bundle", () => {
    let files = 0;
    for (const surface of ["dist", "bundle"]) {
      const pending = [path.join(fixture.packageRoot, surface)];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const name of fs.readdirSync(directory)) {
          const candidate = path.join(directory, name);
          const stat = fs.lstatSync(candidate);
          expect(stat.isSymbolicLink(), candidate).toBe(false);
          if (stat.isDirectory()) pending.push(candidate);
          else {
            expect(stat.isFile(), candidate).toBe(true);
            expect(stat.nlink, candidate).toBe(1);
            files += 1;
          }
        }
      }
    }
    expect(files).toBeGreaterThan(0);
  });

  it("tests a packed and extracted installation built outside checkout outputs", () => {
    const constructedBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    expect(isContained(fixture.root, fixture.constructionRoot)).toBe(true);
    expect(isContained(fixture.root, fixture.packageRoot)).toBe(true);
    expect(isContained(fixture.constructionRoot, fixture.packageRoot)).toBe(false);
    expect(isContained(CHECKOUT_ROOT, fixture.constructionRoot)).toBe(false);
    expect(fs.realpathSync(constructedBin)).toBe(constructedBin);
    expect(isContained(CHECKOUT_ROOT, constructedBin)).toBe(false);
    expect(fs.realpathSync(path.join(fixture.packageRoot, "dist/bin/agentera.js")))
      .toMatch(`${path.sep}package${path.sep}dist${path.sep}bin${path.sep}agentera.js`);
  });

  it("loads portable publication from the installed package without a native dependency", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.packageRoot, "package.json"), "utf8"));
    expect(manifest.dependencies).not.toHaveProperty("fs-native-extensions");
    expect(fs.existsSync(path.join(fixture.packageRoot, "dist/state/visibleFileExchange.js"))).toBe(false);
    const publication = await import(pathToFileURL(path.join(fixture.packageRoot, "dist/state/entityPublicationContext.js")).href);
    expect(publication.FILE_REPLACEMENT_RECOVERY_VERSION).toBe("agentera.fileReplacementRecovery.v1");
  });

  it("rejects mutated installed-package guidance in the extracted module and before schema output", async () => {
    const authorityPath = path.join(fixture.packageRoot, "bundle/references/artifacts/state-storage-authority.yaml");
    const bundleRoot = path.join(fixture.packageRoot, "bundle");
    const { loadMutationGrammar } = await import(pathToFileURL(path.join(fixture.packageRoot, "dist/state/write/grammar.js")).href);
    const original = fs.readFileSync(authorityPath, "utf8");
    try {
      const example = "npx -y agentera@next state progress append --input progress.yaml --format json";
      const recoveryCommand = "npx -y agentera@next state progress explain --verb append --format json";
      const cases: Array<[string, string, string]> = [
        ["unknown command", "npx -y agentera@next destroy --yes", "npx -y agentera@next destroy --yes"],
        ["composed command", `${example} && printf x`, `${recoveryCommand} && printf x`],
        ["numeric redirect", `${example} 2>err`, `${recoveryCommand} 2>err`],
        ["substitution", "npx -y agentera@next state progress append --input $(printf x) --format json", `${recoveryCommand} $(printf x)`],
        ["wrong channel", example.replace("@next", "@latest"), recoveryCommand.replace("@next", "@latest")],
        ["malformed quote", 'npx -y agentera@next state progress append --input "progress.yaml --format json', `${recoveryCommand} "status`],
        ["extra sibling", `${example} npx -y agentera@next prime`, `${recoveryCommand} npx -y agentera@next prime`],
        ["force", `${example} --force`, `${recoveryCommand} --force`],
        ["garbage", `${example} garbage`, `${recoveryCommand} garbage`],
        ["quoted operator", `${example} "&&"`, `${recoveryCommand} "&&"`],
        ["adjacent prefix", `x${example}`, `x${recoveryCommand}`],
        ["adjacent suffix", `${example}oops`, `${recoveryCommand}oops`],
        ["continuation", `${example} ${"\\"}\n--force`, `${recoveryCommand} ${"\\"}\n--force`],
        ["invalid format", example.replace("--format json", "--format invalid"), recoveryCommand.replace("--format json", "--format invalid")],
        ["wrong operation family", example.replace("state progress", "state decisions"), recoveryCommand.replace("state progress", "state decisions")],
        ["duplicate flag", example.replace("--format json", "--format json --format json"), `${recoveryCommand} --format json`],
        ["omitted required value", example.replace("--input progress.yaml", "--input"), recoveryCommand.replace("--verb append", "--verb")],
        ["extra positional", example.replace("state progress append", "state progress append extra"), recoveryCommand.replace("state progress explain", "state progress explain extra")],
        ["option-like value", example.replace("--input progress.yaml", "--input --"), recoveryCommand.replace("--verb append", "--verb --")],
      ];
      for (const [label, badExample, badRecoveryCommand] of cases) {
        for (const field of ["recovery", "examples"] as const) {
          const authority = YAML.parse(original);
          const operation = authority.mutation_grammar.operations.find(
            (candidate: any) => candidate.artifact === "progress" && candidate.verb === "append",
          );
          operation[field] = field === "examples"
            ? [badExample]
            : operation.recovery.replace(recoveryCommand, badRecoveryCommand);
          fs.writeFileSync(authorityPath, YAML.stringify(authority));
          expect(thrownMessage(() => loadMutationGrammar(bundleRoot)), `${label}/${field}`)
            .toMatch(/invalid development command projection/);
          if (label === "unknown command" && field === "examples") {
            const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
            const result = run(process.execPath, [bin, "schema", "--format", "json"], fixture.root, isolatedPackageEnv());
            expect(result.status, `${label}/${field}`).not.toBe(0);
            expect(result.stdout).not.toContain(badExample);
            expect(`${result.stdout}\n${result.stderr}`).toContain("invalid development command projection");
          }
        }
      }

      const authoritative = YAML.parse(original);
      for (const sourceOperation of authoritative.mutation_grammar.operations) {
        for (const field of ["recovery", "examples"] as const) {
          const authority = structuredClone(authoritative);
          const operation = authority.mutation_grammar.operations.find(
            (candidate: any) => candidate.artifact === sourceOperation.artifact && candidate.verb === sourceOperation.verb,
          );
          if (field === "recovery") operation.recovery += " oops";
          else operation.examples[0] += " oops";
          fs.writeFileSync(authorityPath, YAML.stringify(authority));
          const output = thrownMessage(() => loadMutationGrammar(bundleRoot));
          expect(output, `${sourceOperation.artifact}.${sourceOperation.verb}.${field}`)
            .toMatch(/invalid development command projection/);
          expect(output).not.toContain(field === "recovery" ? operation.recovery.replace("npx -y agentera@next", "agentera") : operation.examples[0].replace("npx -y agentera@next", "agentera"));
        }
      }
      const invalidStatus = structuredClone(authoritative);
      const setStatus = invalidStatus.mutation_grammar.operations.find(
        (candidate: any) => candidate.artifact === "plan" && candidate.verb === "set-status",
      );
      setStatus.examples[0] = setStatus.examples[0].replace("--status complete", "--status retired");
      fs.writeFileSync(authorityPath, YAML.stringify(invalidStatus));
      const statusOutput = thrownMessage(() => loadMutationGrammar(bundleRoot));
      expect(statusOutput).toMatch(/invalid development command projection/);
      expect(statusOutput).not.toContain("agentera state plan set-status --id qjtrmnpvka --status retired");
    } finally {
      fs.writeFileSync(authorityPath, original);
      loadMutationGrammar(bundleRoot);
    }
  });

  it("rejects every installed-package retrieval projection owner in the extracted module and before schema output", async () => {
    const authorityPath = path.join(fixture.packageRoot, "bundle/references/artifacts/state-storage-authority.yaml");
    const bundleRoot = path.join(fixture.packageRoot, "bundle");
    const original = fs.readFileSync(authorityPath, "utf8");
    const authoritative = YAML.parse(original);
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const { loadStateRetrievalAuthority } = await import(pathToFileURL(path.join(fixture.packageRoot, "dist/state/retrievalAuthority.js")).href);
    const { entityListFamilies } = await import(pathToFileURL(path.join(fixture.packageRoot, "dist/state/entityRetrievalHelp.js")).href);
    try {
      for (const runtime of ENTITY_LIST_RUNTIME_FAMILIES) {
        const mutations: Array<[string, (authority: any) => void]> = [
          ["list", (authority) => { authority.entity_target.public_retrieval.commands[runtime.key].list += " oops"; }],
          ["get", (authority) => { authority.entity_target.public_retrieval.commands[runtime.key].get += " oops"; }],
          ["example", (authority) => { authority.entity_target.public_retrieval.list_help.families[runtime.key].example += " oops"; }],
        ];
        if (runtime.projection.bareRecovery) {
          mutations.push(["bareRecovery", (authority) => { authority.entity_target.public_retrieval.list_help.families[runtime.key].bare_recovery += " oops"; }]);
        }
        for (const [field, mutate] of mutations) {
          const authority = structuredClone(authoritative);
          mutate(authority);
          fs.writeFileSync(authorityPath, YAML.stringify(authority));
          const load = field === "list" || field === "get" ? loadStateRetrievalAuthority : entityListFamilies;
          expect(() => load(bundleRoot), `${runtime.key}.${field}`)
            .toThrow(/invalid (?:state retrieval|entity list help) authority/);
          if (runtime.key === "todo" && (field === "list" || field === "example")) {
            const result = run(process.execPath, [bin, "schema", "--format", "json"], fixture.root, isolatedPackageEnv());
            expect(result.status, `${runtime.key}.${field}`).not.toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toMatch(/invalid (?:state retrieval|entity list help) authority/);
          }
        }
      }
    } finally {
      fs.writeFileSync(authorityPath, original);
      loadStateRetrievalAuthority(bundleRoot);
      entityListFamilies(bundleRoot);
    }
  });

  it("rejects every installed-package glossary projection owner before runtime output", () => {
    const authorityPath = path.join(fixture.packageRoot, "bundle/references/artifacts/glossary-entry-contract.yaml");
    const original = fs.readFileSync(authorityPath, "utf8");
    const authoritative = YAML.parse(original);
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const mutations: Array<[string, (authority: any) => void, string[], string | undefined]> = [
      ["profile_output.command", (authority) => { authority.ownership_contracts.personal.profile_output.command.canonical += " --force"; }, ["schema", "--format", "json"], undefined],
      ["profile_grounding.command", (authority) => { authority.consumer_boundary.profile_grounding.command += " garbage"; }, ["report", "profile-grounding", "--format", "json"], undefined],
      ["profile_grounding.repair", (authority) => { authority.consumer_boundary.profile_grounding.recovery.repair = authority.consumer_boundary.profile_grounding.recovery.repair.replace("--format json", "--format invalid"); }, ["report", "profile-grounding", "--format", "json"], undefined],
      ["profile_grounding.absent", (authority) => { authority.consumer_boundary.profile_grounding.recovery.absent = `x${authority.consumer_boundary.profile_grounding.recovery.absent}`; }, ["report", "profile-grounding", "--format", "json"], undefined],
      ["advice.command", (authority) => { authority.consumer_boundary.advice_resolution.invocation.command = "npx -y agentera@latest report glossary-advice --input REQUEST --format json"; }, ["report", "glossary-advice", "--input", "-", "--format", "json"], JSON.stringify({ schema_version: "agentera.glossaryAdviceRequest.v1", requested_term: "test", host_review: null })],
    ];
    try {
      for (const [owner, mutate, args, input] of mutations) {
        const authority = structuredClone(authoritative);
        mutate(authority);
        fs.writeFileSync(authorityPath, YAML.stringify(authority));
        const result = run(process.execPath, [bin, ...args], fixture.root, isolatedPackageEnv(), input);
        expect(result.status, owner).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("invalid development command projection");
      }
    } finally {
      fs.writeFileSync(authorityPath, original);
    }
  });

  it("serves every approved mutation template and preserves quoted values from the installed package", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const schema = run(process.execPath, [bin, "schema", "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(schema.status, schema.stderr).toBe(0);
    const artifacts = JSON.parse(schema.stdout).state_writer.artifacts as Array<{ artifact: string; operations: Array<{ verb: string; recovery: string; examples: string[]; fields: Array<{ flag: string; valid_values?: string[] }> }> }>;
    const operations = artifacts.flatMap((artifact) => artifact.operations.map((operation) => ({ artifact: artifact.artifact, ...operation })));
    expect(operations).toHaveLength(29);
    for (const runtime of runtimeOperationSpecs()) {
      const operation = operations.find((candidate) => candidate.artifact === runtime.artifact && candidate.verb === runtime.verb)!;
      expect(operation.recovery).toBe(runtime.projection.recovery.runtime);
      expect(operation.examples).toEqual(runtime.projection.examples.map(({ runtime: value }) => value));
      for (const field of runtime.fields.filter(({ validValues }) => validValues)) {
        expect(operation.fields.find((candidate) => candidate.flag === field.flag)?.valid_values).toEqual(field.validValues);
      }
    }
    expect(operations.find(({ artifact, verb }) => artifact === "decisions" && verb === "update")?.examples[0])
      .toContain('--satisfaction-evidence "..." --format json');
    expect(operations.find(({ artifact, verb }) => artifact === "plan" && verb === "set-status")?.examples[0])
      .toContain("--status complete --format json");

    const project = fs.mkdtempSync(path.join(fixture.root, "approved-mutation-"));
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const input = path.join(project, "progress.yaml");
    fs.writeFileSync(input, YAML.stringify({
      type: "fix",
      phase: "build",
      what: "Prove installed-package approved mutation parsing.",
      context: { intent: "Exercise the exact json-format control." },
    }));
    const accepted = run(process.execPath, [bin, "state", "progress", "append", "--input", input, "--dry-run", "--format", "json", "--project", project], project, isolatedPackageEnv());
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ status: "pass" });
    expect(fs.existsSync(path.join(project, ".agentera/entities/progress"))).toBe(false);

    const validEnum = run(process.execPath, [bin, "state", "plan", "set-status", "--id", "qjtrmnpvka", "--status", "complete", "--format", "json", "--project", project], project, isolatedPackageEnv());
    expect(validEnum.status).not.toBe(0);
    expect(JSON.parse(validEnum.stdout).error.class).not.toBe("invalid_choice");
    const invalidEnum = run(process.execPath, [bin, "state", "plan", "set-status", "--id", "qjtrmnpvka", "--status", "retired", "--format", "json", "--project", project], project, isolatedPackageEnv());
    expect(JSON.parse(invalidEnum.stdout).error.class).toBe("invalid_choice");
    const invalidFormat = run(process.execPath, [bin, "state", "progress", "append", "--input", input, "--format", "invalid", "--project", project], project, isolatedPackageEnv());
    expect(invalidFormat.status).not.toBe(0);
    expect(`${invalidFormat.stdout}\n${invalidFormat.stderr}`).toContain("invalid choice: 'invalid'");
  });

  it("normalizes only valid atomic-create dependency ordinal forms in the installed package", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const bundledSchemaPath = path.join(fixture.packageRoot, "bundle/skills/agentera/schemas/artifacts/plan.yaml");
    const sourceSchemaPath = path.join(CHECKOUT_ROOT, "skills/agentera/schemas/artifacts/plan.yaml");
    expect(fs.readFileSync(bundledSchemaPath)).toEqual(fs.readFileSync(sourceSchemaPath));
    const dependencyField = YAML.parse(fs.readFileSync(bundledSchemaPath, "utf8")).TASK[3];
    expect(dependencyField).toMatchObject({
      type: "list[integer|string]",
      accepted_forms: {
        atomic_plan_create: ["positive_integer", "canonical_numeric_string"],
        legacy_migration_only: ["legacy_task_reference_string"],
      },
    });
    const expectedDiscovery = {
      id: "PT17",
      group: "TASK",
      field: "depends_on",
      path: "tasks[].depends_on",
      type: "list[integer|string]",
      required: false,
      format: null,
      validation: [
        "positive_integer_or_canonical_numeric_string",
        "unique_after_normalization_within_task",
        "resolves_to_declared_task_ordinal_in_same_atomic_document",
      ],
      accepted_forms: {
        atomic_plan_create: ["positive_integer", "canonical_numeric_string"],
        legacy_migration_only: ["legacy_task_reference_string"],
      },
      normalization: "canonical_numeric_string_before_same_document_resolution",
      write_operations: ["create"],
    };
    for (const format of ["json", "yaml"] as const) {
      const schemaResult = run(process.execPath, [bin, "schema", "--format", format], fixture.root, isolatedPackageEnv());
      expect(schemaResult.status, schemaResult.stderr).toBe(0);
      const schemaPayload = format === "json" ? JSON.parse(schemaResult.stdout) : YAML.parse(schemaResult.stdout);
      const planSchema = schemaPayload.artifact_schemas.find((artifact: any) => artifact.name === "plan");
      expect(planSchema.fields.find((field: any) => field.id === "PT17")).toEqual(expectedDiscovery);
    }
    const explainResult = run(process.execPath, [bin, "state", "plan", "explain", "--verb", "create", "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(explainResult.status, explainResult.stderr).toBe(0);
    expect(JSON.parse(explainResult.stdout).input_schema.artifact_schema_fields).toEqual([expectedDiscovery]);
    expect(Buffer.byteLength(explainResult.stdout, "utf8")).toBeLessThan(32_768);
    const planInput = (title: string, dependsOn: unknown[]) => JSON.stringify({
      header: { level: "light", created: "2026-07-31", status: "open", title },
      what: "Verify installed atomic plan creation.",
      why: "The package must match source ordinal behavior.",
      scope: { included: ["plan create"], excluded: ["migration"] },
      tasks: [
        { number: 1, name: "First", status: "pending", depends_on: [], acceptance: ["First is canonical"] },
        { number: 2, name: "Second", status: "pending", depends_on: dependsOn, acceptance: ["Second references First"] },
      ],
    });
    const makeProject = (name: string) => {
      const project = path.join(fixture.root, `plan-create-${name}`);
      fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
      fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
      return project;
    };
    const validProjects: string[] = [];
    for (const [name, dependsOn] of [["integer", [1]], ["numeric-string", ["1"]]] as const) {
      const project = makeProject(name);
      validProjects.push(project);
      const result = run(process.execPath, [bin, "state", "plan", "create", "--input", "-", "--format", "json"], project, isolatedPackageEnv(), planInput(name, [...dependsOn]));
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const created = JSON.parse(result.stdout);
      expect(created.tasks[1].record.depends_on).toEqual([created.tasks[0].id]);
      expect(created.tasks.every((task: any) => /^[a-z]{10}$/.test(task.id) && task.record.number === undefined)).toBe(true);
      expect(entityEnvelopes(project).every((entity) => entity.record.number === undefined)).toBe(true);
    }
    for (const [name, dependsOn] of [
      ["zero", [0]], ["negative", [-1]], ["fractional", [1.5]], ["nonnumeric", ["one"]],
      ["noncanonical", ["01"]], ["missing", [3]], ["duplicate", [1, "1"]], ["mixed-unresolved", [1, "3"]],
    ] as Array<[string, unknown[]]>) {
      const project = makeProject(`invalid-${name}`);
      const result = run(process.execPath, [bin, "state", "plan", "create", "--input", "-", "--format", "json"], project, isolatedPackageEnv(), planInput(name, dependsOn));
      expect(result.status, `${name} unexpectedly passed: ${result.stdout}`).not.toBe(0);
      expect(JSON.parse(result.stdout).error.class).toBe("schema_violation");
      expect(fs.readdirSync(path.join(project, ".agentera"))).toEqual(["state-mode.yaml"]);
    }
    const project = validProjects[0];
    const entities = entityEnvelopes(project);
    const planEntity = entities.find((entity) => !entity.record.plan)!;
    const task = entities.find((entity) => entity.record.plan === planEntity.id)!;
    for (const [verb, args, input] of [
      ["append", ["--plan", planEntity.id], { name: "Integer alias", depends_on: [1], acceptance: [] }],
      ["update", ["--plan", planEntity.id, "--id", task.id], { depends_on: [1] }],
    ] as const) {
      const result = run(process.execPath, [bin, "state", "plan", verb, ...args, "--input", "-", "--format", "json"], project, isolatedPackageEnv(), JSON.stringify(input));
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stdout).error.class).toBe("schema_violation");
    }
    expect(entityEnvelopes(project)).toEqual(entities);
  });

  it("constructs one self-contained CLI and shared-skill package inventory", () => {
    const files = new Set(fixture.manifest.files.map((entry) => entry.path));
    for (const required of [
      "dist/bin/agentera.js",
      "bundle/.agentera-npx-bundle.json",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      "bundle/references/artifacts/state-storage-authority.yaml",
    ]) {
      expect(files.has(required), required).toBe(true);
    }
    expect([...files].some((file) => file.startsWith("src/"))).toBe(false);
    expect(currentDescriptorPaths(files)).toEqual([]);
    for (const retired of [
      "dist/registries/runtimeAdapterRegistry.js",
      "dist/registries/runtimeAdapterRegistry.js.map",
    ]) {
      expect(files.has(retired), retired).toBe(false);
      expect(fs.existsSync(path.join(fixture.packageRoot, retired)), retired).toBe(false);
    }

    const authority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/package-registry.yaml"),
      "utf8",
    )) as any;
    const surfaces = authority.records.find((record: any) => record.identity.id === "agentera")
      .bundle_surfaces as BundleSurfaces;
    expect(
      unclassifiedManifestPaths(files, surfaces),
      "package boundary found manifest paths outside npm metadata, compiled CLI, or bundle authority",
    )
      .toEqual([]);

    for (const relative of [
      "skills/agentera/SKILL.md",
      "references/adapters/runtime-lifecycle-authority.yaml",
      "references/adapters/runtime-lifecycle-adapters.yaml",
      "references/adapters/runtime-lifecycle-operation-contract.yaml",
      "references/adapters/runtime-retired-resources.yaml",
    ]) {
      expect(
        fs.readFileSync(path.join(fixture.packageRoot, "bundle", relative)),
        `package boundary bundled ${relative} from a source other than its declared repository surface`,
      ).toEqual(fs.readFileSync(path.join(CHECKOUT_ROOT, relative)));
    }
    const runtimeAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-lifecycle-adapters.yaml"),
      "utf8",
    ));
    expect(runtimeAuthority).toMatchObject({
      status: "migration_only_contract",
      native_policy: { execution: "forbidden" },
      shared_resources: [],
      managed_resources: [],
      adapters: [],
    });
    const lifecycleAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-lifecycle-authority.yaml"),
      "utf8",
    ));
    expect(lifecycleAuthority).toMatchObject({
      status: "migration_only_authority",
      active_runtimes: [],
    });
    const operationAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-lifecycle-operation-contract.yaml"),
      "utf8",
    ));
    expect(operationAuthority).toMatchObject({
      status: "migration_only_contract",
      native_policy: { install_update_auth_trust_operations: "forbidden" },
    });
    const cleanupAuthority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/runtime-retired-resources.yaml"),
      "utf8",
    ));
    expect(cleanupAuthority).toMatchObject({
      status: "resource_retirement_contract",
      policy: {
        selection: "native_agentera_resource_only",
        preview: "strictly_read_only",
        apply_requires: "explicit_approval",
        ownership: "matching_whole_resource_ledger_identity_and_fingerprint",
      },
    });
    for (const staleReference of [
      "runtime-adapter-characterization.md",
      "runtime-adapter-interface-model.yaml",
      "runtime-adapter-registry.yaml",
      "runtime-feature-parity.md",
      "opencode.md",
      "cursor.md",
    ]) {
      expect(
        files.has(`bundle/references/adapters/${staleReference}`),
        staleReference,
      ).toBe(false);
    }
    expect([...files].some((file) => file.startsWith("test/") || file.includes("upgrade/fixtures/")))
      .toBe(false);
  });

  it("executes source-built and self-contained packaged list help, examples, rejections, and corrections for every authority family", () => {
    const sourceBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const packagedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const project = fs.mkdtempSync(path.join(fixture.root, "retrieval-help-parity-"));
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    seedPublicListExamples(project);
    try {
      const families = publicListFamilies();
      const bundledAuthority = YAML.parse(fs.readFileSync(path.join(fixture.packageRoot, "bundle/references/artifacts/state-storage-authority.yaml"), "utf8"));
      expect(Object.keys(bundledAuthority.entity_target.public_retrieval.list_help.families).sort()).toEqual(ENTITY_LIST_RUNTIME_FAMILIES.map(({ key }) => key).sort());
      const sourceSchema = run(process.execPath, [sourceBin, "schema", "--format", "json"], project, isolatedPackageEnv());
      const packagedSchema = run(process.execPath, [packagedBin, "schema", "--format", "json"], project, isolatedPackageEnv());
      expect(sourceSchema.status).toBe(0);
      expect(packagedSchema.status).toBe(0);
      expect(JSON.parse(packagedSchema.stdout).state_retrieval).toEqual(JSON.parse(sourceSchema.stdout).state_retrieval);
      expect(JSON.parse(packagedSchema.stdout).state_retrieval.list_help).toEqual(projectedListHelp(bundledAuthority.entity_target.public_retrieval.list_help));
      for (const family of families) {
        const helpArgs = ["state", ...family.commandTokens, "list", "--help"];
        const sourceHelp = run(process.execPath, [sourceBin, ...helpArgs], project, isolatedPackageEnv());
        const packagedHelp = run(process.execPath, [packagedBin, ...helpArgs], project, isolatedPackageEnv());
        expect(sourceHelp.status, sourceHelp.stderr).toBe(0);
        expect(packagedHelp.status, packagedHelp.stderr).toBe(0);
        expect(packagedHelp.stdout).toBe(sourceHelp.stdout);
        expect(sourceHelp.stdout).toContain(`usage: ${family.syntax}`);
        if (family.key === "todo") {
          expect(sourceHelp.stdout).toContain("queue_rank");
          expect(sourceHelp.stdout).toContain("--queue-rank is not a filter");
        }

        const exampleArgs = family.example.split(" ").slice(1);
        const sourceExample = run(process.execPath, [sourceBin, ...exampleArgs], project, isolatedPackageEnv());
        const packagedExample = run(process.execPath, [packagedBin, ...exampleArgs], project, isolatedPackageEnv());
        expect(sourceExample.status, `${family.key} source example failed:\n${sourceExample.stdout}\n${sourceExample.stderr}`).toBe(0);
        expect(packagedExample.status, `${family.key} package example failed:\n${packagedExample.stdout}\n${packagedExample.stderr}`).toBe(0);
        expect(packagedExample.stderr).toBe(sourceExample.stderr);
        expect(packagedExample.stdout).toBe(sourceExample.stdout);

        const mismatchArgs = ["state", ...family.commandTokens, "list", "--not-a-selector", "--format", "json"];
        const sourceMismatch = run(process.execPath, [sourceBin, ...mismatchArgs], project, isolatedPackageEnv());
        const packagedMismatch = run(process.execPath, [packagedBin, ...mismatchArgs], project, isolatedPackageEnv());
        expect(sourceMismatch.status).toBe(2);
        expect(packagedMismatch.status).toBe(2);
        expect(sourceMismatch.stderr).toBe("");
        expect(packagedMismatch.stderr).toBe("");
        expect(packagedMismatch.stdout).toBe(sourceMismatch.stdout);
        const correction = JSON.parse(sourceMismatch.stdout).error;
        expect(correction).toMatchObject({ syntax: family.syntax, example: family.example });
        const correctionArgs = correction.example.split(" ").slice(1);
        const sourceCorrection = run(process.execPath, [sourceBin, ...correctionArgs], project, isolatedPackageEnv());
        const packagedCorrection = run(process.execPath, [packagedBin, ...correctionArgs], project, isolatedPackageEnv());
        expect(sourceCorrection.status, `${family.key} source correction failed:\n${sourceCorrection.stdout}\n${sourceCorrection.stderr}`).toBe(0);
        expect(packagedCorrection.status, `${family.key} package correction failed:\n${packagedCorrection.stdout}\n${packagedCorrection.stderr}`).toBe(0);
        expect(packagedCorrection.stderr).toBe(sourceCorrection.stderr);
        expect(packagedCorrection.stdout).toBe(sourceCorrection.stdout);

        const humanArgs = ["state", ...family.commandTokens, "list", "--not-a-selector"];
        const sourceHuman = run(process.execPath, [sourceBin, ...humanArgs], project, isolatedPackageEnv());
        const packagedHuman = run(process.execPath, [packagedBin, ...humanArgs], project, isolatedPackageEnv());
        expect(sourceHuman.status).toBe(2);
        expect(packagedHuman.status).toBe(2);
        expect(sourceHuman.stdout).toBe("");
        expect(packagedHuman.stdout).toBe("");
        expect(packagedHuman.stderr).toBe(sourceHuman.stderr);
        expect(sourceHuman.stderr).toContain(`Example: ${family.example}`);
        for (const value of correction.valid_values) expect(sourceHuman.stderr).toContain(value);

        const getHelpArgs = ["state", ...family.commandTokens, "get", "--help"];
        const sourceGetHelp = run(process.execPath, [sourceBin, ...getHelpArgs], project, isolatedPackageEnv());
        const packagedGetHelp = run(process.execPath, [packagedBin, ...getHelpArgs], project, isolatedPackageEnv());
        expect(packagedGetHelp.status).toBe(0);
        expect(packagedGetHelp.stdout).toBe(sourceGetHelp.stdout);
        expect(sourceGetHelp.stdout).toContain(`usage: ${family.get}`);

        const rejectedGetArgs = ["state", ...family.commandTokens, "get", "extra", "--format", "json"];
        const sourceRejectedGet = run(process.execPath, [sourceBin, ...rejectedGetArgs], project, isolatedPackageEnv());
        const packagedRejectedGet = run(process.execPath, [packagedBin, ...rejectedGetArgs], project, isolatedPackageEnv());
        expect(sourceRejectedGet.status).toBe(2);
        expect(packagedRejectedGet.stdout).toBe(sourceRejectedGet.stdout);
        expect(JSON.parse(sourceRejectedGet.stdout).error).toMatchObject({ class: "invalid_request", syntax: family.get });

        const bareArgs = ["state", ...family.commandTokens, "--format", "json"];
        const sourceBare = run(process.execPath, [sourceBin, ...bareArgs], project, isolatedPackageEnv());
        const packagedBare = run(process.execPath, [packagedBin, ...bareArgs], project, isolatedPackageEnv());
        expect(packagedBare.status).toBe(sourceBare.status);
        expect(packagedBare.stdout).toBe(sourceBare.stdout);
        if (family.bareRead === "alias") {
          const explicitArgs = ["state", ...family.commandTokens, "list", "--format", "json"];
          const sourceExplicit = run(process.execPath, [sourceBin, ...explicitArgs], project, isolatedPackageEnv());
          expect(sourceBare.stdout).toBe(sourceExplicit.stdout);
          const malformedBareArgs = ["state", ...family.commandTokens, "extra", "--format", "json"];
          const malformedListArgs = ["state", ...family.commandTokens, "list", "extra", "--format", "json"];
          const sourceMalformedBare = run(process.execPath, [sourceBin, ...malformedBareArgs], project, isolatedPackageEnv());
          const sourceMalformedList = run(process.execPath, [sourceBin, ...malformedListArgs], project, isolatedPackageEnv());
          const packagedMalformedBare = run(process.execPath, [packagedBin, ...malformedBareArgs], project, isolatedPackageEnv());
          expect(sourceMalformedBare.status).toBe(2);
          expect(sourceMalformedBare.stdout).toBe(sourceMalformedList.stdout);
          expect(packagedMalformedBare.stdout).toBe(sourceMalformedBare.stdout);
          const writer = run(process.execPath, [packagedBin, "state", ...family.commandTokens, "explain", "--format", "json"], project, isolatedPackageEnv());
          expect(writer.status, writer.stderr).toBe(0);
          expect(JSON.parse(writer.stdout)).toMatchObject({ schemaVersion: "agentera.stateWriteExplain.v1", artifact: family.key });
        } else {
          expect(sourceBare.status).toBe(2);
          const bareCorrection = JSON.parse(sourceBare.stdout).error.example.split(" ").slice(1);
          expect(run(process.execPath, [sourceBin, ...bareCorrection], project, isolatedPackageEnv()).status).toBe(0);
          expect(run(process.execPath, [packagedBin, ...bareCorrection], project, isolatedPackageEnv()).status).toBe(0);
        }
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("preserves realistic 100-row TODO cardinality and degradation in source and the extracted package without mutation", () => {
    const sourceBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const packagedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const project = fs.mkdtempSync(path.join(fixture.root, "todo-cardinality-"));
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const { orderedIds, criticalOpenIds } = seedRealisticTodos(project);
    const before = projectByteSnapshot(project);
    const env = isolatedPackageEnv();
    const invoke = (bin: string, args: string[]) => run(process.execPath, [bin, ...args], project, env);
    const parity = (args: string[], status = 0) => {
      const source = invoke(sourceBin, args);
      const packaged = invoke(packagedBin, args);
      expect(source.status, source.stderr || source.stdout).toBe(status);
      expect(packaged.status, packaged.stderr || packaged.stdout).toBe(status);
      expect(packaged.stderr).toBe(source.stderr);
      expect(packaged.stdout).toBe(source.stdout);
      return JSON.parse(source.stdout);
    };
    const packageOnly = (args: string[], status = 0) => {
      const packaged = invoke(packagedBin, args);
      expect(packaged.status, packaged.stderr || packaged.stdout).toBe(status);
      return JSON.parse(packaged.stdout);
    };

    for (const limit of [40, 60, 100]) {
      const result = parity(["state", "todo", "list", "--ids-only", "--limit", String(limit), "--format", "json"]);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32_768);
      expect(result).toMatchObject({ counts: { candidate: 120, returned: limit, omitted: 120 - limit, continuation: 120 - limit } });
      expect(result.entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(0, limit));
      expect(result.entries.every((entry: any) => Object.keys(entry).sort().join(",") === "artifact,id,queue_rank,retrieval")).toBe(true);
    }

    const cursorFirst = parity(["state", "todo", "list", "--ids-only", "--limit", "40", "--format", "json"]);
    const authorityPath = path.join(CHECKOUT_ROOT, "references/artifacts/state-storage-authority.yaml");
    const cursorPayload = decodeListCursor(cursorFirst.next_cursor, project, authorityPath);
    expect(cursorPayload.limit).toBe(40);

    const changedLimit = packageOnly(["state", "todo", "list", "--ids-only", "--limit", "5", "--cursor", cursorFirst.next_cursor, "--format", "json"], 1);
    expect(changedLimit.error).toMatchObject({
      class: "cursor_invalid",
      message: "todo cursor is bound to --limit 40, not --limit 5",
      recovery: "agentera state todo list --ids-only --limit 5 --format json",
    });
    expect(packageOnly(shellCommandArgs(changedLimit.error.recovery)).entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(0, 5));

    const legacyPayload = structuredClone(cursorPayload);
    delete legacyPayload.limit;
    const legacyCursor = encodeListCursor(legacyPayload, project, authorityPath);
    const legacy = packageOnly(["state", "todo", "list", "--ids-only", "--limit", "40", "--cursor", legacyCursor, "--format", "json"], 1);
    expect(legacy.error).toMatchObject({
      class: "cursor_invalid",
      message: "todo cursor lacks the required effective limit binding",
      recovery: "agentera state todo list --ids-only --limit 40 --format json",
    });
    expect(packageOnly(shellCommandArgs(legacy.error.recovery)).entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(0, 40));

    const malformed = packageOnly(["state", "todo", "list", "--ids-only", "--limit", "40", "--cursor", "not-a-cursor", "--format", "json"], 1);
    expect(malformed.error).toMatchObject({ class: "cursor_invalid", recovery: "agentera state todo list --ids-only --limit 40 --format json" });
    expect(packageOnly(shellCommandArgs(malformed.error.recovery)).entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(0, 40));

    const cursorPages = [cursorFirst];
    while (cursorPages.at(-1).retrieval.continue) cursorPages.push(packageOnly(shellCommandArgs(cursorPages.at(-1).retrieval.continue)));
    const cursorEntries = cursorPages.flatMap((page) => page.entries);
    expect(cursorPages).toHaveLength(3);
    cursorPages.forEach((page, index) => expect(page.counts).toMatchObject({
      candidate: 120,
      returned: 40,
      remaining: 120 - (index + 1) * 40,
      omitted: 120 - (index + 1) * 40,
      continuation: 120 - (index + 1) * 40,
    }));
    expect(cursorPages.at(-1)).toMatchObject({ status: "ok", counts: { remaining: 0, omitted: 0, continuation: 0 } });
    expect(cursorPages.at(-1).next_cursor).toBeUndefined();
    expect(cursorPages.at(-1).retrieval.continue).toBeUndefined();
    expect(cursorEntries.map((entry: any) => entry.id)).toEqual(orderedIds);
    expect(cursorEntries.map((entry: any) => entry.queue_rank)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1));
    expect(new Set(cursorEntries.map((entry: any) => entry.id)).size).toBe(120);
    expect(packageOnly(shellCommandArgs(cursorEntries.at(-1).retrieval.get)).entry).toMatchObject({ id: orderedIds.at(-1), artifact: "todo" });

    const normalPages = [packageOnly(["state", "todo", "list", "--severity", "normal", "--status", "open", "--ids-only", "--limit", "10", "--format", "json"])];
    while (normalPages.at(-1).retrieval.continue) normalPages.push(packageOnly(shellCommandArgs(normalPages.at(-1).retrieval.continue)));
    const normalEntries = normalPages.flatMap((page) => page.entries);
    expect(normalPages).toHaveLength(3);
    expect(normalEntries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(90));
    expect(normalEntries.map((entry: any) => entry.queue_rank)).toEqual(Array.from({ length: 30 }, (_, index) => index + 91));

    const first = packageOnly(["state", "todo", "list", "--severity", "critical", "--status", "open", "--ids-only", "--limit", "40", "--format", "json"]);
    const second = packageOnly(shellCommandArgs(first.retrieval.continue));
    const paged = [...first.entries, ...second.entries];
    expect(first.counts).toMatchObject({ candidate: 70, returned: 40, omitted: 30, continuation: 30 });
    expect(second.counts).toMatchObject({ candidate: 70, returned: 30, omitted: 0, continuation: 0 });
    expect(paged.map((entry: any) => entry.id)).toEqual(criticalOpenIds);
    expect(new Set(paged.map((entry: any) => entry.id)).size).toBe(70);

    const selected = parity(["state", "todo", "list", "--fields", "status,target_version", "--limit", "100", "--format", "json"]);
    expect(selected.entries).toHaveLength(100);
    expect(selected.entries.every((entry: any) => entry.record.status && entry.record.target_version === "3.0.0")).toBe(true);

    const degraded = parity(["state", "todo", "list", "--limit", "100", "--format", "json"]);
    expect(degraded).toMatchObject({
      status: "degraded",
      counts: { candidate: 120, returned: 100, omitted: 20, continuation: 20 },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 100, omitted_fields: expect.arrayContaining(["record", "provenance"]) },
    });
    packageOnly(["state", "todo", "list", "--fields", "title", "--limit", "100", "--format", "json"], 1);

    for (const [index, entry] of [first.entries[0], second.entries.at(-1), degraded.entries.at(-1)].entries()) {
      const exact = index === 0
        ? parity(shellCommandArgs(entry.retrieval.get))
        : packageOnly(shellCommandArgs(entry.retrieval.get));
      expect(exact.entry).toMatchObject({ id: entry.id, artifact: "todo" });
    }
    expect(projectByteSnapshot(project)).toEqual(before);
  });

  it("keeps unsafe inactive TODO activation closed in constructed and extracted package output", () => {
    const sourceBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const packagedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const project = fs.mkdtempSync(path.join(fixture.root, "unsafe-inactive-todo-"));
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const ids = seedUnsafeInactiveTodos(project);
    const before = projectByteSnapshot(project);
    const env = isolatedPackageEnv();
    const parity = (args: string[], status: number, compareStdout = true, input?: string) => {
      const source = run(process.execPath, [sourceBin, ...args], project, env, input);
      const packaged = run(process.execPath, [packagedBin, ...args], project, env, input);
      expect(source.status, source.stderr || source.stdout).toBe(status);
      expect(packaged.status, packaged.stderr || packaged.stdout).toBe(status);
      expect(packaged.stderr).toBe(source.stderr);
      if (compareStdout) expect(packaged.stdout).toBe(source.stdout);
      expect(projectByteSnapshot(project)).toEqual(before);
      return { source: JSON.parse(source.stdout), packaged: JSON.parse(packaged.stdout), sourceOutput: source.stdout, packagedOutput: packaged.stdout };
    };

    const preview = parity(["state", "todo", "activate", "--dry-run", "--format", "json"], 2).source;
    expect(preview.error).toMatchObject({
      class: "conflict",
      diagnosis: { counts: { conflicting: 161 }, risks: { resurrected_count: 161, omitted_count: 141 } },
    });
    expect(preview.error.diagnosis.risks.resurrected_ids).toEqual(ids.slice(0, 20));
    expect(JSON.stringify(preview)).not.toContain("PRIVATE_PACKAGED_STALE_TODO_");
    expect(preview).not.toHaveProperty("apply_command");

    const replay = parity(["state", "todo", "activate", "--effect-sha256", "a".repeat(64), "--yes", "--format", "json"], 2).source;
    expect(replay.error).toEqual(preview.error);

    const ownerInput = unsafeOwnerCorrectionInput(project, ids);
    const correction = parity(["state", "todo", "correct-owners", "--input", "-", "--dry-run", "--format", "json"], 0, true, ownerInput).source;
    expect(correction).toMatchObject({
      command: "state todo correct-owners",
      operation: { verb: "correct-owners", dry_run: true },
      correction: { owner_mapping_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), effect_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      apply_command: expect.stringContaining("state todo correct-owners --input OWNER_MAPPING.yaml --effect-sha256"),
    });

    const sourceSchema = run(process.execPath, [sourceBin, "schema", "--format", "json"], project, env);
    const packagedSchema = run(process.execPath, [packagedBin, "schema", "--format", "json"], project, env);
    expect(sourceSchema.status, sourceSchema.stderr).toBe(0);
    expect(packagedSchema.status, packagedSchema.stderr).toBe(0);
    const correctionOperation = (value: string) => JSON.parse(value).state_writer.artifacts
      .find((artifact: any) => artifact.artifact === "todo").operations
      .find((operation: any) => operation.verb === "correct-owners");
    expect(correctionOperation(packagedSchema.stdout)).toEqual(correctionOperation(sourceSchema.stdout));
    const sourceHelp = run(process.execPath, [sourceBin, "state", "todo", "--help"], project, env);
    const packagedHelp = run(process.execPath, [packagedBin, "state", "todo", "--help"], project, env);
    expect(packagedHelp.stdout).toBe(sourceHelp.stdout);
    expect(sourceHelp.stdout).toContain("state todo correct-owners --input OWNER_MAPPING.yaml");
    const sourceExplain = run(process.execPath, [sourceBin, "state", "todo", "explain", "--verb", "correct-owners", "--format", "json"], project, env);
    const packagedExplain = run(process.execPath, [packagedBin, "state", "todo", "explain", "--verb", "correct-owners", "--format", "json"], project, env);
    expect(sourceExplain.status, sourceExplain.stderr).toBe(0);
    expect(packagedExplain.status, packagedExplain.stderr).toBe(0);
    expect(packagedExplain.stdout).toBe(sourceExplain.stdout);

    const prime = parity(["prime", "--format", "json"], 0).source;
    expect(prime.todo_reconciliation).toMatchObject({ state: "unsafe_inactive", preview_command: expect.stringContaining("state todo correct-owners"), apply_command: expect.stringContaining("state todo correct-owners") });
    expect(prime.next_action).toMatchObject({ capability: "build", phase: "build" });
    expect(prime.attention.join("\n")).toContain("Owner correction required");

    const status = parity(["prime", "--context", "status", "--format", "json"], 0);
    for (const [payload, output] of [[status.source, status.sourceOutput], [status.packaged, status.packagedOutput]]) {
      const startup = payload.capability_context.startup;
      const statusContext = payload.capability_context.context.status_context;
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(22500);
      expect(output).not.toContain("PRIVATE_PACKAGED_STALE_TODO_");
      expect(output).not.toContain(project);
      expect(startup).toMatchObject({
        outcome: "blocked",
        todo_reconciliation: {
          state: "unsafe_inactive",
          risks: { resurrected_count: 161, resurrected_ids: ids.slice(0, 20), omitted_count: 141 },
        },
      });
      expect(statusContext).not.toHaveProperty("todo_reconciliation");
      expect(statusContext.attention.join("\n")).not.toContain("Owner correction required");
      expect(statusContext.next_action.reason).not.toContain("Owner correction required");
    }

    const doctor = parity(["doctor", "--format", "json"], 1, false);
    for (const result of [doctor.source, doctor.packaged]) expect(result.signals.find((entry: any) => entry.kind === "todo_reconciliation")).toMatchObject({
      reconciliationState: "unsafe_inactive",
      previewCommand: expect.stringContaining("state todo correct-owners"),
      applyCommand: expect.stringContaining("state todo correct-owners"),
      recoveryCommand: expect.stringContaining("Owner correction required"),
    });

    const validation = parity(["check", "validate", "state", "--format", "json"], 1).source;
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "todo_reconciliation_unsafe_inactive", diagnosis: expect.objectContaining({ state: "unsafe_inactive", preview_command: expect.stringContaining("state todo correct-owners"), apply_command: expect.stringContaining("state todo correct-owners") }) }),
    ]));
  });

  it("keeps targeted plan successor selection and bounded recovery diagnostics equal in source and packed output", () => {
    const sourceBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const packagedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const recovery = "npx -y agentera@next state plan replace --predecessor PREDECESSOR_ID --successor SUCCESSOR_ID --format json";
    const env = isolatedPackageEnv();
    const project = (prefix: string, count: number) => {
      const root = fs.mkdtempSync(path.join(fixture.root, prefix));
      fs.mkdirSync(path.join(root, ".agentera"));
      fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
      return { root, ids: seedCompetingOpenPlans(root, count) };
    };
    const assertDiagnostic = (root: string, ids: string[], args: string[], status: number, omitted = 0) => {
      const source = run(process.execPath, [sourceBin, ...args], root, env, "name: Explicit selection\ndepends_on: []\nacceptance: []\n");
      const packaged = run(process.execPath, [packagedBin, ...args], root, env, "name: Explicit selection\ndepends_on: []\nacceptance: []\n");
      expect(source.status, source.stderr || source.stdout).toBe(status);
      expect(packaged.status, packaged.stderr || packaged.stdout).toBe(status);
      expect(packaged.stderr).toBe(source.stderr);
      expect(packaged.stdout).toBe(source.stdout);
      const error = JSON.parse(source.stdout).error;
      expect(error).toMatchObject({ class: status === 2 ? "conflict" : "ambiguous", recovery });
      expect(error.details ?? error.diagnosis).toEqual({
        open_plan_candidates: { total: ids.length, sample_ids: ids.slice(0, 100), omitted_count: omitted },
      });
    };

    const competing = project("plan-replacement-competing-", 2);
    assertDiagnostic(competing.root, competing.ids, ["prime", "--context", "plan", "--format", "json"], 1);
    assertDiagnostic(competing.root, competing.ids, ["state", "plan", "tasks", "list", "--format", "json"], 1);
    assertDiagnostic(competing.root, competing.ids, ["state", "plan", "append", "--input", "-", "--format", "json"], 1);
    const overBound = project("plan-replacement-over-bound-", 101);
    assertDiagnostic(overBound.root, overBound.ids, ["prime", "--context", "status", "--format", "json"], 1, 1);
    assertDiagnostic(overBound.root, overBound.ids, ["state", "plan", "tasks", "list", "--format", "json"], 1, 1);
    assertDiagnostic(overBound.root, overBound.ids, ["state", "plan", "replace", "--predecessor", overBound.ids[0], "--successor", overBound.ids[1], "--format", "json"], 2, 1);

    const sourceSchema = run(process.execPath, [sourceBin, "schema", "--format", "json"], competing.root, env);
    const packagedSchema = run(process.execPath, [packagedBin, "schema", "--format", "json"], competing.root, env);
    expect(sourceSchema.status, sourceSchema.stderr).toBe(0);
    expect(packagedSchema.status, packagedSchema.stderr).toBe(0);
    const replaceOperation = (value: string) => JSON.parse(value).state_writer.artifacts
      .find((artifact: any) => artifact.artifact === "plan").operations
      .find((operation: any) => operation.verb === "replace");
    expect(replaceOperation(packagedSchema.stdout)).toEqual(replaceOperation(sourceSchema.stdout));
    const sourceHelp = run(process.execPath, [sourceBin, "state", "plan", "--help"], competing.root, env);
    const packagedHelp = run(process.execPath, [packagedBin, "state", "plan", "--help"], competing.root, env);
    expect(packagedHelp.stdout).toBe(sourceHelp.stdout);
    expect(sourceHelp.stdout).toContain("--predecessor PREDECESSOR_ID --successor SUCCESSOR_ID");
    const sourceExplain = run(process.execPath, [sourceBin, "state", "plan", "explain", "--verb", "replace", "--format", "json"], competing.root, env);
    const packagedExplain = run(process.execPath, [packagedBin, "state", "plan", "explain", "--verb", "replace", "--format", "json"], competing.root, env);
    expect(sourceExplain.status, sourceExplain.stderr).toBe(0);
    expect(packagedExplain.status, packagedExplain.stderr).toBe(0);
    expect(packagedExplain.stdout).toBe(sourceExplain.stdout);
    expect(JSON.parse(sourceExplain.stdout).guidance).toEqual(expect.arrayContaining([
      expect.stringContaining("never infer roles from list order"),
      expect.stringContaining("pending plan replacement journals block plan reads"),
    ]));

    const sourceProject = project("plan-replacement-source-", 2);
    const packagedProject = project("plan-replacement-package-", 2);
    const replaceArgs = ["state", "plan", "replace", "--predecessor", sourceProject.ids[0], "--successor", sourceProject.ids[1], "--format", "json"];
    const sourceReplace = run(process.execPath, [sourceBin, ...replaceArgs], sourceProject.root, env);
    const packagedReplace = run(process.execPath, [packagedBin, ...replaceArgs], packagedProject.root, env);
    expect(sourceReplace.status, sourceReplace.stderr || sourceReplace.stdout).toBe(0);
    expect(packagedReplace.status, packagedReplace.stderr || packagedReplace.stdout).toBe(0);
    const comparableReplacement = (value: string) => {
      const parsed = JSON.parse(value);
      return { id: parsed.id, artifact: parsed.artifact, record: parsed.record, operation: parsed.operation, effects: parsed.effects };
    };
    expect(comparableReplacement(packagedReplace.stdout)).toEqual(comparableReplacement(sourceReplace.stdout));

    const observe = (bin: string, root: string, predecessor: string, successor: string) => {
      const contexts: Record<string, any> = {};
      for (const capability of ["plan", "orchestrate", "status"] as const) {
        const result = run(process.execPath, [bin, "prime", "--context", capability, "--format", "json"], root, env);
        expect(result.status, `${capability}: ${result.stderr || result.stdout}`).toBe(0);
        const payload = JSON.parse(result.stdout);
        const context = payload.capability_context.context;
        const selected = capability === "status" ? context.status_context.plan : context.plan;
        contexts[capability] = { selected, instructions: payload.capability_context.instructions };
      }
      const dashboard = run(process.execPath, [bin, "prime", "--dashboard", "--format", "json"], root, env);
      expect(dashboard.status, dashboard.stderr || dashboard.stdout).toBe(0);
      const open = run(process.execPath, [bin, "state", "plan", "list", "--status", "open", "--limit", "100", "--format", "json"], root, env);
      const historical = run(process.execPath, [bin, "state", "plan", "get", "--id", predecessor, "--format", "json"], root, env);
      const currentTasks = run(process.execPath, [bin, "state", "plan", "tasks", "list", "--format", "json"], root, env);
      return {
        contexts,
        dashboard: JSON.parse(dashboard.stdout).capability_context.context.status_context.plan,
        open: JSON.parse(open.stdout).entries.map((entry: any) => entry.id),
        historical: JSON.parse(historical.stdout).entry.record.header.status,
        currentPlan: JSON.parse(currentTasks.stdout).filters.plan,
        successor,
      };
    };
    const sourceObserved = observe(sourceBin, sourceProject.root, sourceProject.ids[0], sourceProject.ids[1]);
    const packagedObserved = observe(packagedBin, packagedProject.root, packagedProject.ids[0], packagedProject.ids[1]);
    expect(packagedObserved).toEqual(sourceObserved);
    for (const capability of ["plan", "orchestrate", "status"] as const) {
      expect(sourceObserved.contexts[capability].selected).toMatchObject({ id: sourceProject.ids[1], artifact: "plan", active: true, status: "open" });
      expect(sourceObserved.contexts[capability].instructions).toContain(recovery);
    }
    expect(sourceObserved.dashboard).toMatchObject({ id: sourceProject.ids[1], artifact: "plan", active: true, status: "open" });
    expect(sourceObserved).toMatchObject({ open: [sourceProject.ids[1]], historical: "archived", currentPlan: sourceProject.ids[1] });
  });

  it("retains executable 21-task routing and mixed history in source and the extracted package", () => {
    const sourceBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const packagedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const project = fs.mkdtempSync(path.join(fixture.root, "prime-routing-evidence-"));
    const home = fs.mkdtempSync(path.join(fixture.root, "prime-routing-home-"));
    const seeded = seedPrimeEvidenceProject(project);
    const before = projectByteSnapshot(project);
    const env = isolatedPackageEnv({ HOME: home });
    const invoke = (bin: string, args: string[]) => run(process.execPath, [bin, ...args], project, env);
    const observed: Record<string, any> = {};

    for (const [label, bin] of [["source", sourceBin], ["package", packagedBin]] as const) {
      const result = invoke(bin, ["prime", "--format", "json"]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12_000);
      const payload = JSON.parse(result.stdout);
      expect(payload.brief.projection).toMatch(/^(ok|degraded)$/);
      expect(payload.plan).toMatchObject({
        id: seeded.planId,
        total: 21,
        first_pending: {
          id: seeded.selectedTaskId,
          depends_on: [seeded.selectedDependencyId],
          acceptance: expect.arrayContaining([expect.stringContaining("bounded plan names this task")]),
          retrieval: {
            get: `npx -y agentera@next state plan tasks get --id ${seeded.selectedTaskId} --format json`,
          },
        },
      });
      expect(payload.plan).not.toHaveProperty("tasks");
      expect(payload.next_action).toMatchObject({
        id: seeded.selectedTaskId,
        capability: "orchestrate",
        eligible: true,
        retrieval: {
          exact: `npx -y agentera@next state plan tasks get --id ${seeded.selectedTaskId} --format json`,
        },
      });
      for (const artifact of ["progress", "decisions", "health"]) {
        expect(payload.history[artifact]).toMatchObject({
          counts: { total: 2, returned: 0, remaining: 2, full: 1, summary: 1 },
          caveats: [expect.stringContaining("incomplete historical evidence")],
          degraded_history: { summary_count: 1, returned_count: 0, omitted_count: 1 },
          retrieval: {
            list: `npx -y agentera@next state ${artifact} list --limit 20 --format json`,
            get: `npx -y agentera@next state ${artifact} get --id ID --format json`,
          },
          source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "mixed" },
        });
      }
      expect(payload.decision_attention).toBeNull();

      const selected = invoke(bin, shellCommandArgs(payload.next_action.retrieval.exact.replace(/^npx -y agentera@next /, "agentera ")));
      expect(selected.status, selected.stderr || selected.stdout).toBe(0);
      expect(JSON.parse(selected.stdout).entry).toMatchObject({ id: seeded.selectedTaskId, artifact: "plan" });
      const decision = invoke(bin, ["state", "decisions", "get", "--id", seeded.fullDecisionId, "--format", "json"]);
      expect(decision.status, decision.stderr || decision.stdout).toBe(0);
      expect(JSON.parse(decision.stdout).entry.record).toMatchObject({
        confidence: "firm",
        satisfaction: { state: "provisionally_satisfied" },
      });
      observed[label] = {
        plan: payload.plan,
        next_action: payload.next_action,
        history: payload.history,
        decision_attention: payload.decision_attention,
      };
    }
    expect(observed.package).toEqual(observed.source);
    expect(projectByteSnapshot(project)).toEqual(before);
  });

  it("classifies every extracted-package TODO cursor branch with executable current restart", () => {
    const packagedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const project = fs.mkdtempSync(path.join(fixture.root, "todo-cursor-branches-"));
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const { orderedIds } = seedRealisticTodos(project, 40);
    const before = projectByteSnapshot(project);
    const env = isolatedPackageEnv();
    const invoke = (args: string[], status = 0) => {
      const result = run(process.execPath, [packagedBin, ...args], project, env);
      expect(result.status, result.stderr || result.stdout).toBe(status);
      return JSON.parse(result.stdout);
    };
    const authorityPath = path.join(CHECKOUT_ROOT, "references/artifacts/state-storage-authority.yaml");
    const first = invoke(["state", "todo", "list", "--ids-only", "--limit", "10", "--format", "json"]);
    const payload = decodeListCursor(first.next_cursor, project, authorityPath);
    const assertFailure = (args: string[], classification: string, message: string, recovery: string, expectedIds = orderedIds.slice(0, 10)): void => {
      const failure = invoke(args, 1);
      expect(failure).not.toHaveProperty("entries");
      expect(failure.error).toMatchObject({ class: classification, message, recovery });
      expect(invoke(shellCommandArgs(failure.error.recovery)).entries.map((entry: any) => entry.id)).toEqual(expectedIds);
    };

    assertFailure(
      ["state", "todo", "list", "--ids-only", "--limit", "20", "--cursor", first.next_cursor, "--format", "json"],
      "cursor_invalid",
      "todo cursor is bound to --limit 10, not --limit 20",
      "agentera state todo list --ids-only --limit 20 --format json",
      orderedIds.slice(0, 20),
    );
    assertFailure(
      ["state", "todo", "list", "--limit", "10", "--cursor", first.next_cursor, "--format", "json"],
      "cursor_invalid",
      "todo cursor selectors do not match this request",
      "agentera state todo list --limit 10 --format json",
    );
    assertFailure(
      ["state", "todo", "list", "--status", "open", "--ids-only", "--limit", "10", "--cursor", first.next_cursor, "--format", "json"],
      "cursor_invalid",
      "todo cursor filters do not match this request",
      "agentera state todo list --status 'open' --ids-only --limit 10 --format json",
    );
    const changedOrder = structuredClone(payload); changedOrder.order = "changed_order";
    assertFailure(
      ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", encodeListCursor(changedOrder, project, authorityPath), "--format", "json"],
      "cursor_invalid",
      "todo cursor order does not match this request",
      "agentera state todo list --ids-only --limit 10 --format json",
    );

    const defaultFirst = invoke(["state", "todo", "list", "--ids-only", "--format", "json"]);
    expect(decodeListCursor(defaultFirst.next_cursor, project, authorityPath).limit).toBe(20);
    expect(invoke(["state", "todo", "list", "--ids-only", "--limit", "20", "--cursor", defaultFirst.next_cursor, "--format", "json"]).entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(20, 40));
    const explicitDefault = invoke(["state", "todo", "list", "--ids-only", "--limit", "20", "--format", "json"]);
    expect(invoke(["state", "todo", "list", "--ids-only", "--cursor", explicitDefault.next_cursor, "--format", "json"]).entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(20, 40));

    const [body, signature] = String(first.next_cursor).split(".");
    const malformedVariants = [
      `${body}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
      `${body}=.${signature}`,
      encodeListCursor([] as any, project, authorityPath),
    ];
    for (const cursor of malformedVariants) assertFailure(
      ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", cursor, "--format", "json"],
      "cursor_invalid",
      "todo cursor is malformed or belongs to another project",
      "agentera state todo list --ids-only --limit 10 --format json",
    );
    for (const invalidLimit of [0, -1, 1.5, 101, "10", null]) {
      const invalid = structuredClone(payload); invalid.limit = invalidLimit as any;
      assertFailure(
        ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", encodeListCursor(invalid, project, authorityPath), "--format", "json"],
        "cursor_invalid",
        "todo cursor has an invalid effective limit binding",
        "agentera state todo list --ids-only --limit 10 --format json",
      );
    }
    const missingAfter = structuredClone(payload); missingAfter.after = "zzzzzzzzzz";
    assertFailure(
      ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", encodeListCursor(missingAfter, project, authorityPath), "--format", "json"],
      "cursor_snapshot_unavailable",
      "todo cursor continuation identity is no longer available",
      "agentera state todo list --ids-only --limit 10 --format json",
    );
    expect(projectByteSnapshot(project)).toEqual(before);

    seedRealisticTodos(project, 41);
    const mutated = projectByteSnapshot(project);
    assertFailure(
      ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", first.next_cursor, "--format", "json"],
      "cursor_snapshot_unavailable",
      "todo cursor snapshot is no longer available",
      "agentera state todo list --ids-only --limit 10 --format json",
    );
    expect(projectByteSnapshot(project)).toEqual(mutated);
  });

  it("executes active documented examples and every concrete startup state recovery in source and the extracted package", () => {
    const sourceBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const packagedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const project = fs.mkdtempSync(path.join(fixture.root, "active-retrieval-consumers-"));
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    seedPublicListExamples(project);
    const env = isolatedPackageEnv();
    const invoke = (bin: string, args: string[]) => run(process.execPath, [bin, ...args], project, env);
    const executeBoth = (command: string): void => {
      const concrete = command
        .replaceAll("PLAN_ID", "abcdefghij")
        .replaceAll("OBJECTIVE_ID", "qjtrmnpvka")
        .replaceAll("EXPERIMENT_ID", "zzzzzzzzzz");
      const args = shellCommandArgs(concrete.replace(/^npx -y agentera@next /, "agentera "));
      const source = invoke(sourceBin, args);
      const packaged = invoke(packagedBin, args);
      expect(source.status, `${concrete}\n${source.stdout}\n${source.stderr}`).toBe(0);
      expect(packaged.status, `${concrete}\n${packaged.stdout}\n${packaged.stderr}`).toBe(0);
    };

    const documented = new Set<string>();
    for (const relative of ["README.md", "AGENTS.md", "packages/cli/README.md"]) {
      for (const line of fs.readFileSync(path.join(CHECKOUT_ROOT, relative), "utf8").split(/\r?\n/)) {
        const command = line.trim().replace(/\s+#.*$/, "");
        if (/^agentera (?:prime(?:\s|$)|state (?:query(?:\s|$)|(?:progress|decisions|health|plan|objective|experiments|todo|docs) (?:list|get|explain)(?:\s|$)))/.test(command)) documented.add(command);
      }
    }
    expect([...documented]).toEqual(expect.arrayContaining([
      "agentera state plan list --format json",
      "agentera state experiments get --id EXPERIMENT_ID --format json",
    ]));
    for (const command of documented) executeBoth(command);

    const recoveries = new Set<string>();
    const isConcreteStateRead = (command: string): boolean => (
      /^(?:npx -y agentera@next |agentera )state /.test(command)
      && !/[<>\[\]]/.test(command)
      && !/\b(?:ID|TOKEN|N|TEXT|STATUS|DIMENSION|FIELDS|SEVERITY|OBJECTIVE_ID|PLAN_ID)\b/.test(command)
    );
    const collect = (value: unknown, key = ""): void => {
      if (typeof value === "string") {
        if ((key === "recovery" || key === "retrieval" || key === "list" || key === "get") && isConcreteStateRead(value)) recoveries.add(value);
        return;
      }
      if (Array.isArray(value)) {
        if (key === "fallback_commands" || key === "cli_fallback") {
          for (const command of value) if (typeof command === "string" && isConcreteStateRead(command)) recoveries.add(command);
        } else for (const item of value) collect(item, key);
        return;
      }
      if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) collect(child, childKey);
    };
    for (const args of [
      ["prime", "--format", "json"],
      ["prime", "--context", "status", "--format", "json"],
      ["prime", "--context", "orchestrate", "--format", "json"],
      ["prime", "--context", "plan", "--format", "json"],
      ["prime", "--context", "optimize", "--format", "json"],
    ]) {
      for (const bin of [sourceBin, packagedBin]) {
        const result = invoke(bin, args);
        expect(result.status, result.stderr || result.stdout).toBe(0);
        const payload = JSON.parse(result.stdout);
        collect(payload);
        const served = String(payload.capability_context?.instructions ?? "");
        expect(served).not.toMatch(/agentera state (?:progress|decisions|health|plan|objective|experiments|todo|docs) --format json/);
        expect(served).not.toMatch(/agentera state experiments get --objective/);
      }
    }
    expect([...recoveries]).toEqual(expect.arrayContaining([
      "npx -y agentera@next state plan list --format json",
      "npx -y agentera@next state docs list --format json",
      "npx -y agentera@next state todo list --format json",
    ]));
    for (const command of recoveries) executeBoth(command);
  });

  it("keeps packaged bootstrap authorities and complete served bodies channel-correct", () => {
    const project = fs.mkdtempSync(path.join(fixture.root, "retired-startup-guidance-"));
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const packageSkill = fs.readFileSync(path.join(fixture.packageRoot, "bundle/skills/agentera/SKILL.md"), "utf8");
    expect(retiredStartupGuidanceViolations(packageSkill), "packaged shared skill").toEqual([]);
    const bundleRoot = path.join(fixture.packageRoot, "bundle");
    const authorities = registryBundledAuthorityPaths(bundleRoot);
    expect(authorities).toContain("references/cli/routing-model.md");
    expect(registryBundledAuthorityViolations(bundleRoot), `${authorities.length} registry-owned package authorities`).toEqual([]);
    const markdownTail = `${fs.readFileSync(path.join(bundleRoot, "references/cli/routing-model.md"), "utf8")}\n## Recovery regression\nRun \`npx -y agentera@latest doctor --format json\`.\n`;
    expect(registryBundledAuthorityViolations(
      bundleRoot,
      new Map([["references/cli/routing-model.md", markdownTail]]),
    )).toContain("references/cli/routing-model.md: stable_channel_outside_exemption");
    const packageInventory = registryBootstrapAuthorityInventory(fixture.packageRoot, true);
    expect(packageInventory.diagnostics, "closed extracted-package bootstrap inventory").toEqual([]);
    expect(new Set(packageInventory.records.map(({ surface }) => surface))).toEqual(new Set(["bundle", "generated", "emitted"]));
    expect(packageInventory.records.every(({ reason }) => reason.length > 0)).toBe(true);
    const parity = registryBootstrapAuthorityParity(CHECKOUT_ROOT, fixture.packageRoot);
    expect(parity.diagnostics, "exact normalized source/package command-authority parity").toEqual([]);
    expect(parity.source).toHaveLength(199);
    expect(parity.package).toHaveLength(199);
    expect(parity.package).toEqual(parity.source);
    for (const capability of ["status", "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate"]) {
      const result = run(process.execPath, [bin, "prime", "--context", capability, "--format", "json"], project, isolatedPackageEnv());
      expect(result.status, `${capability}\n${result.stderr || result.stdout}`).toBe(0);
      const instructions = String(JSON.parse(result.stdout).capability_context?.instructions ?? "");
      expect(retiredStartupGuidanceViolations(instructions), `${capability} packaged instructions`).toEqual([]);
      expect(preCutoverBootstrapGuidanceViolations(instructions), `${capability} complete packaged instructions`).toEqual([]);
      expect(instructions).toContain(`npx -y agentera@next prime --context ${capability} --format json`);
    }
  });

  it("fails closed when the isolated package authority loses required bare-read recovery", () => {
    const authorityPath = path.join(fixture.packageRoot, "bundle/references/artifacts/state-storage-authority.yaml");
    const original = fs.readFileSync(authorityPath);
    try {
      const authority = YAML.parse(original.toString("utf8"));
      delete authority.entity_target.public_retrieval.list_help.families.health.bare_recovery;
      fs.writeFileSync(authorityPath, YAML.stringify(authority));
      const result = run(process.execPath, [path.join(fixture.packageRoot, "dist/bin/agentera.js"), "schema", "--format", "json"], fixture.root, isolatedPackageEnv());
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("bare_recovery");
    } finally {
      fs.writeFileSync(authorityPath, original);
    }
  });

  it("runs packaged personal glossary rendering and restart-safe regeneration as new processes", () => {
    expect(fixture.manifest.files.some((entry) => entry.path === "dist/analytics/personalGlossaryProfile.js")).toBe(true);
    const root = fs.mkdtempSync(path.join(fixture.root, "personal-profile-"));
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const observation = runServedProfileFullWorkflow(bin, root);
    expect(observation).toMatchObject({
      firstStatus: "changed",
      replayStatus: "unchanged_replay",
      laterStatus: "changed",
      laterConfidence: 49,
      malformedCasesRejected: 4,
    });
    const authority = fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/artifacts/glossary-entry-contract.yaml"),
      "utf8",
    );
    expect(authority).toContain("profile_full_rendering");
    expect(authority).toContain("npx -y agentera@next report profile-glossary");
  });

  it("matches source and extracted-package producer readiness", { timeout: 120_000 }, async () => {
    const source = await runProducerReadinessWorkflow(
      path.join(fixture.constructionRoot, "dist/bin/agentera.js"),
      path.join(fixture.root, "producer-source"),
    );
    const packaged = await runProducerReadinessWorkflow(
      path.join(fixture.packageRoot, "dist/bin/agentera.js"),
      path.join(fixture.root, "producer-package"),
    );
    expect(source).toEqual(EXPECTED_PRODUCER_READINESS);
    expect(packaged).toEqual(source);
  });

  it("matches complete source and constructed-package Prime envelopes after same-minute lifecycle publications", { timeout: 120_000 }, () => {
    const workflowRoot = path.join(fixture.root, "same-minute-prime-parity");
    const executableRoot = path.join(fixture.root, "same-minute-executable");
    fs.cpSync(fixture.constructionRoot, executableRoot, { recursive: true });
    if (!fs.existsSync(path.join(executableRoot, "node_modules"))) {
      fs.symlinkSync(path.join(CHECKOUT_ROOT, "packages/cli/node_modules"), path.join(executableRoot, "node_modules"), "dir");
    }
    const source = sameMinuteProgressPrimeWorkflow(
      path.join(executableRoot, "dist/bin/agentera.js"),
      workflowRoot,
    );
    fs.rmSync(executableRoot, { recursive: true, force: true });
    fs.cpSync(fixture.packageRoot, executableRoot, { recursive: true });
    const packaged = sameMinuteProgressPrimeWorkflow(
      path.join(executableRoot, "dist/bin/agentera.js"),
      workflowRoot,
    );
    expect(packaged.json).toEqual(source.json);
    expect(packaged.status).toEqual(source.status);
    expect(packaged.text).toEqual(source.text);
    expect(packaged.publicationOrders).toEqual(source.publicationOrders);
    expect(fs.existsSync(workflowRoot)).toBe(true);
    fs.rmSync(workflowRoot, { recursive: true, force: true });
    fs.rmSync(executableRoot, { recursive: true, force: true });
    expect(fs.existsSync(workflowRoot)).toBe(false);
    expect(fs.existsSync(executableRoot)).toBe(false);
  });

  it("flags a reintroduced native descriptor path in the package inventory", () => {
    expect(currentDescriptorPaths([
      "bundle/skills/agentera/SKILL.md",
      "bundle/skills/agentera/agents/build.toml",
      "bundle/.agentera/archive/legacy/skills/agentera/agents/build.toml",
    ])).toEqual(["bundle/skills/agentera/agents/build.toml"]);
  });

  it("rejects retired and otherwise unclassified top-level package surfaces", () => {
    const surfaces: BundleSurfaces = {
      directories: [{ path: "skills" }, { path: "references" }],
      files: [{ path: "registry.json" }],
      generated_files: [{ path: ".agentera-npx-bundle.json" }],
    };
    expect(unclassifiedManifestPaths([
      "package.json",
      "README.md",
      "dist/bin/agentera.js",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      ".opencode/package.json",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ], surfaces)).toEqual([
      ".opencode/package.json",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ]);
  });

  it("installs and invokes the extracted package without a repository checkout", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = run(process.execPath, [bin, "--help"], fixture.root, isolatedPackageEnv({
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: CHECKOUT_ROOT,
    }));
    expect(result.status, `package boundary invocation failed:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("agentera");
  });

  it("keeps the extracted package bound to its bundle from an Agentera checkout", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const env = isolatedPackageEnv();
    delete env.AGENTERA_HOME;
    const result = run(
      process.execPath,
      [bin, "prime", "--fields", "app_home,app", "--format", "json"],
      CHECKOUT_ROOT,
      env,
    );
    expect(result.status, `package checkout-cwd invocation failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      app_home: { home: string; source: string };
      app: { sourceRoot: string };
    };
    expect(payload).toMatchObject({
      app_home: { home: expect.any(String), source: "bundled app" },
      app: { sourceRoot: expect.any(String) },
    });
    const bundleRoot = fs.realpathSync(path.join(fixture.packageRoot, "bundle"));
    for (const reportedSource of [payload.app_home.home, payload.app.sourceRoot]) {
      const appSource = fs.realpathSync(reportedSource);
      expect(
        isContained(bundleRoot, appSource),
        `package checkout-cwd escaped extracted bundle: source=${appSource} bundle=${bundleRoot}`,
      ).toBe(true);
    }
  });

  it("routes a structured request from the extracted package without exposing it in diagnostics", () => {
    const request = "help me decide: private package-boundary topic";
    const input = path.join(fixture.root, "route-request.yaml");
    fs.writeFileSync(input, YAML.stringify({ version: "agentera.route_request.v1", request }));
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = run(process.execPath, [bin, "route", "request", "--input", input, "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(result.status, `package boundary route failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain(request);
    expect(result.stdout).not.toContain(request);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "deterministic_selection",
      tier: "phrase",
      capability: "discuss",
    });
  });

  it("validates a semantic receipt from the extracted package and exposes only startup authorization", () => {
    const request = "private package semantic selection";
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const requestInput = path.join(fixture.root, "route-request.json");
    fs.writeFileSync(requestInput, JSON.stringify({ version: "agentera.route_request.v1", request }));
    const phaseOne = run(process.execPath, [bin, "route", "request", "--input", requestInput, "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(phaseOne.status, `package boundary phase one failed:\n${phaseOne.stdout}\n${phaseOne.stderr}`).toBe(0);
    expect(phaseOne.stderr).not.toContain(request);
    expect(phaseOne.stdout).not.toContain(request);
    const response = JSON.parse(phaseOne.stdout);
    expect(response).toMatchObject({ outcome: "semantic_required", semantic_capsule_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const receipt = {
      version: "agentera.route_receipt.v1",
      request_sha256: sha256(request),
      semantic_capsule_sha256: response.semantic_capsule_sha256,
      outcome: "select",
      capability: "plan",
      compound: "none",
      question: null,
      remainder_span: null,
    };
    const input = path.join(fixture.root, "route-receipt.json");
    fs.writeFileSync(input, JSON.stringify({ request, receipt }));
    const result = run(process.execPath, [bin, "route", "receipt", "--input", input, "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(result.status, `package boundary receipt failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain(request);
    expect(result.stdout).not.toContain(request);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "selected", capability: "plan", route_provenance: { startup_command: "npx -y agentera@next prime --context plan --format json" } });
  });

  it("evaluates the frozen routing corpus from byte-identical packed authorities", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = run(process.execPath, [bin, "route", "evaluate", "--format", "json"], fixture.root, isolatedPackageEnv());
    expect(result.status, `package routing evaluation failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout) as { authority: Record<string, string>; corpus: Record<string, string>; status: string };
    expect(report.status).toBe("pass");
    for (const [reportKey, sourcePath, bundledPath] of [
      ["protocol_sha256", "references/cli/hybrid-route-contract.yaml", "bundle/references/cli/hybrid-route-contract.yaml"],
      ["phrase_authority_sha256", "skills/agentera/route-phrases.yaml", "bundle/skills/agentera/route-phrases.yaml"],
      ["shared_skill_sha256", "skills/agentera/SKILL.md", "bundle/skills/agentera/SKILL.md"],
    ] as const) {
      const sourceHash = sha256(fs.readFileSync(path.join(CHECKOUT_ROOT, sourcePath)));
      const bundledHash = sha256(fs.readFileSync(path.join(fixture.packageRoot, bundledPath)));
      expect(bundledHash, bundledPath).toBe(sourceHash);
      expect(report.authority[reportKey]).toBe(sourceHash);
    }
    const corpusHash = sha256(fs.readFileSync(path.join(CHECKOUT_ROOT, "fixtures/routing/hybrid-corpus.yaml")));
    expect(sha256(fs.readFileSync(path.join(fixture.packageRoot, "bundle/fixtures/routing/hybrid-corpus.yaml")))).toBe(corpusHash);
    expect(report.corpus.content_sha256).toBe(corpusHash);
  });

  it("upgrades one managed v2 fixture and converges on a same-install rerun", () => {
    const project = path.join(fixture.root, "project $(touch shell-expansion-trap) `touch backtick-trap`");
    fs.cpSync(V2_PROJECT, project, { recursive: true });
    const planPath = path.join(project, ".agentera/plan.yaml");
    const plan = YAML.parse(fs.readFileSync(planPath, "utf8"));
    plan.header.id = PLAN_ID;
    plan.tasks = [
      { number: 1, name: "Preserve packed records", depends_on: [], status: "pending", acceptance: ["records remain addressable"] },
      { number: 2, name: "Preserve packed relationships", depends_on: ["Task 1"], status: "pending", acceptance: ["dependency remains resolved"] },
    ];
    fs.writeFileSync(planPath, YAML.stringify(plan));
    const sourceBefore = new Map([
      [planPath, fs.readFileSync(planPath)],
      [path.join(project, ".agentera/progress.yaml"), fs.readFileSync(path.join(project, ".agentera/progress.yaml"))],
    ]);
    git(project, "init", "--quiet");
    git(project, "config", "user.name", "Package Verification Test");
    git(project, "config", "user.email", "package-verification@example.invalid");
    git(project, "config", "commit.gpgsign", "false");
    git(project, "add", ".");
    git(project, "commit", "--quiet", "-m", "tracked v2 fixture");

    const home = path.join(fixture.root, "home");
    fs.cpSync(V2_RUNTIME, home, { recursive: true });
    const appHome = path.join(home, ".local/share/agentera");
    fs.cpSync(V2_APP_HOME, appHome, { recursive: true });
    const preservedAppState = fs.readFileSync(path.join(appHome, ".agentera/progress.yaml"));
    const env = isolatedPackageEnv({
      HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: CHECKOUT_ROOT,
    });
    expect(env.AGENTERA_BOOTSTRAP_SOURCE_ROOT).toBeUndefined();
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const bootstrap = run(process.execPath, [bin, "prime", "--context", "status", "--format", "json"], project, env);
    expect(bootstrap.status, bootstrap.stderr || bootstrap.stdout).toBe(0);
    const bootstrapPayload = JSON.parse(bootstrap.stdout) as { capability_context: { startup: { outcome: string } } };
    expect(["ok", "degraded", "blocked"]).toContain(bootstrapPayload.capability_context.startup.outcome);
    expect(bootstrap.stdout).toContain("npx -y agentera@next upgrade");
    expect(bootstrap.stdout).not.toContain("agentera@latest");

    const baseUpgradeArgs = [
      bin, "upgrade", "--channel", "development", "--project", project,
      "--install-root", appHome, "--force", "--format", "json",
    ];
    const preview = run(process.execPath, [...baseUpgradeArgs, "--dry-run"], fixture.root, env);
    expect(preview.status, `package boundary upgrade preview failed:\n${preview.stdout}\n${preview.stderr}`).toBe(1);
    const previewPlan = JSON.parse(preview.stdout) as any;
    expect(previewPlan.phases.map((phase: any) => phase.name)).toEqual([
      "detect", "artifacts", "entities", "runtime", "cleanup",
    ]);
    expect(previewPlan.phases.find((phase: any) => phase.name === "entities")?.items).toEqual([
      expect.objectContaining({ status: "pending", action: "entity-cutover" }),
    ]);
    const runtimePhase = previewPlan.phases.find((phase: any) => phase.name === "runtime");
    const legacyHooks = runtimePhase.items.filter((item: any) =>
      item.status === "pending" && item.action === "retire-hooks");
    expect(legacyHooks.map((item: any) => item.source).sort()).toEqual([
      path.join(home, ".codex/hooks/codex-hooks.json"),
      path.join(home, ".cursor/hooks.json"),
    ].sort());
    expect(JSON.stringify(previewPlan)).not.toContain(path.join(home, ".agents/skills/agentera"));

    const upgraded = run(process.execPath, [...baseUpgradeArgs, "--yes"], fixture.root, env);
    expect(upgraded.status, `package boundary upgrade failed:\n${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
    expect(JSON.parse(upgraded.stdout)).toMatchObject({
      phase: "complete",
      status: "success",
      state_validation: { status: "passed", entity_count: 3, issue_count: 0 },
      startup_validation: { status: "passed" },
    });
    expect(fs.existsSync(path.join(fixture.root, "shell-expansion-trap"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, "backtick-trap"))).toBe(false);
    expect(YAML.parse(fs.readFileSync(path.join(project, ".agentera/state-mode.yaml"), "utf8")))
      .toMatchObject({ mode: "entities" });
    for (const [source, bytes] of sourceBefore) expect(fs.readFileSync(source)).toEqual(bytes);

    const entities = entityEnvelopes(project);
    expect(entities).toHaveLength(3);
    const planEntity = entities.find((entity) => (entity.record.header as { title?: string } | undefined)?.title === "Supported legacy plan")!;
    const tasks = entities.filter((entity) => entity.record.plan === planEntity.id)
      .sort((a, b) => String(a.record.name).localeCompare(String(b.record.name)));
    expect(planEntity.record).toMatchObject({ header: { title: "Supported legacy plan", status: "open" } });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].record).toMatchObject({ name: "Preserve packed records", plan: planEntity.id, depends_on: [] });
    expect(tasks[1].record).toMatchObject({ name: "Preserve packed relationships", plan: planEntity.id, depends_on: [tasks[0].id] });

    expect(fs.readFileSync(path.join(appHome, ".agentera/progress.yaml"))).toEqual(preservedAppState);
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toContain("AGENTERA_HOME");
    for (const retired of [path.join(home, ".codex/hooks/codex-hooks.json"), path.join(home, ".cursor/hooks.json")]) {
      expect(fs.existsSync(retired), retired).toBe(false);
    }
    expect(fs.existsSync(path.join(home, ".agents/skills/agentera"))).toBe(false);

    const projectAfterFirst = treeHashes(project);
    const homeAfterFirst = treeHashes(home);
    const rerunPreview = run(process.execPath, [...baseUpgradeArgs, "--dry-run"], fixture.root, env);
    expect(rerunPreview.status, `package boundary rerun preview failed:\n${rerunPreview.stdout}\n${rerunPreview.stderr}`).toBe(0);
    const rerunPlan = JSON.parse(rerunPreview.stdout) as any;
    expect(rerunPlan.phases.some((phase: any) => phase.name === "lifecycle")).toBe(false);
    expect(rerunPlan.phases.flatMap((phase: any) => phase.items).filter((item: any) => item.status === "pending"))
      .toEqual([]);

    const rerun = run(process.execPath, [...baseUpgradeArgs, "--yes"], fixture.root, env);
    expect(rerun.status, `package boundary rerun failed:\n${rerun.stdout}\n${rerun.stderr}`).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({
      mode: "apply",
      status: "noop",
      summary: { pending: 0, failed: 0, blocked: 0 },
    });
    expect(treeHashes(project)).toEqual(projectAfterFirst);
    expect(treeHashes(home)).toEqual(homeAfterFirst);
    expect(entityEnvelopes(project).map(({ id }) => id)).toEqual(entities.map(({ id }) => id));

    const primed = run(process.execPath, [bin, "prime", "--format", "json"], project, env);
    expect(primed.status, `package boundary prime failed:\n${primed.stderr}`).toBe(0);
    const payload = JSON.parse(primed.stdout) as {
      command: string;
      outcome: string;
      app_home: { source: string };
      app: { status: string };
      todo: Record<string, unknown>;
    };
    expect(payload).toMatchObject({
      command: "prime",
      outcome: "ok",
      app_home: { source: "bundled app" },
      app: { status: expect.any(String) },
    });
    expect(payload.app_home).not.toHaveProperty("home");
    expect(payload.app).not.toHaveProperty("sourceRoot");
    expect(payload.todo).toEqual(expect.objectContaining({
      critical: expect.any(Number),
      degraded: expect.any(Number),
      normal: expect.any(Number),
      annoying: expect.any(Number),
    }));
    expect(payload).not.toHaveProperty("issues");
    expect(primed.stderr).toBe("");

    const doctorHome = path.join(fixture.root, "post-migration-doctor-home");
    const doctorSkill = path.join(doctorHome, ".agents/skills/agentera");
    fs.mkdirSync(path.dirname(doctorSkill), { recursive: true });
    fs.cpSync(path.join(fixture.packageRoot, "bundle/skills/agentera"), doctorSkill, { recursive: true });
    const doctor = run(
      process.execPath,
      [bin, "doctor", "--format", "json", "--home", doctorHome, "--project", project, "--install-root", fixture.packageRoot],
      project,
      isolatedPackageEnv({ HOME: doctorHome, AGENTERA_BOOTSTRAP_SOURCE_ROOT: fixture.packageRoot, AGENTERA_UPDATE_CHANNEL: "development" }),
    );
    expect(doctor.status, `package boundary doctor failed:\n${doctor.stdout}\n${doctor.stderr}`).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ command: "doctor", status: "up_to_date", shared_skill: { status: "pass" } });

    const retiredPrimeField = run(
      process.execPath,
      [bin, "prime", "--fields", "issues", "--format", "json"],
      project,
      env,
    );
    expect(retiredPrimeField.status).toBe(2);
    expect(retiredPrimeField.stderr).toBe("");
    expect(JSON.parse(retiredPrimeField.stdout)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      status: "fail",
      error: {
        class: "invalid_choice",
        valid_values: ["todo"],
        recovery: expect.stringContaining("'todo'"),
      },
    });

    const sourced = run(process.execPath, [bin, "prime", "--fields", "app_home,app", "--format", "json"], project, env);
    expect(sourced.status, `package boundary sparse prime failed:\n${sourced.stderr}`).toBe(0);
    const sourcePayload = JSON.parse(sourced.stdout) as {
      app_home: { home: string; source: string };
      app: { sourceRoot: string };
    };
    expect(sourcePayload).toMatchObject({
      app_home: { home: expect.any(String), source: "bundled app" },
      app: { sourceRoot: expect.any(String) },
    });
    const bundleRoot = fs.realpathSync(path.join(fixture.packageRoot, "bundle"));
    for (const reportedSource of [sourcePayload.app_home.home, sourcePayload.app.sourceRoot]) {
      const appSource = fs.realpathSync(reportedSource);
      expect(
        isContained(bundleRoot, appSource),
        `package boundary escaped extracted bundle: source=${appSource} bundle=${bundleRoot}`,
      ).toBe(true);
    }
  });
});
