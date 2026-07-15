import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  ExperimentIdentityError,
  discoverObjectiveArtifacts,
  inspectExperimentIdentities,
  resolveObjectiveIdentity,
  validateExperimentPublicationIdentity,
} from "../../src/state/experimentIdentity.js";

const roots: string[] = [];
const objectiveId = "objective:123e4567-e89b-42d3-a456-426614174000";
const otherObjectiveId = "objective:223e4567-e89b-42d3-a456-426614174000";

function objective(id: string | undefined, title: string, description = "Reduce latency") {
  return {
    header: { ...(id ? { id } : {}), title, status: "open" },
    objective: { description, measurement: "p95", constraints: [] },
    metric: { direction: "minimize", unit: "ms" },
    baseline: { description: "100 ms" },
    gates: {},
    scope: { included: ["CLI"], excluded: [] },
  };
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-experiment-identity-"));
  roots.push(root);
  return root;
}

function writeObjective(root: string, storageRoot: "optimize" | "optimera", slug: string, value: object): string {
  const directory = path.join(root, ".agentera", storageRoot, slug);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "objective.yaml"), YAML.stringify(value));
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("objective-scoped experiment identity", () => {
  it("scopes experiment zero and later numbers to stable objective identity", () => {
    const first = inspectExperimentIdentities(objectiveId, { experiments: [{ number: 0 }, { number: 2 }] });
    const second = inspectExperimentIdentities(otherObjectiveId, { experiments: [{ number: 0 }] });

    expect(first.entries.map((entry) => entry.stableId)).toEqual([
      `${objectiveId}/experiment:0`,
      `${objectiveId}/experiment:2`,
    ]);
    expect(second.entries[0].stableId).toBe(`${otherObjectiveId}/experiment:0`);
    expect(first.entries.every((entry) => entry.addressable)).toBe(true);
  });

  it("keeps persisted objective identity through title and canonical path rename", () => {
    const root = project();
    writeObjective(root, "optimize", "old-title", objective(objectiveId, "Old title"));
    let discovery = discoverObjectiveArtifacts(root);
    expect(discovery.objectives).toHaveLength(1);
    expect(discovery.objectives[0]).toMatchObject({ stableId: objectiveId, ambiguous: false });

    fs.renameSync(
      path.join(root, ".agentera", "optimize", "old-title"),
      path.join(root, ".agentera", "optimize", "new-title"),
    );
    const renamedPath = path.join(root, ".agentera", "optimize", "new-title", "objective.yaml");
    const renamed = YAML.parse(fs.readFileSync(renamedPath, "utf8"));
    renamed.header.title = "New title";
    fs.writeFileSync(renamedPath, YAML.stringify(renamed));

    discovery = discoverObjectiveArtifacts(root);
    expect(discovery.objectives[0]).toMatchObject({ stableId: objectiveId, ambiguous: false });
  });

  it("derives rename-stable legacy identity without rewriting legacy bytes", () => {
    const before = objective(undefined, "Old title");
    const after = objective(undefined, "New title");
    expect(resolveObjectiveIdentity(before).stableId).toBe(resolveObjectiveIdentity(after).stableId);
    expect(before.header).not.toHaveProperty("id");
  });

  it("retains missing and duplicate legacy entries with explicit caveats", () => {
    const projection = inspectExperimentIdentities(objectiveId, {
      experiments: [{ number: 0, label: "baseline" }, { label: "missing" }],
      archive: [{ number: 0, summary: "duplicate" }],
    });

    expect(projection.entries).toHaveLength(3);
    expect(projection.entries.map((entry) => entry.addressable)).toEqual([false, false, false]);
    expect(projection.entries[0].compatibility).toBe("legacy_duplicate_identity");
    expect(projection.entries[1].compatibility).toBe("legacy_missing_identity");
    expect(projection.caveats).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate experiment number 0"),
      expect.stringContaining("missing experiment number"),
    ]));
  });

  it("reports conflicting canonical and legacy objective candidates as structured ambiguity", () => {
    const root = project();
    writeObjective(root, "optimize", "latency", objective(objectiveId, "Latency"));
    writeObjective(root, "optimera", "latency", objective(otherObjectiveId, "Latency legacy", "Different objective"));

    const discovery = discoverObjectiveArtifacts(root);
    expect(discovery.diagnostics).toContainEqual(expect.objectContaining({
      class: "ambiguous",
      slug: "latency",
      candidate_ids: [objectiveId, otherObjectiveId],
    }));
    expect(discovery.objectives.every((candidate) => candidate.ambiguous)).toBe(true);
  });

  it("fails ambiguous or duplicate publication identity before effects", () => {
    const root = project();
    const directory = writeObjective(root, "optimize", "latency", objective(objectiveId, "Latency"));
    const experimentsPath = path.join(directory, "experiments.yaml");
    fs.writeFileSync(experimentsPath, YAML.stringify({ experiments: [{ number: 0 }] }));
    const before = fs.readFileSync(experimentsPath);
    const discovery = discoverObjectiveArtifacts(root);
    const projection = inspectExperimentIdentities(objectiveId, YAML.parse(before.toString("utf8")));

    expect(validateExperimentPublicationIdentity(discovery, projection, objectiveId, 1)).toBe(`${objectiveId}/experiment:1`);
    expect(() => validateExperimentPublicationIdentity(discovery, projection, objectiveId, 0)).toThrowError(
      expect.objectContaining<Partial<ExperimentIdentityError>>({ className: "ambiguous" }),
    );
    expect(() => validateExperimentPublicationIdentity(discovery, projection, objectiveId, -1)).toThrowError(
      expect.objectContaining<Partial<ExperimentIdentityError>>({ className: "invalid_request" }),
    );
    expect(fs.readFileSync(experimentsPath)).toEqual(before);
  });
});
