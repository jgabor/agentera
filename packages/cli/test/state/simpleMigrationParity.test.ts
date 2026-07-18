import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { printStateHelp } from "../../src/cli/help.js";
import { buildExplain } from "../../src/state/write/explain.js";
import { migrationEnrichmentContract } from "../../src/state/migrationEnrichment.js";
import {
  gitBackfillContractProjection,
  stateGitBackfillContract,
} from "../../src/state/gitBackfillAuthority.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const BUNDLE_ROOT = path.join(REPO_ROOT, "packages", "cli", "bundle");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function upgradeEnrichmentSection(): string {
  const upgrade = read("UPGRADE.md");
  const start = upgrade.indexOf("## Legacy state and optional Git enrichment");
  const end = upgrade.indexOf("## Verification and recovery", start);
  if (start < 0 || end < 0) throw new Error("optional enrichment upgrade section is missing");
  return upgrade.slice(start, end);
}

describe("simplified migration and enrichment parity", () => {
  it("keeps source and generated bundle data byte-equivalent", () => {
    const surfaces = [
      "references/artifacts/state-storage-authority.yaml",
      "UPGRADE.md",
      "skills/agentera/schemas/artifacts/progress.yaml",
      "skills/agentera/schemas/artifacts/decisions.yaml",
      "skills/agentera/schemas/artifacts/health.yaml",
      "skills/agentera/references/contract.md",
    ];
    for (const surface of surfaces) {
      expect(fs.readFileSync(path.join(BUNDLE_ROOT, surface), "utf8"), surface).toBe(read(surface));
    }
  });

  it("derives help, handoff, and output contract fields from the same authority", () => {
    const contract = stateGitBackfillContract(REPO_ROOT);
    const projection = gitBackfillContractProjection(contract);
    const help = printStateHelp("backfill");
    const handoff = migrationEnrichmentContract(REPO_ROOT);

    expect(help).toContain(contract.command.split(" [", 1)[0]);
    expect(help).toContain(`Result limit: ${contract.maximumLimit}`);
    expect(help).toContain(`history limit: ${contract.maximumCommits}`);
    expect((handoff.contract as Record<string, unknown>).limits).toEqual(projection.limits);
    expect((handoff.contract as Record<string, unknown>).revalidation).toBe(projection.revalidation);
    expect((handoff.contract as Record<string, unknown>).traceability).toEqual(projection.traceability);
  });

  it("keeps retired preview-authorization language out of live enrichment surfaces", () => {
    // Archived plans, prior progress, and resolved TODO entries are historical evidence.
    const live = [
      JSON.stringify(gitBackfillContractProjection(stateGitBackfillContract(REPO_ROOT))),
      printStateHelp("backfill"),
      JSON.stringify(migrationEnrichmentContract(REPO_ROOT)),
      upgradeEnrichmentSection(),
    ].join("\n").toLowerCase();

    for (const term of ["receipt", "hmac", "preview-token", "preview_token", "expiry", "daemon", "service"]) {
      expect(live, term).not.toContain(term);
    }
  });

  it("keeps legacy projection guidance in migration references while entity explain stays final", () => {
    const source = read("skills/agentera/references/contract.md");
    const bundled = fs.readFileSync(path.join(BUNDLE_ROOT, "skills/agentera/references/contract.md"), "utf8");
    const start = source.indexOf("### Compaction thresholds");
    const end = source.indexOf("**EXPERIMENTS.md**", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const sourceProjection = source.slice(start, end).toLowerCase().replace(/\s+/g, " ");
    const bundleProjection = bundled.slice(start, end).toLowerCase().replace(/\s+/g, " ");
    const explain = JSON.stringify(buildExplain("progress", REPO_ROOT, "append"))
      .toLowerCase()
      .replace(/\s+/g, " ");
    const required = [
      "uniform_10_40_50",
      "bounded active/archive projections",
      "verified numbered archives remain authoritative",
      "no destructive deletion",
      "recovery refuses to omit entries when archive evidence is missing",
    ];
    const stale = ["drop beyond 50", "removed entirely", "older than 50", "drop the oldest"];

    for (const surface of [sourceProjection, bundleProjection]) {
      for (const phrase of required) expect(surface, phrase).toContain(phrase);
      for (const phrase of stale) expect(surface, phrase).not.toContain(phrase);
    }
    expect(explain).toContain("each canonical progress entity is authority");
    expect(explain).toContain("no aggregate projection or numbered archive is written");
    for (const phrase of required) expect(explain, phrase).not.toContain(phrase);
  });
});
