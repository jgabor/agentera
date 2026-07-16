import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";

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

interface Policy {
  declared_available_fields: string[];
  fixtures: { pass: ConsumerFixture[]; fail: ConsumerFixture[] };
  documentation_drift?: DocumentationDrift;
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

    it("default bare prime emits every declared field except the --context-only capability_context", () => {
      const { rc, out } = capture({ command: "prime", format: "json" });
      expect(rc).toBe(0);
      const emitted = new Set(Object.keys(JSON.parse(out)));
      const missing = policy.declared_available_fields.filter(
        (field) => field !== "capability_context" && !emitted.has(field),
      );
      expect(missing, "declared fields absent from default emission").toEqual([]);
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
});
