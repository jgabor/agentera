import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/dispatch.js";
import { useSourceAppHome } from "../helpers/managedAppStub.js";
import { loadHostSkillSource } from "../../src/setup/hostSkillLifecycle.js";
import { commandText } from "../../src/upgrade/upgradeCommands.js";

useSourceAppHome();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function capture(project: string, args: string[], input = "") {
  const previous = process.cwd();
  process.chdir(project);
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args, "--format", "json"], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdin: () => input,
  });
  process.chdir(previous);
  return { rc, err, json: out ? JSON.parse(out) : null };
}

describe("Doctor project readiness", () => {
  it("scopes corrupt-entity recovery to the diagnosed project rather than the caller's healthy project", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-scoped-recovery-"));
    roots.push(root);
    const healthy = path.join(root, "healthy A");
    const corrupt = path.join(root, "corrupt B's project");
    fs.mkdirSync(healthy);
    execFileSync("git", ["init", "--quiet"], { cwd: healthy });
    const created = capture(
      healthy,
      ["state", "plan", "create", "--input", "-"],
      JSON.stringify({
        header: { level: "light", created: "2026-10-01", status: "open", title: "Scoped recovery" },
        what: "Verify agentera doctor recovery for .agentera/entities/plan/plan/aaaaaaaaaa.yaml",
        why: "Diagnose the selected project rather than the caller's working directory",
        scope: { included: ["scoped recovery"], excluded: ["global changes"] },
        tasks: [
          {
            number: 1,
            name: "Verify recovery",
            status: "pending",
            depends_on: [],
            acceptance: ["GIVEN corrupt B WHEN diagnosed from A THEN recovery validates B"],
          },
        ],
      }),
    );
    expect(created.rc, JSON.stringify(created)).toBe(0);
    fs.cpSync(healthy, corrupt, { recursive: true });
    fs.writeFileSync(path.join(corrupt, ".agentera/entities/plan/plan/aaaaaaaaaa.yaml"), "not: [valid\n");
    expect(capture(healthy, ["check", "validate", "state"]).rc).toBe(0);
    const doctor = capture(healthy, ["doctor", "--project", corrupt]);
    const recovery = doctor.json.current_health.capability_startup.recovery_command;
    expect(recovery).toBe(commandText(["npx", "-y", "agentera@next", "check", "validate", "state", "--cwd", corrupt]));
    expect(doctor.json.signals.find((signal: { kind: string }) => signal.kind === "project_readiness").recoveryCommand).toBe(recovery);
    const tokens = execFileSync("bash", ["-c", `printf '%s\\0' ${recovery}`])
      .toString()
      .split("\0")
      .slice(0, -1);
    const validation = capture(healthy, tokens.slice(3));
    expect(validation.rc).toBe(1);
    expect(validation.json.project_root).toBe(corrupt);
    expect(validation.json.valid).toBe(false);
    expect(validation.json.issues.some((issue: { path?: string }) => issue.path === ".agentera/entities/plan/plan/aaaaaaaaaa.yaml")).toBe(true);
  });
  it.each(["fresh", "legacy", "partial", "corrupt", "unknown", "valid"])("shares Prime's %s classification and preserves app health", (kind) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-readiness-"));
    roots.push(project);
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    const skill = path.join(os.homedir(), ".agents/skills/agentera/SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, loadHostSkillSource(path.resolve(import.meta.dirname, "../../../..")).content);
    if (!["fresh", "valid"].includes(kind)) fs.mkdirSync(path.join(project, ".agentera"));
    if (kind === "legacy") {
      fs.writeFileSync(path.join(project, ".agentera/progress.yaml"), "cycles: []\n");
      fs.writeFileSync(path.join(project, ".agentera/health.yaml"), "audits: []\n");
    }
    if (kind === "partial") fs.mkdirSync(path.join(project, ".agentera/entities"));
    if (kind === "corrupt") fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "mode: invalid\n");
    if (kind === "valid") {
      const created = capture(
        project,
        ["state", "plan", "create", "--input", "-"],
        JSON.stringify({
          header: { level: "light", created: "2026-10-01", status: "open", title: "Readiness" },
          what: "Verify readiness through agentera doctor and .agentera/state-mode.yaml",
          why: "Keep diagnosis honest",
          scope: { included: ["diagnosis"], excluded: ["global changes"] },
          tasks: [
            {
              number: 1,
              name: "Verify",
              status: "pending",
              depends_on: [],
              acceptance: ["GIVEN valid state WHEN diagnosed THEN ready"],
            },
          ],
        }),
      );
      expect(created.rc, JSON.stringify(created)).toBe(0);
    }
    const prime = capture(project, ["prime", "--fields", "startup"]);
    const doctor = capture(project, ["doctor"]);
    expect(doctor.json.current_health.cli).toBe("up_to_date");
    expect(doctor.json.current_health.project_state).toEqual(prime.json.startup.state_cutover);
    expect(doctor.json.current_health.capability_startup.outcome).toBe(prime.json.startup.outcome);
    expect(doctor.json.current_health.writer_readiness.status).toBe(kind === "valid" ? "ready" : "blocked");
    expect(doctor.json.current_health.writer_readiness.permission_granted).toBe(false);
    if (kind === "valid") {
      expect(doctor.rc).toBe(0);
      expect(doctor.json.status).toBe("up_to_date");
    }
    if (kind !== "valid") {
      expect(doctor.rc).toBe(1);
      expect(doctor.json.status).not.toBe("up_to_date");
      const writer = capture(project, ["state", "progress", "append", "--input", "-"], "{}");
      expect(writer.rc).toBe(1);
      expect(doctor.json.current_health.writer_readiness.error).toEqual(writer.json.error);
    }
  });
});
