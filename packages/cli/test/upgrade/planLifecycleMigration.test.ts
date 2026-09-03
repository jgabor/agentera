import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { discoverPlanArtifacts } from "../../src/cli/planArtifacts.js";
import { applyMigrationPhases, planArtifactsPhase } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
let originalSourceRoot: string | undefined;

function writePlan(target: string, status: "active" | "completed" | "open" | "complete", created: string, taskStatus: string, evidence: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, ["header:", `  created: '${created}'`, `  status: ${status}`, "  title: Lifecycle fixture", "tasks:", "  - number: 1", "    name: Preserve evidence", `    status: ${taskStatus}`, `    evidence: '${evidence}'`, "notes: retained verbatim", ""].join("\n"));
}

function readPlan(target: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-migration-"));
  originalSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
});

afterEach(() => {
  if (originalSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = originalSourceRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("plan lifecycle migration", () => {
  it("previews docs-mapped lifecycle work but rejects partial apply without changing evidence", () => {
    const project = path.join(tmp, "project");
    const current = path.join(project, "state", "current-plan.yaml");
    const completeArchive = path.join(project, "state", "archive", "PLAN-2026-07-11-complete.yaml");
    const openArchive = path.join(project, "state", "archive", "PLAN-2026-07-10-open.yaml");
    const collisionArchive = path.join(project, "state", "archive", "PLAN-2026-07-09-collision.yaml");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera", "docs.yaml"), ["mapping:", "  - artifact: PLAN.md", "    path: state/current-plan.yaml", ""].join("\n"));
    writePlan(current, "active", "2026-07-12", "pending", "current evidence");
    writePlan(completeArchive, "completed", "2026-07-11", "completed", "complete archive evidence");
    writePlan(openArchive, "active", "2026-07-10", "pending", "open archive evidence");
    writePlan(collisionArchive, "completed", "2026-07-09", "pending", "collision archive evidence");

    const originals = new Map(
      [current, completeArchive, openArchive, collisionArchive].map((target) => [
        target,
        {
          bytes: fs.readFileSync(target, "utf8"),
          tasks: readPlan(target).tasks,
          notes: readPlan(target).notes,
        },
      ]),
    );
    let stdout = "";
    const previewExit = cmdUpgrade(
      {
        project,
        installRoot: path.join(tmp, "app-home"),
        home: tmp,
        only: ["artifacts"],
        dryRun: true,
        format: "json",
      },
      {
        out: (text) => {
          stdout += text;
        },
      },
    );

    expect(previewExit).toBe(1);
    expect(fs.readFileSync(current, "utf8")).toBe(originals.get(current)?.bytes);
    const preview = JSON.parse(stdout) as {
      phases: Array<{ name: string; items: Array<Record<string, unknown>> }>;
    };
    const artifactPhase = preview.phases.find((phase) => phase.name === "artifacts");
    expect(artifactPhase?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "normalize-plan-lifecycle",
          source: "state/current-plan.yaml",
          status: "pending",
        }),
        expect.objectContaining({
          action: "normalize-plan-lifecycle",
          source: "state/archive/PLAN-2026-07-09-collision.yaml",
          collisions: [expect.stringContaining("unfinished task evidence")],
        }),
      ]),
    );

    stdout = "";
    const applyExit = cmdUpgrade(
      {
        project,
        installRoot: path.join(tmp, "app-home"),
        home: tmp,
        only: ["artifacts"],
        yes: true,
        format: "json",
      },
      {
        out: (text) => {
          stdout += text;
        },
      },
    );

    expect(applyExit).toBe(2);
    for (const [target, original] of originals) {
      expect(readPlan(target).tasks).toEqual(original.tasks);
      expect(readPlan(target).notes).toBe(original.notes);
      expect(fs.readFileSync(target, "utf8")).toBe(original.bytes);
    }
  });

  it("keeps archive order stable when lifecycle writes and mtimes change", () => {
    const project = path.join(tmp, "project");
    const current = path.join(project, ".agentera", "plan.yaml");
    const newer = path.join(project, ".agentera", "archive", "PLAN-2026-07-11-newer.yaml");
    const older = path.join(project, ".agentera", "archive", "PLAN-2026-07-10-older.yaml");
    writePlan(newer, "open", "2026-07-11", "pending", "newer evidence");
    writePlan(older, "active", "2026-07-10", "pending", "older evidence");

    const initialOrder = discoverPlanArtifacts(current).archived.map((artifact) => path.basename(artifact.path));
    const migration = planArtifactsPhase(project);
    expect(migration.status).toBe("pending");
    applyMigrationPhases(
      migrationCtx(project, project, tmp, REPO_ROOT),
      {
        artifacts: migration,
        runtime: {
          name: "runtime",
          status: "noop",
          summary: { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0 },
          items: [],
          message: "",
        },
        cleanup: {
          name: "cleanup",
          status: "noop",
          summary: { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0 },
          items: [],
          message: "",
        },
      },
      ["artifacts"],
    );
    fs.utimesSync(newer, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));

    expect(discoverPlanArtifacts(current).archived.map((artifact) => path.basename(artifact.path))).toEqual(initialOrder);
  });
});
