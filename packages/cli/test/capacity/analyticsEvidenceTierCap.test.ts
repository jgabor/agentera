import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ADAPTER_VERSION } from "../../src/analytics/extractCorpus/core.js";
import {
  publishEvidenceTiers,
  readCurrentGeneration,
} from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { assessTiers } from "../../src/analytics/extractCorpus/tierReader.js";
import { evidenceTierBounds } from "../../src/registries/evidenceTierContract.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("analytics evidence-tier production shard cap", () => {
  it("retains and reports a record beyond the production 64 MiB shard cap", () => {
    const tiersDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-analytics-cap-"));
    roots.push(tiersDir);
    const bounds = evidenceTierBounds();
    const records = [{
      source_id: "oversized",
      source_kind: "conversation_turn",
      timestamp: "2026-01-01T00:00:00.000Z",
      project_id: "agentera",
      runtime: "opencode",
      source_class: "active_runtime",
      source_product: "opencode",
      active_runtime: true,
      adapter_version: ADAPTER_VERSION,
      data: { text: "x".repeat(bounds.shardByteCap + 1) },
    }];

    publishEvidenceTiers(records, {
      tiersDir,
      adapterVersion: ADAPTER_VERSION,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(bounds.shardByteCap).toBe(64 * 1024 * 1024);
    const assessment = assessTiers(tiersDir);
    expect(assessment.state).toBe("oversized");
    expect(assessment.artifact).toBeTruthy();
    expect(readCurrentGeneration(tiersDir)!.manifest.shards).toEqual([
      expect.objectContaining({ source_ids: ["oversized"] }),
    ]);
  });
});
