import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const POLICY_PATH = path.join(REPO_ROOT, "references/cli/prime-consumer-compatibility.yaml");

interface ConsumerFixture {
  consumer: string;
  depends_on: string[];
  rationale?: string;
}

interface Policy {
  declared_available_fields: string[];
  fixtures: { pass: ConsumerFixture[]; fail: ConsumerFixture[] };
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

let tmp: string;
let home: string;
let appHome: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-compat-"));
  home = path.join(tmp, "home");
  appHome = path.join(home, "agentera");
  fs.mkdirSync(appHome, { recursive: true });
  prevCwd = process.cwd();
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = appHome;
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  process.chdir(project);
});

afterEach(() => {
  process.chdir(prevCwd);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
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

describe("prime consumer compatibility boundary (Plan Task 1)", () => {
  const policy = loadPolicy();

  describe("acceptance 1 + 3: every documented consumer passes the policy", () => {
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
      const { rc, err, out } = capture({ command: "prime", format: "json", fields: "bundle" });
      expect(rc).toBe(1);
      expect(err).toContain("unsupported field 'bundle'");
      expect(err).toContain("Available fields:");
      // The correction must surface the v3 canonical replacements for `bundle`.
      expect(err).toContain("app_home");
      expect(err).toContain("app");
      // The retired field must not be silently emitted.
      expect(out).toBe("");
    });
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
});
