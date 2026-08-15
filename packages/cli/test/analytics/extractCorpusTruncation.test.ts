import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isolatedEnv, seedOpencodeManySessions } from "./extractCorpusFixtures.js";
import { buildCorpus, extractCorpusMain, readSignalTier } from "../../src/analytics/extractCorpus.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extract-truncation-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("SQLite cap overrides and truncation", () => {
  it("sets runtime_statuses truncated_at when session cap is exceeded", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeManySessions(dbp, 65);
    const corpus = buildCorpus({
      projectRoots: [tmp],
      codexSessionsDir: null,
      claudeProjectsDir: null,
      opencodeConversationsDir: dbp,
      sqliteCaps: { maxSessions: 60, maxRows: 100_000 },
    });
    const opencodeStatus = corpus.metadata.runtime_statuses.find((s: { runtime: string }) => s.runtime === "opencode");
    expect(opencodeStatus?.truncated_at).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(opencodeStatus?.truncation_cap).toBe("sessions");
    expect(opencodeStatus?.truncation_limit).toBe(60);
  });

  it("honors --max-sqlite-sessions override", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeManySessions(dbp, 65);
    const tiersDir = path.join(tmp, "out", "tiers");
    let errLog = "";
    const rc = extractCorpusMain(
      [
        "--tier-output",
        tiersDir,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-codex",
        "--no-copilot",
        "--no-cursor",
        "--max-sqlite-sessions",
        "100",
      ],
      { out: () => {}, err: (t) => (errLog += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    const tier = readSignalTier(tiersDir);
    expect(tier).not.toBeNull();
    const opencodeStatus = tier!.manifest.corpus_metadata?.runtime_statuses?.find(
      (s: { runtime?: string }) => s.runtime === "opencode",
    );
    expect(opencodeStatus?.truncated_at).toBeUndefined();
    expect(errLog).not.toContain("SQLite extraction truncated");
  });

  it("honors AGENTERA_EXTRACT_MAX_SQLITE_SESSIONS env override", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeManySessions(dbp, 65);
    const tiersDir = path.join(tmp, "out", "tiers");
    const rc = extractCorpusMain(
      [
        "--tier-output",
        tiersDir,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-codex",
        "--no-copilot",
        "--no-cursor",
      ],
      {
        out: () => {},
        err: () => {},
        env: { ...isolatedEnv(tmp), AGENTERA_EXTRACT_MAX_SQLITE_SESSIONS: "100" },
        cwd: tmp,
      },
    );
    expect(rc).toBe(0);
    const tier = readSignalTier(tiersDir);
    expect(tier).not.toBeNull();
    const opencodeStatus = tier!.manifest.corpus_metadata?.runtime_statuses?.find(
      (s: { runtime?: string }) => s.runtime === "opencode",
    );
    expect(opencodeStatus?.truncated_at).toBeUndefined();
  });

  it("emits user-visible truncation warning after extraction", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeManySessions(dbp, 65);
    const tiersDir = path.join(tmp, "out", "tiers");
    let errLog = "";
    const rc = extractCorpusMain(
      [
        "--tier-output",
        tiersDir,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-codex",
        "--no-copilot",
        "--no-cursor",
      ],
      { out: () => {}, err: (t) => (errLog += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    expect(errLog).toContain("SQLite extraction truncated");
    expect(errLog).toContain("opencode:");
    expect(errLog).toContain("sessions limit=60");
    expect(errLog).toContain(new Date(1_700_000_000 * 1000).toISOString());
  });
});
