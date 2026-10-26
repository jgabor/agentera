import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createEntityAuthorityFixture } from "../helpers/entityAuthorityFixture.js";
import { main } from "../../src/cli/dispatch/index.js";
import type { OrientationState } from "../../src/cli/contracts/orientationState.js";
import { selectCapabilityHint } from "../../src/cli/orientation/capabilityHint.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { profileFreshnessSignal, type ProfileFreshnessResult, type ProfileValidityResult } from "../../src/cli/profileAcquisition.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));

let tmp: string;
let project: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "status-context-data-"));
  project = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  previousCwd = process.cwd();
  previousEnv = { AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT, AGENTERA_HOME: process.env.AGENTERA_HOME, HOME: process.env.HOME };
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
  process.env.HOME = home;
  process.chdir(project);
  createEntityAuthorityFixture(project, 25, AUTHORITY);
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[], stdin?: string): Record<string, any> {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], { out: (text) => (out += text), err: (text) => (err += text), ...(stdin === undefined ? {} : { stdin: () => stdin }) });
  expect(rc, err || out).toBe(0);
  return JSON.parse(out) as Record<string, any>;
}

const statusContext = () => run(["prime", "--context", "status"]).capability_context.context.status_context;

describe("status_context north star", () => {
  it("carries the whole north star on one line", () => {
    fs.writeFileSync(path.join(project, ".agentera/vision.yaml"), "project_name: Fixture\nnorth_star: |\n  Ship the whole idea,\n    every word of it.\n  Nothing is cut.\n");
    expect(statusContext().north_star).toBe("Ship the whole idea, every word of it. Nothing is cut.");
  });

  it("leaves the north star absent without a vision", () => {
    expect(fs.existsSync(path.join(project, ".agentera/vision.yaml"))).toBe(false);
    expect(statusContext()).not.toHaveProperty("north_star");
  });
});

describe("profile freshness", () => {
  const valid: ProfileValidityResult = { status: "valid", class: "valid", recovery: null };
  const fresh = (days: number | null, state: ProfileFreshnessResult["state"]): ProfileFreshnessResult => ({ state, days_since_generated: days, stale_threshold_days: 7, generated_date: null, validated_date: null });

  it("reads expiring inside the window and expired past the threshold", () => {
    expect(profileFreshnessSignal(valid, fresh(5, "current"))).toBe("expiring");
    expect(profileFreshnessSignal(valid, fresh(7, "stale"))).toBe("expired");
  });

  it("is absent for a current, unknown or absent profile", () => {
    expect(profileFreshnessSignal(valid, fresh(4, "current"))).toBeNull();
    expect(profileFreshnessSignal(valid, fresh(null, "unknown"))).toBeNull();
    expect(profileFreshnessSignal({ status: "absent", class: "absent", recovery: null }, fresh(9, "stale"))).toBeNull();
  });
});

describe("unused-capability hint", () => {
  const state = (overrides: { health?: boolean; docs?: boolean; objective?: boolean; decisions?: number; recommended?: string; northStar?: string | null }): OrientationState =>
    ({
      north_star: overrides.northStar === undefined ? "Ship it." : overrides.northStar,
      health: { exists: overrides.health ?? true },
      docs: { exists: overrides.docs ?? true },
      objective: { exists: overrides.objective ?? true },
      history: { decisions: { counts: { total: overrides.decisions ?? 1 } } },
      next_action: { recommended: { capability: overrides.recommended ?? "build" }, alternatives: [] },
    }) as unknown as OrientationState;

  it("names the first unused capability with a state-based reason when attention is empty", () => {
    expect(selectCapabilityHint(state({ health: false, objective: false }), [])).toEqual({ capability: "audit", reason: "No health audit has been recorded." });
    expect(selectCapabilityHint(state({ decisions: 0 }), [])).toEqual({ capability: "discuss", reason: "No decision has been recorded." });
  });

  it("skips the recommended capability, and gives nothing with attention or when all are used", () => {
    expect(selectCapabilityHint(state({ health: false, docs: false, recommended: "audit" }), [])).toEqual({ capability: "document", reason: "No documentation index exists." });
    expect(selectCapabilityHint(state({ health: false }), ["normal: something"])).toBeNull();
    expect(selectCapabilityHint(state({}), [])).toBeNull();
  });

  it("gives no hint before the vision has a north star", () => {
    expect(selectCapabilityHint(state({ health: false, northStar: null }), [])).toBeNull();
  });

  it("adds no hint to a direct capability route", () => {
    const routed = run(["prime", "--input", "-"], JSON.stringify({ version: "agentera.route_request.v1", request: "/agentera build" }));
    expect(JSON.stringify(routed)).not.toContain("capability_hint");
  });
});

describe("status first run", () => {
  it("carries the init preview in the routed bare start, so status needs no second call", () => {
    const fresh = path.join(tmp, "fresh");
    fs.mkdirSync(fresh);
    execFileSync("git", ["init", "-q"], { cwd: fresh });
    process.chdir(fresh);
    const routed = run(["prime", "--input", "-"], JSON.stringify({ version: "agentera.route_request.v1", request: "/agentera" }));
    const context = routed.start.capability_context.context.status_context;
    expect(context.next_action.object).toBe("Agentera init preview");
    expect(context.fresh_start).toEqual({
      about: expect.any(String),
      writes: [{ path: ".agentera/state-mode.yaml", action: "create", content: { schemaVersion: "agentera.stateMode.v1", mode: "entities" } }],
      apply_command: expect.stringMatching(/ init --project .+ --yes$/),
    });
    expect(context).not.toHaveProperty("capability_hint");
  });

  it("drops the init preview once the project is initialized", () => {
    expect(statusContext()).not.toHaveProperty("fresh_start");
  });
});

describe("status instructions and data", () => {
  it("names only status_context fields the capsule can carry", () => {
    const served = CAPABILITY_INSTRUCTIONS.status;
    for (const field of ["north_star", "health", "todo", "plan", "profile_freshness", "progress.latest.what", "attention", "next_action", "capability_hint", "fresh_start.about", "fresh_start.writes", "fresh_start.apply_command", "project_integration.recommendation"]) expect(served, field).toContain(`\`${field}`);
    for (const retired of ["profile.validity", "app.status", "health.stale", "fresh_start.writes` in bare prime", "Priority order"]) expect(served, retired).not.toContain(retired);
  });
});

describe("status capsule fit", () => {
  it("drops self-read metadata and repeated state from status only", () => {
    const status = run(["prime", "--context", "status"]);
    const context = status.capability_context.context;
    expect(context).not.toHaveProperty("first_invocation_read");
    expect(context.status_context).not.toHaveProperty("state_presence");
    expect(context.status_context.todo).not.toHaveProperty("detail");
    expect(context.status_context.health).not.toHaveProperty("trajectory");
    expect(context.status_context).not.toHaveProperty("profile");

    expect(run(["prime", "--context", "build"]).capability_context.context.first_invocation_read).toMatchObject({ value: "prime_context" });
    const bare = run(["prime"]);
    expect(bare).toHaveProperty("state_presence");
    expect(bare.todo).toHaveProperty("detail");
  });
});
