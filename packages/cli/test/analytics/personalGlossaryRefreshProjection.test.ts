import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers, readCurrentGeneration } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjection,
  projectPersonalGlossaryCandidates,
  readPersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import { produceCurrentPersonalGlossaryProjection } from "../../src/analytics/personalGlossaryRefreshProjection.js";
import { main } from "../../src/cli/dispatch.js";

const PUBLISHED_AT = "2026-08-12T10:11:12.000Z";
let root: string;
let profileDir: string;
let tiersDir: string;
let previousProfileDir: string | undefined;

function record(
  sourceId: string,
  sourceKind: "conversation_turn" | "instruction_document" | "project_config_signal",
  projectId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const text = String(data.text ?? data.content ?? (data.signals as string[] | undefined)?.join("\n") ?? sourceId);
  return {
    source_id: sourceId,
    source_kind: sourceKind,
    timestamp: PUBLISHED_AT,
    project_id: projectId,
    runtime: sourceKind === "conversation_turn" ? "opencode" : "filesystem",
    source_class: sourceKind === "conversation_turn" ? "active_runtime" : "project",
    source_product: sourceKind === "conversation_turn" ? "opencode" : "filesystem",
    active_runtime: sourceKind === "conversation_turn",
    adapter_version: ADAPTER_VERSION,
    origin_id: originIdentity(`origin:${sourceId}`),
    content_fingerprint: contentFingerprint(text),
    ...(sourceKind === "conversation_turn" ? {
      session_id: `session-${sourceId}`,
      conversation_key: `session-${sourceId}`,
      author_class: "user",
    } : {}),
    data,
  };
}

function evidence(seed = "initial"): Array<Record<string, unknown>> {
  return [
    record(`explicit-${seed}`, "conversation_turn", "project-explicit", {
      actor: "user",
      signal_type: "decision",
      text: `Definition: ship shape: the complete form of ${seed}.`,
    }),
    record(`instruction-${seed}`, "instruction_document", "project-a", {
      signal_type: "instruction",
      content: "Keep the signal-braid explicit.",
    }),
    record(`configuration-${seed}`, "project_config_signal", "project-b", {
      signal_type: "configuration",
      signals: ["signal-braid"],
    }),
  ];
}

function publish(seed = "initial"): string {
  return publishEvidenceTiers(evidence(seed) as any, {
    tiersDir,
    adapterVersion: ADAPTER_VERSION,
    publishedAt: PUBLISHED_AT,
  }).generation;
}

function run(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], { out: (text) => { out += text; }, err: (text) => { err += text; } });
  return { rc, out, err };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-refresh-projection-"));
  profileDir = path.join(root, "profile");
  tiersDir = path.join(profileDir, "intermediate", "tiers");
  previousProfileDir = process.env.AGENTERA_PROFILE_DIR;
  process.env.AGENTERA_PROFILE_DIR = profileDir;
});

afterEach(() => {
  if (previousProfileDir === undefined) delete process.env.AGENTERA_PROFILE_DIR;
  else process.env.AGENTERA_PROFILE_DIR = previousProfileDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("refresh candidate projection production", () => {
  it("publishes explicit and recurring candidates for list and exact read with fixed aggregate counts", () => {
    const generation = publish();
    const produced = produceCurrentPersonalGlossaryProjection({ tiersDir });
    expect(produced).toMatchObject({ status: "changed", generation, candidate_count: 2 });

    const projection = readPersonalGlossaryCandidateProjection().projection!;
    expect(projection.retained_at).toBe(PUBLISHED_AT);
    expect(projection.candidates.map((candidate) => candidate.source_family).sort()).toEqual(["explicit", "recurring"]);
    expect(Object.keys(projection.report.mining_summary.explicit.abstentions_by_reason)).toHaveLength(24);
    expect(Object.keys(projection.report.mining_summary.recurring.abstentions_by_reason)).toHaveLength(12);

    const listed = run(["report", "personal-glossary-candidates", "list", "--format", "json"]);
    expect(listed.rc).toBe(0);
    const listPayload = JSON.parse(listed.out);
    expect(listPayload.generation).toBe(generation);
    expect(listPayload.entries).toHaveLength(2);

    const capsule = projection.candidates[0]!.capsule;
    const exact = run([
      "report", "personal-glossary-candidates", "get",
      "--candidate-id", capsule.candidate_id,
      "--candidate-revision", capsule.candidate_revision,
      "--generation", generation,
      "--policy-version", projection.policy_version,
      "--format", "json",
    ]);
    expect(exact.rc).toBe(0);
    expect(JSON.parse(exact.out).candidate_projection_sha256).toBe(produced.candidate_projection_sha256);
  });

  it("replays identical bytes and replaces missing, stale, or malformed regular derived state only", () => {
    publish();
    const profileMarker = path.join(profileDir, "profile.yaml");
    const projectMarker = path.join(root, ".agentera-marker");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(profileMarker, "profile unchanged\n");
    fs.writeFileSync(projectMarker, "project unchanged\n");

    const first = produceCurrentPersonalGlossaryProjection({ tiersDir });
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const firstBytes = fs.readFileSync(projectionPath);
    expect(produceCurrentPersonalGlossaryProjection({ tiersDir }).status).toBe("unchanged_replay");
    expect(fs.readFileSync(projectionPath)).toEqual(firstBytes);

    publish("next");
    const staleBytes = fs.readFileSync(projectionPath);
    const staleRead = run(["report", "personal-glossary-candidates", "list", "--format", "json"]);
    expect(staleRead.rc).toBe(1);
    expect(JSON.parse(staleRead.out).error.class).toBe("projection_stale");
    const replaced = produceCurrentPersonalGlossaryProjection({ tiersDir });
    expect(replaced.generation).not.toBe(first.generation);
    expect(fs.readFileSync(projectionPath)).not.toEqual(staleBytes);

    fs.writeFileSync(projectionPath, "{malformed\n");
    expect(produceCurrentPersonalGlossaryProjection({ tiersDir }).status).toBe("changed");
    expect(readPersonalGlossaryCandidateProjection().status).toBe("current");

    const current = readCurrentGeneration(tiersDir)!;
    persistPersonalGlossaryCandidateProjection(projectPersonalGlossaryCandidates({
      generation: current.manifest.generation,
      policy_version: "agentera.personalGlossaryMiningPolicy.v1",
      retained_at: current.manifest.published_at,
      candidates: [],
    }));
    expect(readPersonalGlossaryCandidateProjection().projection?.candidates).toHaveLength(0);
    expect(produceCurrentPersonalGlossaryProjection({ tiersDir }).status).toBe("changed");
    expect(readPersonalGlossaryCandidateProjection().projection?.candidates).toHaveLength(2);
    expect(fs.readFileSync(profileMarker, "utf8")).toBe("profile unchanged\n");
    expect(fs.readFileSync(projectMarker, "utf8")).toBe("project unchanged\n");
  });

  it.each(["symlink", "directory"] as const)("rejects an unsafe %s target without changing evidence or unrelated state", (kind) => {
    const generation = publish();
    const projectionPath = personalGlossaryCandidateProjectionPath();
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    const outside = path.join(root, "outside");
    if (kind === "symlink") {
      fs.writeFileSync(outside, "outside unchanged\n");
      fs.symlinkSync(outside, projectionPath);
    } else {
      fs.mkdirSync(projectionPath);
    }

    expect(() => produceCurrentPersonalGlossaryProjection({ tiersDir })).toThrow("exact regular file");
    expect(readCurrentGeneration(tiersDir)?.manifest.generation).toBe(generation);
    if (kind === "symlink") expect(fs.readFileSync(outside, "utf8")).toBe("outside unchanged\n");
    const read = run(["report", "personal-glossary-candidates", "list", "--format", "json"]);
    expect(read.rc).toBe(1);
    expect(JSON.parse(read.out).error.recovery).toContain("report refresh --consent local-history");
  });
});
