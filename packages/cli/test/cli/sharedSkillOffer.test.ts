import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/dispatch.js";
import { runHostSkillLifecycle, loadHostSkillSource } from "../../src/setup/hostSkillLifecycle.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
const question = "Agentera’s installed skill needs an update. Update it now? Your project files will not change.";
let temp: string, home: string, app: string, project: string, target: string, previousCwd: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function snapshot(root = temp): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (file: string) => {
    const stat = fs.lstatSync(file);
    result[path.relative(root, file)] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : stat.isDirectory() ? "directory" : fs.readFileSync(file).toString("base64");
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  };
  visit(root);
  return result;
}
function capture(args: string[]) {
  let out = "",
    err = "";
  const code = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { code, out, err, payload: out ? JSON.parse(out) : null };
}
function apply(offer: { apply_command: string }, answer?: string) {
  if (answer !== "Yes") return null;
  return capture(offer.apply_command.split(" ").slice(3));
}
function legacy() {
  write(path.join(target, "SKILL.md"), "old bootstrap");
  write(path.join(target, "companion.yaml"), "retain: true\n");
}
function ownedStale() {
  const source = path.join(temp, "older-runtime");
  for (const relative of ["registry.json", "references/adapters/package-registry.yaml", "skills/agentera/SKILL.md"]) write(path.join(source, relative), fs.readFileSync(path.join(repo, relative), "utf8"));
  fs.appendFileSync(path.join(source, "skills/agentera/SKILL.md"), "\nOlder installed guidance.\n");
  expect(runHostSkillLifecycle({ home, appHome: app, sourceRoot: source, apply: true }).status).toBe("success");
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-skill-offer-"));
  home = path.join(temp, "home");
  app = path.join(temp, "app");
  project = path.join(temp, "project");
  target = path.join(home, ".agents/skills/agentera");
  fs.mkdirSync(home);
  write(path.join(project, "project.txt"), "project must not change");
  vi.stubEnv("HOME", home);
  vi.stubEnv("AGENTERA_HOME", app);
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", repo);
  vi.stubEnv("AGENTERA_PROFILE_DIR", path.join(temp, "profile"));
  vi.stubEnv("PROFILERA_PROFILE_DIR", path.join(temp, "profile"));
  previousCwd = process.cwd();
  process.chdir(project);
});
afterEach(() => {
  process.chdir(previousCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("one-confirmation shared-skill startup offer", () => {
  it("keeps the complete default status capsule usable with a populated project and legacy upgrade offer", () => {
    legacy();
    write(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const entity = (family: string, kind: string, id: string, record: unknown) => write(path.join(project, `.agentera/entities/${family}/${kind}/${id}.yaml`), JSON.stringify({ id, artifact: family, record }));
    const detail = "Preserve project state and verify the complete startup and installation workflow. ".repeat(4);
    entity("plan", "plan", "aaaaaaaaaa", {
      header: {
        title: "One-confirmation Agentera skill upgrades",
        status: "open",
        level: "full",
        created: "2026-09-21",
      },
      what: detail,
      why: detail,
      scope: { included: ["Shared-skill offers"], excluded: ["Project mutation"] },
    });
    entity("plan", "plan_task", "bbbbbbbbbb", {
      plan: "aaaaaaaaaa",
      name: detail,
      status: "in_progress",
      depends_on: [],
      acceptance: [detail],
    });
    entity("progress", "progress_cycle", "cccccccccc", {
      timestamp: "2026-09-21 00:00",
      type: "feat",
      phase: "build",
      what: detail,
      verified: detail,
      next: detail,
      context: { intent: detail, constraints: detail, scope: detail, unknowns: detail },
    });
    entity("health", "health_audit", "dddddddddd", {
      date: "2026-09-21",
      trajectory: "stable",
      dimensions: ["test_health"],
      grades: { test_health: "A" },
      findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    });
    const before = snapshot();
    const result = capture(["prime", "--context", "status"]);
    expect(result.code, result.err).toBe(0);
    expect(Buffer.byteLength(result.out)).toBeLessThanOrEqual(22500);
    expect(result.payload.shared_skill.upgrade_offer.question).toBe(question);
    expect(result.payload.capability_context.instructions).toBe(CAPABILITY_INSTRUCTIONS.status);
    expect(result.payload.capability_context.context.status_context.plan.id).toBe("aaaaaaaaaa");
    expect(result.payload.capability_context.context.status_context.progress.exists).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(apply(result.payload.shared_skill.upgrade_offer, "Yes")!.payload.status).toBe("success");
  });
  it.each([[[]], [["--context", "status"]]])("carries an executable offer in complete default prime %j output and verifies Yes", (flags) => {
    legacy();
    const before = snapshot();
    const startup = capture(["prime", ...flags]);
    expect(startup.code, startup.out + startup.err).toBe(0);
    expect(Buffer.byteLength(startup.out)).toBeLessThanOrEqual(flags.length ? 22500 : 12000);
    if (flags.length) expect(startup.payload.capability_context.instructions).toBe(CAPABILITY_INSTRUCTIONS.status);
    const offer = startup.payload.shared_skill.upgrade_offer;
    expect(offer).toMatchObject({
      question,
      approval: "explicit_yes_only",
      apply_command: expect.stringContaining(`--home ${home} --install-root ${app} --yes --authorization sha256:`),
    });
    expect(snapshot()).toEqual(before);
    expect(apply(offer, "No")).toBeNull();
    expect(apply(offer)).toBeNull();
    expect(snapshot()).toEqual(before);
    const projectBefore = snapshot(project);
    const result = apply(offer, "Yes")!;
    expect(result.code, result.out).toBe(0);
    expect(result.payload.status).toBe("success");
    expect(fs.readdirSync(target)).toEqual(["SKILL.md"]);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe(loadHostSkillSource(repo).content);
    expect(snapshot(project)).toEqual(projectBefore);
    const after = snapshot();
    expect(capture(["prime", ...flags]).payload.shared_skill).toMatchObject({
      status: "pass",
      upgrade_offer: null,
    });
    expect(snapshot()).toEqual(after);
  });

  it("doctor offers the same selected-home operation and never applies it during diagnosis", () => {
    legacy();
    const otherHome = path.join(temp, "unselected-home");
    fs.mkdirSync(otherHome);
    vi.stubEnv("HOME", otherHome);
    const before = snapshot();
    const doctor = capture(["doctor", "--home", home, "--install-root", app]);
    expect(doctor.payload.shared_skill.upgrade_offer.question).toBe(question);
    expect(snapshot()).toEqual(before);
    const withoutYes = capture(
      doctor.payload.shared_skill.upgrade_offer.apply_command
        .split(" ")
        .slice(3)
        .filter((arg: string) => arg !== "--yes"),
    );
    expect(withoutYes.payload.status).toBe("pending");
    expect(snapshot()).toEqual(before);
    const result = apply(doctor.payload.shared_skill.upgrade_offer, "Yes")!;
    expect(result.code, result.out).toBe(0);
    expect(capture(["doctor", "--home", home, "--install-root", app, "--format", "json"]).payload.shared_skill).toMatchObject({ status: "pass", upgrade_offer: null });
  });

  it("provides the complete refresh operation without another preview or invented token", () => {
    ownedStale();
    const diagnosis = capture(["doctor", "--format", "json"]);
    expect(diagnosis.payload.shared_skill, diagnosis.out + diagnosis.err).toBeDefined();
    const offer = diagnosis.payload.shared_skill.upgrade_offer;
    expect(offer.apply_command).toContain("--authorization one-file-sha256:");
    const before = snapshot();
    expect(apply(offer, "No")).toBeNull();
    expect(apply(offer, "yes please")).toBeNull();
    expect(snapshot()).toEqual(before);
    const result = apply(offer, "Yes")!;
    expect(result.code, result.out).toBe(0);
    expect(result.payload.status).toBe("success");
    expect(capture(["doctor", "--format", "json"]).payload.shared_skill.upgrade_offer).toBeNull();
    expect(apply(offer, "Yes")!.payload.status).toBe("noop");
  });

  it("does not label a missing installation as an outdated installed skill", () => {
    const before = snapshot();
    expect(capture(["prime"]).payload.shared_skill.upgrade_offer).toBeNull();
    expect(capture(["doctor"]).payload.shared_skill).toMatchObject({
      shape: "missing",
      upgrade_offer: null,
      preview_command: expect.stringContaining("upgrade --shared-skill"),
    });
    expect(snapshot()).toEqual(before);
  });

  it("does not ask again for current bytes when only the final bookkeeping checkpoint was interrupted", () => {
    const result = runHostSkillLifecycle(
      { home, appHome: app, sourceRoot: repo, apply: true },
      {
        persistLedger: (ledger) => {
          if (ledger.records.some((entry) => entry.resourceId === "shared-skill.bootstrap" && entry.status === "pending_create" && entry.identity) && fs.readFileSync(path.join(target, "SKILL.md"), "utf8") === loadHostSkillSource(repo).content) throw new Error("interrupted final checkpoint");
        },
      },
    );
    expect(result.status).toBe("non_success");
    const before = snapshot();
    expect(capture(["prime"]).payload.shared_skill).toMatchObject({
      status: "pass",
      upgrade_offer: null,
    });
    expect(snapshot()).toEqual(before);
  });

  it.each(["home", "app", "source", "tree"])("refuses changed %s under a one-file offer without broadening consent", (change) => {
    ownedStale();
    const offer = capture(["prime"]).payload.shared_skill.upgrade_offer;
    if (change === "home") offer.apply_command = offer.apply_command.replace(home, path.join(temp, "different-home"));
    if (change === "app") offer.apply_command = offer.apply_command.replace(app, path.join(temp, "different-app"));
    if (change === "source") {
      const source = path.join(temp, "runtime");
      for (const relative of ["registry.json", "references/adapters/package-registry.yaml", "skills/agentera/SKILL.md"]) write(path.join(source, relative), fs.readFileSync(path.join(repo, relative), "utf8"));
      vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", source);
    }
    if (change === "tree") legacy();
    const before = snapshot();
    const result = apply(offer, "Yes")!;
    expect(result.code).toBe(1);
    expect(result.payload.status).toBe("non_success");
    expect(snapshot()).toEqual(before);
  });

  it("does not authorize newly changed legacy contents with an earlier Yes", () => {
    legacy();
    const offer = capture(["prime"]).payload.shared_skill.upgrade_offer;
    write(path.join(target, "new-data"), "not in the offered operation");
    const before = snapshot();
    expect(apply(offer, "Yes")!.payload.status).toBe("non_success");
    expect(snapshot()).toEqual(before);
  });

  it("retries an interrupted one-file offer without reselecting source or asking another question", () => {
    ownedStale();
    const offer = capture(["prime"]).payload.shared_skill.upgrade_offer;
    const authorization = offer.apply_command.split(" ").at(-1);
    const first = runHostSkillLifecycle(
      { home, appHome: app, sourceRoot: repo, apply: true, authorization },
      {
        beforePublication: (boundary) => {
          if (boundary.operationId === "shared-skill.bootstrap") throw new Error("fixture interrupted publication");
        },
      },
    );
    expect(first.status).toBe("non_success");
    const before = snapshot();
    expect(apply(offer)).toBeNull();
    expect(snapshot()).toEqual(before);
    const result = apply(offer, "Yes")!;
    expect(result.code, result.out).toBe(0);
    expect(result.payload.status).toBe("success");
    expect(capture(["prime"]).payload.shared_skill.upgrade_offer).toBeNull();
  });

  it("reports a bounded failure with no actionable offer for an unsafe destination", () => {
    const outside = path.join(temp, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, ".agents"));
    const before = snapshot();
    for (const args of [["prime"], ["prime", "--context", "status"], ["doctor", "--format", "json"]]) {
      const result = capture(args);
      expect(result.payload.shared_skill).toMatchObject({ status: "warn", upgrade_offer: null });
    }
    expect(snapshot()).toEqual(before);
  });

  it("keeps the host bootstrap on one plain confirmation and CLI-verified completion", () => {
    const text = fs.readFileSync(path.join(repo, "skills/agentera/SKILL.md"), "utf8");
    expect(text).toContain(question);
    expect(text).toContain("No, silence or an absent offer means no update and no apply call");
    expect(text).toContain("Require exit 0 and JSON `status` of `success` or `noop`");
    expect(text).not.toContain("Unowned resources require separately");
  });
});
