import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { PRIME_STRUCTURED_FIELDS } from "../../src/cli/stateQuery.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const POLICY_PATH = path.join(REPO_ROOT, "references/cli/prime-consumer-compatibility.yaml");

interface Assert {
  path: string;
  equals: unknown;
}
interface ConditionalNestedField {
  path: string;
  /** Dotted path whose truthiness/non-null governs whether `path` is required. */
  present_when: string;
}
interface ConsumerFixture {
  consumer: string;
  depends_on: string[];
  rationale?: string;
  // Executable-contract metadata consumed by the runtime-assertion tests:
  executable_command?: string;
  nested_fields?: string[];
  absent_fields?: string[];
  conditional_nested_fields?: ConditionalNestedField[];
  asserts?: Assert[];
}

interface DriftDocument {
  /** Repo-relative path to a documentation file that governs a consumer field name. */
  path: string;
  /** The canonical field name the document must keep pointing consumers at. */
  must_contain: string;
  /** A retired field name the document must no longer send consumers to. */
  must_not_contain: string;
}

interface DocumentationDrift {
  canonical_field: string;
  retired_field: string;
  scanned_documents: DriftDocument[];
}

interface OmissionEntry {
  field: string;
  omitted_when: string;
  recovery_command: string;
}
interface DefaultEmissionOmissionContract {
  omitted_when_default: OmissionEntry[];
  never_omitted: string[];
}
interface Policy {
  declared_available_fields: string[];
  fixtures: { pass: ConsumerFixture[]; fail: ConsumerFixture[] };
  documentation_drift?: DocumentationDrift;
  default_emission_omission_contract?: DefaultEmissionOmissionContract;
  public_output_policy: {
    deprecated_alias_rule: {
      field: string;
      retained_fields: string[];
      excluded_fields: string[];
    };
  };
}

function loadPolicy(): Policy {
  return YAML.parse(fs.readFileSync(POLICY_PATH, "utf8")) as Policy;
}

/** Top-level field name from a possibly-dotted consumer selector (e.g.
 *  `profile.status` -> `profile`). Consumers depend on a top-level prime field;
 *  sub-field shape is owned by the field contract, not the compatibility gate. */
function topLevel(field: string): string {
  return field.split(".")[0];
}

/** Boundary check: a consumer passes when every depended-on top-level field is
 *  declared in the policy. Undeclared dependencies are returned as violations. */
function boundaryViolations(dependsOn: string[], declared: string[]): string[] {
  const declaredSet = new Set(declared);
  return dependsOn.map(topLevel).filter((field) => !declaredSet.has(field));
}

/** Read a dotted path from a JSON payload. Returns `undefined` when any segment
 *  is absent, mirroring how a consumer experiences a missing field. */
function getPath(payload: unknown, dotted: string): unknown {
  let cur: unknown = payload;
  for (const segment of dotted.split(".")) {
    if (cur && typeof cur === "object" && segment in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** `present_when` is truthy when the gate path exists and is neither null nor
 *  false (e.g. health.exists===true, plan.first_pending!==null). */
function isTruthy(payload: unknown, dotted: string): boolean {
  const value = getPath(payload, dotted);
  return value !== undefined && value !== null && value !== false;
}

/** Parse a documented prime startup command into cmdPrime args. Supports the
 *  shapes the inventory declares: `agentera prime [--context <cap>] [--format json]
 *  [--fields <field>]`. Keeps the test honest against the documented command
 *  string rather than a separately-maintained args object. */
function parsePrimeCommand(cmd: string): Parameters<typeof cmdPrime>[0] {
  const tokens = cmd.trim().split(/\s+/);
  const args: Parameters<typeof cmdPrime>[0] = { command: "prime" };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "agentera" || token === "prime") continue;
    if (token === "--context") args.context = tokens[++i];
    else if (token === "--format") args.format = tokens[++i];
    else if (token === "--fields") args.fields = tokens[++i];
    else if (token === "--dashboard" || token === "--orientation") args.dashboard = true;
  }
  return args;
}

let tmp: string;
let home: string;
let appHome: string;
let prevCwd: string;
let prevHome: string | undefined;
let prevAgenteraHome: string | undefined;
let prevBootstrapSourceRoot: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-compat-"));
  home = path.join(tmp, "home");
  appHome = path.join(home, "agentera");
  fs.mkdirSync(appHome, { recursive: true });
  prevCwd = process.cwd();
  // Capture prior values so afterEach restores (not deletes) the environment,
  // so this suite never leaks env state into sibling tests or the contributor shell.
  prevHome = process.env.HOME;
  prevAgenteraHome = process.env.AGENTERA_HOME;
  prevBootstrapSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = appHome;
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  process.chdir(project);
});

afterEach(() => {
  process.chdir(prevCwd);
  // Restore prior env values rather than deleting them.
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevAgenteraHome === undefined) delete process.env.AGENTERA_HOME;
  else process.env.AGENTERA_HOME = prevAgenteraHome;
  if (prevBootstrapSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = prevBootstrapSourceRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capture(args: Parameters<typeof cmdPrime>[0]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = cmdPrime(
    { ...args, home: args.home ?? home, installRoot: args.installRoot ?? appHome },
    { out: (t) => (out += t), err: (t) => (err += t) },
  );
  return { rc, out, err };
}

/** Run a documented prime startup command against the real runtime and return
 *  the parsed JSON payload. Fails the test loudly if the command does not exit 0. */
function runPrimePayload(cmd: string): { rc: number; out: string; err: string; payload: unknown } {
  const result = capture(parsePrimeCommand(cmd));
  expect(result.rc, `prime command \`${cmd}\` must exit 0`).toBe(0);
  expect(result.out, `prime command \`${cmd}\` must emit JSON on stdout`).not.toBe("");
  return { ...result, payload: JSON.parse(result.out) };
}

describe("prime consumer compatibility boundary (Plan Task 1)", () => {
  const policy = loadPolicy();

  describe("acceptance 1 + 3: every documented consumer is declared against the boundary", () => {
    it.each(policy.fixtures.pass)(
      "pass fixture: $consumer depends only on declared fields",
      (fixture: ConsumerFixture) => {
        const violates = boundaryViolations(fixture.depends_on, policy.declared_available_fields);
        expect(violates, `consumer ${fixture.consumer} depends on undeclared fields`).toEqual([]);
      },
    );
  });

  describe("acceptance 2 + 4: undeclared dependencies fail visibly", () => {
    it.each(policy.fixtures.fail)(
      "fail fixture: $consumer is rejected by the boundary check",
      (fixture: ConsumerFixture) => {
        const violates = boundaryViolations(fixture.depends_on, policy.declared_available_fields);
        expect(violates).toEqual(fixture.depends_on.map(topLevel));
      },
    );

    it("retired field `bundle` fails visibly via --fields with a correction listing the canonical replacement", () => {
      // Genuine fail-visible test: runs the real `prime --fields bundle` command
      // and asserts the runtime rejects the retired field with an Available-fields
      // correction surfacing the v3 canonical replacements (app_home, app).
      const { rc, err, out } = capture({ command: "prime", format: "json", fields: "bundle" });
      expect(rc).toBe(1);
      expect(err).toContain("unsupported field 'bundle'");
      expect(err).toContain("Available fields:");
      expect(err).toContain("app_home");
      expect(err).toContain("app");
      // The retired field must not be silently emitted.
      expect(out).toBe("");
    });
  });

  describe("acceptance 1 + 4 (executable): every pass consumer's contract holds against the real runtime payload", () => {
    // Replaces YAML-vs-YAML-only verification: each documented consumer's real
    // startup command is executed and its consumed fields (including nested
    // capability-context requirements) are asserted against the emitted JSON.
    it.each(policy.fixtures.pass.filter((f) => f.executable_command))(
      "executable consumer: $consumer",
      (fixture: ConsumerFixture) => {
        const { payload } = runPrimePayload(fixture.executable_command!);

        // 1. Every depended-on top-level field is present in the emitted payload.
        for (const field of fixture.depends_on) {
          expect(getPath(payload, topLevel(field)), `${fixture.consumer}: missing top-level field ${field}`).not.toBeUndefined();
        }

        // 2. Always-present nested structural fields are emitted (e.g. the
        //    capability_context pointer, app_home.source, instructions).
        for (const nested of fixture.nested_fields ?? []) {
          const value = getPath(payload, nested);
          expect(value, `${fixture.consumer}: missing nested field ${nested}`).not.toBeUndefined();
          if (nested === "capability_context.instructions") {
            expect(typeof value).toBe("string");
            expect((value as string).length, `${fixture.consumer}: instructions must be non-empty`).toBeGreaterThan(0);
          }
        }

        // 3. Documented-but-not-emitted fields stay absent (reconciliation guard:
        //    the runtime emits `instructions`, never the stale `prose`).
        for (const absent of fixture.absent_fields ?? []) {
          expect(getPath(payload, absent), `${fixture.consumer}: ${absent} must not be emitted`).toBeUndefined();
        }

        // 4. Conditional nested fields preserve missing-versus-empty semantics:
        //    present exactly when their governing parent is active/non-null.
        for (const cond of fixture.conditional_nested_fields ?? []) {
          if (isTruthy(payload, cond.present_when)) {
            expect(getPath(payload, cond.path), `${fixture.consumer}: ${cond.path} must be present when ${cond.present_when}`).not.toBeUndefined();
          } else {
            expect(getPath(payload, cond.path), `${fixture.consumer}: ${cond.path} must be absent when ${cond.present_when} is inactive`).toBeUndefined();
          }
        }

        // 5. Explicit value assertions (e.g. packaging gate: command="prime", status="ok").
        for (const assertion of fixture.asserts ?? []) {
          expect(getPath(payload, assertion.path), `${fixture.consumer}: ${assertion.path}`).toBe(assertion.equals);
        }
      },
    );
  });

  describe("runtime reconciliation: the policy stays honest against the CLI", () => {
    it("the policy declares exactly the fields the prime selector accepts", () => {
      // Every declared field must be selectable without error; any undeclared
      // selector must fail. This binds the YAML authority to emitPrime's
      // availablePrimeFields so Task 2 cannot drift them independently.
      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const field of policy.declared_available_fields) {
        const { rc } = capture({ command: "prime", format: "json", fields: field });
        if (rc === 0) accepted.push(field);
        else rejected.push(field);
      }
      expect(rejected, "declared fields must be selectable").toEqual([]);
      expect(accepted.sort()).toEqual([...policy.declared_available_fields].sort());

      // A field outside the declared set must be rejected.
      expect(capture({ command: "prime", format: "json", fields: "not_a_real_field" }).rc).toBe(1);
    });

    it("default bare prime emits every required field and omits inactive conditional defaults", () => {
      // Advertised selectable fields (declared_available_fields) may be broader
      // than the keys present in a given bare prime response: the declaration is
      // the union of selectable surfaces, not a promise every one is emitted on
      // every call. Required fields are always present; conditional top-level
      // fields documented in default_emission_omission_contract are omitted
      // when they carry only default/inactive payload (recovered via
      // state_presence + a named command). Explicit `--fields <name>` keeps the
      // full payload (see the AC3 explicit-recovery test).
      const { rc, out } = capture({ command: "prime", format: "json" });
      expect(rc).toBe(0);
      const payload = JSON.parse(out);
      const emitted = new Set(Object.keys(payload));
      const omittable = (policy.default_emission_omission_contract?.omitted_when_default ?? []).map(
        (e: { field: string }) => e.field,
      );
      // Required fields must be present.
      const missingRequired = policy.declared_available_fields.filter(
        (field) => field !== "capability_context" && !omittable.includes(field) && !emitted.has(field),
      );
      expect(missingRequired, "required fields absent from default emission").toEqual([]);
      // state_presence is never omitted — it owns missing-vs-empty semantics.
      expect(emitted, "state_presence must always be emitted").toContain("state_presence");
      // On fresh state every omittable conditional field is in its default state,
      // so each must be omitted from the default briefing.
      const leakedDefaults = omittable.filter((field) => emitted.has(field));
      expect(leakedDefaults, "inactive conditional defaults must be omitted on fresh state").toEqual([]);
    });
  });

  describe("documentation drift guard: active consumer guidance cannot drift back to `prose`", () => {
    // The capability_context_dispatcher executable fixture proves the runtime
    // emits a non-empty `capability_context.instructions` and never `prose`.
    // This block guards the other half of the contract: the human-facing
    // consumer guidance that tells consumers which field to read. It must keep
    // pointing at `instructions` so a future doc edit cannot silently resurrect
    // the retired `prose` field name the runtime does not emit.
    const drift = policy.documentation_drift;
    it("the policy declares a documentation drift guard over the canonical and retired field names", () => {
      expect(drift, "policy must declare a documentation_drift section").toBeDefined();
      expect(drift!.canonical_field).toBe("capability_context.instructions");
      expect(drift!.retired_field).toBe("capability_context.prose");
      expect(drift!.scanned_documents.length, "at least one document must be guarded").toBeGreaterThan(0);
    });

    it.each(drift?.scanned_documents ?? [])(
      "documentation: $path keeps the canonical field and drops the retired field",
      (doc: DriftDocument) => {
        const file = path.join(REPO_ROOT, doc.path);
        const content = fs.readFileSync(file, "utf8");
        expect(
          content,
          `${doc.path} must document the canonical ${doc.must_contain} field`,
        ).toContain(doc.must_contain);
        expect(
          content,
          `${doc.path} must not send consumers to the retired ${doc.must_not_contain} field`,
        ).not.toContain(doc.must_not_contain);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Task 2: publish one non-redundant prime contract. These tests bind the
  // acceptance criteria to the live runtime so the four-way drift documented by
  // Task 1 cannot recur: schema discovery, the emitted JSON source_contract,
  // the text briefing, and the agent-ready-state contract all derive from one
  // authority (PRIME_STRUCTURED_FIELDS in stateQuery.ts).
  // -------------------------------------------------------------------------
  describe("Task 2 AC1: schema discovery and prime output derive from one authority", () => {
    it("prime output source_contract.fields equals the canonical authority set", () => {
      const { payload } = runPrimePayload("agentera prime --format json");
      const fields = (getPath(payload, "source_contract.fields") as string[]) ?? [];
      expect([...fields].sort(), "emitted source_contract.fields must equal PRIME_STRUCTURED_FIELDS").toEqual(
        [...PRIME_STRUCTURED_FIELDS].sort(),
      );
    });

    it("schema discovery advertises the canonical prime set plus the context-only pointer only", () => {
      const schema = buildSchemaPayload("schema") as Record<string, unknown>;
      const commands = schema.commands as Array<{ name: string; structured_fields: string[] }>;
      const prime = commands.find((c) => c.name === "prime");
      const advertised = prime?.structured_fields ?? [];
      // Every canonical field is advertised for discovery.
      for (const field of PRIME_STRUCTURED_FIELDS) {
        expect(advertised, `schema must advertise canonical field ${field}`).toContain(field);
      }
      // The sole advertised addition is the context-only capability_context
      // pointer; the deprecated `issues` alias is NOT advertised as a structured
      // field (one canonical representation — `todo` is canonical).
      const extras = advertised.filter((f) => !PRIME_STRUCTURED_FIELDS.includes(f));
      expect(extras).toEqual(["capability_context"]);
      // fields_by_command.status derives from the same authority.
      const statusFbc = getPath(schema, "structured_output.fields_by_command.status") as string[];
      expect([...statusFbc].sort()).toEqual([...PRIME_STRUCTURED_FIELDS].sort());
    });

    it("schema discovery and prime output advertise the same canonical set", () => {
      const { payload } = runPrimePayload("agentera prime --format json");
      const emitted = ((getPath(payload, "source_contract.fields") as string[]) ?? []).slice().sort();
      const schema = buildSchemaPayload("schema") as Record<string, unknown>;
      const commands = schema.commands as Array<{ name: string; structured_fields: string[] }>;
      const prime = commands.find((c) => c.name === "prime");
      const advertised = (prime?.structured_fields ?? [])
        .filter((f) => f !== "capability_context")
        .slice()
        .sort();
      expect(advertised, "schema discovery and prime output must advertise the same canonical set").toEqual(emitted);
    });
  });

  describe("Task 2 AC2: semantically duplicate startup values emit one canonical representation", () => {
    it("the deprecated `issues` alias preserves TODO counts without duplicating canonical detail", () => {
      const { payload, err } = runPrimePayload("agentera prime --format json");
      const rule = loadPolicy().public_output_policy.deprecated_alias_rule;
      const fields = (getPath(payload, "source_contract.fields") as string[]) ?? [];
      // `todo` is the canonical representation; `issues` is not a published field.
      expect(fields).toContain("todo");
      expect(fields).not.toContain("issues");
      // `issues` remains a count-only transition alias. Bounded detail belongs
      // only to canonical `todo` so the brief does not budget it twice.
      expect(rule).toMatchObject({ field: "issues", retained_fields: ["critical", "degraded", "normal", "annoying"] });
      expect(Object.keys(getPath(payload, "issues") as Record<string, unknown>)).toEqual(rule.retained_fields);
      expect(getPath(payload, "issues")).toEqual(
        Object.fromEntries(rule.retained_fields.map((field) => [field, getPath(payload, `todo.${field}`)])),
      );
      for (const field of rule.excluded_fields) expect(getPath(payload, `issues.${field}`)).toBeUndefined();
      expect(getPath(payload, "todo.detail")).toBeDefined();
      expect(err).toContain("deprecated");
      expect(err).toContain("3.0.0 stable cut");
    });

    it("the text briefing advertises the same canonical field set as the JSON contract", () => {
      const { rc, out } = capture({ command: "prime", format: "text" });
      expect(rc).toBe(0);
      const fieldsLine = out.split("\n").find((l) => l.startsWith("- fields="));
      expect(fieldsLine, "text briefing must print a source_contract fields line").toBeDefined();
      const advertised = fieldsLine!.replace("- fields=", "").split(",").map((s) => s.trim()).filter(Boolean);
      expect(advertised.sort(), "text and JSON must advertise one canonical representation").toEqual(
        [...PRIME_STRUCTURED_FIELDS].sort(),
      );
    });

    it("the agent-ready-state contract hej.fields mirror the canonical authority set", () => {
      // The documented consumer contract must not drift from the runtime authority.
      const contractPath = path.join(REPO_ROOT, "references/cli/agent-ready-state-contract.yaml");
      const parsed = YAML.parse(fs.readFileSync(contractPath, "utf8")) as unknown;
      // Recursively collect every hej.fields list (the contract documents hej
      // under both structured_output.envelope and field_selection.fields_by_command).
      const hejFieldLists: string[][] = [];
      (function collect(node: unknown): void {
        if (Array.isArray(node)) {
          for (const child of node) collect(child);
          return;
        }
        if (node && typeof node === "object") {
          const obj = node as Record<string, unknown>;
          if (obj.hej && typeof obj.hej === "object" && Array.isArray((obj.hej as Record<string, unknown>).fields)) {
            hejFieldLists.push((obj.hej as Record<string, unknown>).fields as string[]);
          }
          for (const child of Object.values(obj)) collect(child);
        }
      })(parsed);
      expect(hejFieldLists.length, "contract must document at least one hej.fields list").toBeGreaterThan(0);
      for (const hejFields of hejFieldLists) {
        expect([...hejFields].sort(), "hej.fields must mirror PRIME_STRUCTURED_FIELDS").toEqual(
          [...PRIME_STRUCTURED_FIELDS].sort(),
        );
        // The retired `bundle` field must not survive in the documented contract.
        expect(hejFields).not.toContain("bundle");
        // The deprecated `issues` alias is not a documented canonical field: it
        // is emitted by default as a transition alias (excluded only from the
        // advertised set), but the agent-ready-state contract documents `todo`.
        expect(hejFields).not.toContain("issues");
      }
    });
  });

  describe("Task 2 AC3: absent/inactive optional state omits default-only payload without ambiguity", () => {
    it("state_presence is always emitted and owns missing-vs-empty semantics", () => {
      const { payload } = runPrimePayload("agentera prime --format json");
      expect(payload, "state_presence must always be present (never omitted)").toHaveProperty("state_presence");
      const presence = getPath(payload, "state_presence") as Record<string, unknown>;
      expect(presence, "state_presence.any_active carries the active signal").toHaveProperty("any_active");
      expect(presence, "state_presence.absence carries the missing-vs-empty signal").toHaveProperty("absence");
    });

    it("conditional nested detail is omitted (not a default blob) when its governing parent is inactive", () => {
      const { payload } = runPrimePayload("agentera prime --format json");
      // progress.latest.* is gated on progress.latest; omitted when inactive.
      if (!isTruthy(payload, "progress.latest")) {
        expect(getPath(payload, "progress.latest.number"), "progress.latest.number omitted when progress.latest inactive").toBeUndefined();
      }
      // health.* diagnostic detail is gated on health.exists; grade omitted when absent.
      if (!isTruthy(payload, "health.exists")) {
        expect(getPath(payload, "health.grade"), "health.grade omitted when health absent").toBeUndefined();
      }
      // plan.first_pending.name is gated on plan.first_pending; omitted when no pending task.
      if (!isTruthy(payload, "plan.first_pending")) {
        expect(getPath(payload, "plan.first_pending.name"), "plan.first_pending.name omitted when no pending task").toBeUndefined();
      }
    });

    // ----- Top-level omission (fresh/empty/inactive) -----
    // The audit found AC3 only covered nested omission. These fixtures prove the
    // top-level default-only payloads (v1_migration, docs, objective) are omitted
    // on a fresh project and that state_presence keeps the absence unambiguous.
    it("fresh state omits the top-level v1_migration, docs, and objective default-only payloads", () => {
      const { payload } = runPrimePayload("agentera prime --format json");
      // Fresh project: no v1 artifacts, no docs mapping file, no objective dir.
      expect(getPath(payload, "v1_migration"), "v1_migration omitted when no migration detected").toBeUndefined();
      expect(getPath(payload, "docs"), "docs omitted when no docs mapping exists").toBeUndefined();
      expect(getPath(payload, "objective"), "objective omitted when none active").toBeUndefined();
    });

    it("omitted top-level conditional fields stay selectable and advertised (absence is not ambiguous)", () => {
      const { payload } = runPrimePayload("agentera prime --format json");
      // The fields are declared in source_contract.fields — a consumer knows the
      // field is a valid selectable surface even though it was omitted.
      const fields = (getPath(payload, "source_contract.fields") as string[]) ?? [];
      expect(fields, "v1_migration stays advertised even when omitted").toContain("v1_migration");
      expect(fields, "docs stays advertised even when omitted").toContain("docs");
      expect(fields, "objective stays advertised even when omitted").toContain("objective");
      // state_presence carries the missing-vs-empty signals for the families it owns.
      const presence = getPath(payload, "state_presence") as Record<string, unknown>;
      const available = presence.available as Record<string, boolean>;
      expect(available.docs, "state_presence.available.docs=false disambiguates the docs omission").toBe(false);
      const active = presence.active as Record<string, boolean>;
      expect(active.objective, "state_presence.active.objective=false disambiguates the objective omission").toBe(false);
    });

    it("omitted conditional fields are recoverable via the policy's named recovery commands", () => {
      const contract = policy.default_emission_omission_contract;
      expect(contract, "policy must document the default_emission_omission_contract").toBeDefined();
      for (const entry of contract!.omitted_when_default) {
        expect(typeof entry.recovery_command, `${entry.field} needs a named recovery command`).toBe("string");
        expect(entry.recovery_command as string).toMatch(/agentera/);
      }
    });

    it("explicit `--fields <omitted>` selection still returns the field (default omission never confuses recovery)", () => {
      // The default briefing omits inactive conditional fields, but a consumer
      // that explicitly selects one must get the full payload entry (not an
      // absence). This binds the omission contract to the recovery path.
      for (const field of ["v1_migration", "docs", "objective"]) {
        const { rc, out } = capture({ command: "prime", format: "json", fields: field });
        expect(rc, `--fields ${field} must exit 0`).toBe(0);
        const selected = JSON.parse(out);
        expect(selected, `--fields ${field} must return the field even when default`).toHaveProperty(field);
        expect(selected, `--fields ${field} always carries command`).toHaveProperty("command");
        expect(selected, `--fields ${field} always carries status`).toHaveProperty("status");
      }
    });

    // ----- Present-state fixtures -----
    // The inverse contract: when a conditional field IS present/active, it must
    // appear in the default briefing (not be over-omitted).
    function writeV1Artifact(): void {
      const agenteraDir = path.join(process.cwd(), ".agentera");
      fs.mkdirSync(agenteraDir, { recursive: true });
      fs.writeFileSync(path.join(agenteraDir, "PROGRESS.md"), "# progress\n");
    }
    it("present v1 migration is emitted (detected=true) and state recovers it directly", () => {
      writeV1Artifact();
      const { payload } = runPrimePayload("agentera prime --format json");
      const v1 = getPath(payload, "v1_migration") as Record<string, unknown>;
      expect(v1, "v1_migration emitted when detected").toBeDefined();
      expect(v1.detected, "v1_migration.detected is true when v1 artifacts present").toBe(true);
    });

  });

  describe("Task 2 AC4: omitted diagnostic/writer detail has a named authoritative recovery command", () => {
    it("source_contract names the recovery commands for omitted context, writer, and startup detail", () => {
      const { payload } = runPrimePayload("agentera prime --format json");
      const sc = getPath(payload, "source_contract") as Record<string, unknown>;
      // Omitted capability-context detail: fetch_command.
      const cc = sc.capability_context as Record<string, unknown>;
      expect(typeof cc.fetch_command, "capability_context.fetch_command names the recovery command").toBe("string");
      expect(cc.fetch_command as string).toContain("agentera prime --context");
      // Omitted writer detail: artifact_writes discovery/explain commands.
      const aw = sc.artifact_writes as Record<string, unknown>;
      expect(typeof aw.discovery_command, "artifact_writes.discovery_command names the recovery command").toBe("string");
      expect(aw.discovery_command as string).toContain("agentera schema");
      // Omitted startup detail: cli_fallback commands.
      const cs = sc.capability_startup as Record<string, unknown>;
      expect(Array.isArray(cs.cli_fallback), "capability_startup.cli_fallback is a named recovery command list").toBe(true);
      expect((cs.cli_fallback as string[]).join(" ")).toMatch(/agentera/);
    });
  });
});
