import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_CORPUS_READ_BYTES } from "../../src/analytics/usageStats.js";
import { main } from "../../src/cli/dispatch.js";
import { MAX_TOTAL_ENTRIES } from "../../src/hooks/common.js";
import { GAP_IDS, isGapClosed } from "../upgrade/gapRegistry.js";
import {
  classifyDrift,
  expectedShapeLiteralPins,
  expectedShapeRequiredKeys,
  normalizeEnvelope,
} from "./parityOracle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMAINING_FAMILIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/parity-remaining-families.json"), "utf8"),
) as {
  normalizeEnvelope: { rules: Parameters<typeof normalizeEnvelope>[2] };
  families: Record<
    string,
    {
      argv: string[];
      exitCode: number;
      expectedShape: Record<string, unknown>;
      forbiddenSubstrings: string[];
    }
  >;
};

const COMPACTION_SPEC = REMAINING_FAMILIES.families.compaction;
const NORMALIZE_RULES = REMAINING_FAMILIES.normalizeEnvelope.rules;

function capture(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { rc, out, err };
}

function writeOverCapProgress(dir: string, cycleCount = 55): void {
  const agenteraDir = path.join(dir, ".agentera");
  fs.mkdirSync(agenteraDir, { recursive: true });
  const cycles = Array.from({ length: cycleCount }, (_, i) => ({
    number: i + 1,
    timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")} 10:00`,
    type: "feat",
    phase: "build",
    what: `Work cycle ${i + 1}`,
  }));
  fs.writeFileSync(path.join(agenteraDir, "progress.yaml"), YAML.stringify({ cycles, archive: [] }));
}

let tmp: string;
let prevProfilera: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compact-parity-"));
  prevProfilera = process.env.PROFILERA_PROFILE_DIR;
  process.env.PROFILERA_PROFILE_DIR = path.join(tmp, "profile");
});

afterEach(() => {
  if (prevProfilera === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = prevProfilera;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("compaction parity (D56 T3)", () => {
  it("gap registry marks compaction family closed", () => {
    expect(isGapClosed(GAP_IDS.COMPACTION_FAMILY)).toBe(true);
  });

  it("dry-run gate envelope matches the compaction oracle pin (pass)", () => {
    const { rc, out } = capture(COMPACTION_SPEC.argv);
    expect(rc).toBe(COMPACTION_SPEC.exitCode);
    const payload = JSON.parse(out) as Record<string, unknown>;
    const normalized = normalizeEnvelope(payload, null, NORMALIZE_RULES) as Record<string, unknown>;
    const classification = classifyDrift(
      normalized,
      expectedShapeRequiredKeys(COMPACTION_SPEC.expectedShape),
      expectedShapeLiteralPins(COMPACTION_SPEC.expectedShape),
      COMPACTION_SPEC.forbiddenSubstrings,
    );
    expect(classification.direction).toBe("equal");
    expect(payload.command).toBe("gate");
    expect(payload.gate).toBe("compaction");
    expect((payload.summary as Record<string, unknown>).mode).toBe("check");
  });

  it("compaction JSON must not emit forbidden-shape sentinels (fail guard)", () => {
    const { out } = capture(COMPACTION_SPEC.argv);
    const serialized = JSON.stringify(JSON.parse(out));
    for (const forbidden of COMPACTION_SPEC.forbiddenSubstrings) {
      expect(serialized, `forbidden sentinel '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it("dry-run reports over_limit before apply on an over-cap fixture (fail guard)", () => {
    const project = path.join(tmp, "over-cap-dry");
    writeOverCapProgress(project, 55);
    const { rc, out } = capture(["check", "compact", "--project", project, "--format", "json"]);
    expect(rc).toBe(1);
    const payload = JSON.parse(out) as Record<string, unknown>;
    expect(payload.command).toBe("gate");
    const summary = payload.summary as Record<string, unknown>;
    expect(summary.mode).toBe("check");
    expect(summary.over_limit_count).toBe(1);
    const progress = (payload.operations as Array<Record<string, unknown>>).find(
      (op) => op.artifact === "PROGRESS.md",
    );
    expect(progress?.action).toBe("over_limit");
  });

  it("apply enforces 10/40/50 caps with archive preservation and clears over_limit (pass)", () => {
    const project = path.join(tmp, "over-cap-apply");
    writeOverCapProgress(project, 55);
    const { rc, out } = capture(["check", "compact", "--apply", "--project", project, "--format", "json"]);
    expect(rc).toBe(0);
    const payload = JSON.parse(out) as Record<string, unknown>;
    expect(payload.command).toBe("compact");
    const summary = payload.summary as Record<string, unknown>;
    expect(summary.mode).toBe("fix");
    expect(summary.over_limit_count).toBe(0);

    const progress = (payload.operations as Array<Record<string, unknown>>).find(
      (op) => op.artifact === "PROGRESS.md",
    );
    expect(progress?.action).toBe("compacted");
    const result = progress?.result as Record<string, unknown>;
    expect(result.active_after).toBe(10);
    expect(result.archive_after).toBe(40);

    const data = YAML.parse(
      fs.readFileSync(path.join(project, ".agentera", "progress.yaml"), "utf8"),
    ) as { cycles: unknown[]; archive: { summary: string }[] };
    expect(data.cycles.length).toBe(10);
    expect(data.archive.length).toBe(40);
    expect(data.cycles.length + data.archive.length).toBe(MAX_TOTAL_ENTRIES);
    expect(data.archive.some((entry) => entry.summary.includes("Cycle 1"))).toBe(true);
  });

  it("check compact tolerates an oversized corpus.json without Node string-limit crash (pass)", () => {
    const corpusDir = path.join(process.env.PROFILERA_PROFILE_DIR!, "intermediate");
    fs.mkdirSync(corpusDir, { recursive: true });
    const corpusPath = path.join(corpusDir, "corpus.json");
    const fd = fs.openSync(corpusPath, "w");
    fs.ftruncateSync(fd, MAX_CORPUS_READ_BYTES + 1);
    fs.closeSync(fd);

    const project = path.join(tmp, "with-corpus");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    const { rc, out, err } = capture(["check", "compact", "--project", project, "--format", "json"]);
    expect(rc).toBe(0);
    const combined = out + err;
    expect(combined).not.toContain("Cannot create a string longer than 0x1fffffe8");
    expect(JSON.parse(out).command).toBe("gate");
  });
});
