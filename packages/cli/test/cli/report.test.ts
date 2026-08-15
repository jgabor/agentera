import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cmdReport, statsCorpusPath, statsExistingCorpusStatus, ReportArgs } from "../../src/cli/commands/report.js";
import { MAX_CORPUS_READ_BYTES, usageMain } from "../../src/analytics/usageStats.js";
import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers, readCurrentGeneration, readSignalTier } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { tiersDirForCorpusPath } from "../../src/analytics/extractCorpus/tierReader.js";
import {
  personalGlossaryCandidateProjectionPath,
  readPersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";

function run(args: ReportArgs): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = cmdReport(args, { out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("statsExistingCorpusStatus", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "corpusstat-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies a missing corpus", () => {
    const s = statsExistingCorpusStatus(path.join(tmp, "nope.json"));
    expect(s.status).toBe("missing");
  });
  it("classifies unreadable JSON as stale", () => {
    const p = path.join(tmp, "corpus.json");
    fs.writeFileSync(p, "{ not json");
    expect(statsExistingCorpusStatus(p).status).toBe("stale");
  });
  it("classifies a corpus with no conversation_turn records as stale", () => {
    const p = path.join(tmp, "corpus.json");
    fs.writeFileSync(p, JSON.stringify({ records: [{ source_kind: "other" }] }));
    expect(statsExistingCorpusStatus(p).status).toBe("stale");
  });
  it("classifies an oversized corpus as stale with repair guidance", () => {
    const p = path.join(tmp, "corpus.json");
    const fd = fs.openSync(p, "w");
    fs.ftruncateSync(fd, MAX_CORPUS_READ_BYTES + 1);
    fs.closeSync(fd);
    const s = statsExistingCorpusStatus(p);
    expect(s.status).toBe("stale");
    expect(s.reason).toContain("too large to load");
  });
  it("classifies a corpus with conversation_turn records as ready", () => {
    const p = path.join(tmp, "corpus.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        metadata: { extracted_at: "2026-01-02T03:04:05Z" },
        records: [{ source_kind: "conversation_turn" }],
      }),
    );
    const s = statsExistingCorpusStatus(p);
    expect(s.status).toBe("ready");
    expect(s.extracted_at).toBe("2026-01-02T03:04:05Z");
    expect(s.total_records).toBe(1);
  });

  it("reports tier-aware ready status with tier_path when tiers are published", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    const records = [
      {
        source_id: "c1",
        source_kind: "conversation_turn",
        timestamp: "2026-01-01T00:00:00.000Z",
        project_id: "demo",
        runtime: "opencode",
        source_class: "active_runtime",
        source_product: "opencode",
        active_runtime: true,
        adapter_version: ADAPTER_VERSION,
        session_id: "session-c1",
        conversation_key: "session-c1",
        origin_id: originIdentity("fixture:c1"),
        content_fingerprint: contentFingerprint("hi"),
        author_class: "user",
        data: { actor: "user", text: "hi" },
      },
    ];
    const runtimeStatuses = [
      { runtime: "opencode", source_product: "opencode", source_class: "active_runtime", active_runtime: true, status: "available", reason: "candidate_files_found" },
    ];
    publishEvidenceTiers(records, {
      tiersDir: tiersDirForCorpusPath(corpusPath),
      adapterVersion: ADAPTER_VERSION,
      runtimeStatuses,
      publishedAt: "2026-01-15T00:00:00.000Z",
      corpusMetadata: {
        extracted_at: "2026-01-15T00:00:00Z",
        runtime_statuses: runtimeStatuses,
        coverage_envelope: {
          available_runtimes: ["opencode"],
          selected_runtimes: ["opencode"],
          available_but_not_selected: [],
        },
      },
    });
    const s = statsExistingCorpusStatus(corpusPath);
    expect(s.status).toBe("ready");
    expect(s.tier_state).toBe("current");
    expect(s.tier_path).toBeTruthy();
    expect(s.total_records).toBe(1);
  });

  it("reports tier-aware missing status when tiers are missing and no legacy corpus", () => {
    const s = statsExistingCorpusStatus(path.join(tmp, "missing.json"));
    expect(s.status).toBe("missing");
  });
});

describe("statsCorpusPath", () => {
  it("prefers AGENTERA_PROFILE_DIR, then AGENTERA_HOME", () => {
    expect(statsCorpusPath({ AGENTERA_PROFILE_DIR: "/p" }, "linux")).toBe(path.join("/p", "intermediate", "corpus.json"));
    expect(statsCorpusPath({ AGENTERA_HOME: "/h" }, "linux")).toBe(path.join("/h", "intermediate", "corpus.json"));
  });
});

describe("cmdReport", () => {
  let tmp: string;
  let prev: string | undefined;
  let prevHome: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-"));
    prev = process.env.AGENTERA_PROFILE_DIR;
    prevHome = process.env.HOME;
    process.env.AGENTERA_PROFILE_DIR = tmp;
    process.env.HOME = tmp;
    process.env.XDG_DATA_HOME = path.join(tmp, ".local", "share");
    process.env.CURSOR_HOME = path.join(tmp, ".cursor");
    process.env.COPILOT_HOME = path.join(tmp, ".copilot");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTERA_PROFILE_DIR;
    else process.env.AGENTERA_PROFILE_DIR = prev;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete process.env.XDG_DATA_HOME;
    delete process.env.CURSOR_HOME;
    delete process.env.COPILOT_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects an invalid --format with the usage Error message", () => {
    const { rc, err } = run({ format: "xml" });
    expect(rc).toBe(2);
    expect(err).toContain("Error: unsupported usage format 'xml'");
  });

  it("reports a missing corpus as not-ready (rc 2)", () => {
    const { rc, out } = run({ format: "json" });
    expect(rc).toBe(2);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("stats");
    expect(payload.status).toBe("missing");
    expect(payload.next).toBe("agentera stats refresh --dry-run");
  });

  it("rejects refresh with both --dry-run and --consent", () => {
    const { rc, err } = run({ action: "refresh", dryRun: true, consent: "local-history" });
    expect(rc).toBe(2);
    expect(err).toContain("either --dry-run or --consent");
  });

  it("rejects refresh without consent", () => {
    const { rc, err } = run({ action: "refresh" });
    expect(rc).toBe(2);
    expect(err).toContain("requires explicit --consent local-history");
  });

  it("does not scan local history before consent and returns bounded recovery", () => {
    const scan = vi.spyOn(fs, "readdirSync");
    try {
      const { rc, out, err } = run({ action: "refresh", format: "json" });
      expect(rc).toBe(2);
      const payload = JSON.parse(out);
      expect(payload.status).toBe("degraded_consent_required");
      expect(payload.recovery).toBe("agentera report refresh --consent local-history");
      expect(payload.privacy.local_history_read).toBe(false);
      expect(payload.privacy.tier_write).toBe(false);
      expect(scan).not.toHaveBeenCalled();
      expect(err).toContain("Recovery:");
    } finally {
      scan.mockRestore();
    }
  });

  it("previews refresh in dry-run mode (json)", () => {
    const outp = path.join(tmp, "intermediate", "corpus.json");
    const { rc, out } = run({
      action: "refresh",
      dryRun: true,
      format: "json",
      output: outp,
      projectRoot: [tmp],
      noCodex: true,
      noOpencode: true,
      noCopilot: true,
      noCursor: true,
    });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("stats refresh");
    expect(payload.status).toBe("dry_run");
    expect(payload.privacy).toEqual({
      local_history_read: false,
      local_history_write: false,
      tier_write: false,
      required_consent: "local-history",
      provided_consent: null,
    });
    expect(payload.diagnostics).toEqual([
      "dry-run does not read runtime history or write tier files",
      "published tiers are internal state for stats at $AGENTERA_PROFILE_DIR/intermediate/tiers",
    ]);
    expect(fs.existsSync(outp)).toBe(false); // dry-run writes nothing
  });

  it("runs the corpus extractor on refresh --consent local-history (json)", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# rules\nprefer X.\n");
    const outp = path.join(tmp, "intermediate", "corpus.json");
    const { rc, out } = run({
      action: "refresh",
      consent: "local-history",
      format: "json",
      output: outp,
      projectRoot: [tmp],
      codexSessionsDir: path.join(tmp, "stores", "codex"),
      opencodeConversationsDir: path.join(tmp, "stores", "opencode.db"),
      copilotConversationsDir: path.join(tmp, "stores", "copilot"),
      cursorProjectsDir: path.join(tmp, "stores", "cursor-projects"),
      cursorChatsDir: path.join(tmp, "stores", "cursor-chats"),
      noCodex: true,
      noOpencode: true,
      noCopilot: true,
      noCursor: true,
    });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("stats refresh");
    expect(payload.status).toBe("pass");
    expect(payload.privacy.tier_write).toBe(true);
    expect(payload.privacy.projection_write).toBe(true);
    expect(payload.evidence.status).toBe("published");
    expect(payload.projection.status).toBe("published");
    // No monolithic corpus.json written — tiers are the canonical output.
    expect(fs.existsSync(outp)).toBe(false);
    const tiersDir = path.join(tmp, "intermediate", "tiers");
    const tier = readSignalTier(tiersDir);
    expect(tier).not.toBeNull();
    expect(tier!.manifest.total_records).toBeGreaterThanOrEqual(1);
  });

  it("fails refresh truthfully when an unsafe projection target rejects replacement", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# rules\nprefer X.\n");
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const outside = path.join(tmp, "outside-projection");
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    fs.writeFileSync(outside, "outside unchanged\n");
    fs.symlinkSync(outside, projectionPath);

    const { rc, out } = run({
      action: "refresh",
      consent: "local-history",
      format: "json",
      output: path.join(tmp, "intermediate", "corpus.json"),
      projectRoot: [tmp],
      codexSessionsDir: path.join(tmp, "stores", "codex"),
      opencodeConversationsDir: path.join(tmp, "stores", "opencode.db"),
      copilotConversationsDir: path.join(tmp, "stores", "copilot"),
      cursorProjectsDir: path.join(tmp, "stores", "cursor-projects"),
      cursorChatsDir: path.join(tmp, "stores", "cursor-chats"),
      noCodex: true,
      noOpencode: true,
      noCopilot: true,
      noCursor: true,
    });
    const payload = JSON.parse(out);
    expect(rc).toBe(1);
    expect(payload).toMatchObject({
      status: "fail",
      evidence: { status: "published" },
      projection: {
        status: "failed",
        recovery: "npx -y agentera@next report refresh --consent local-history",
      },
      privacy: { tier_write: true, projection_write: false },
    });
    expect(fs.readFileSync(outside, "utf8")).toBe("outside unchanged\n");
    expect(readSignalTier(path.join(tmp, "intermediate", "tiers"))).not.toBeNull();
  });

  it("rejects an interleaved refresh before it can overwrite the winning current projection", () => {
    const source = path.join(tmp, "AGENTS.md");
    const output = path.join(tmp, "intermediate", "corpus.json");
    const args: ReportArgs = {
      action: "refresh",
      consent: "local-history",
      format: "json",
      output,
      projectRoot: [tmp],
      codexSessionsDir: path.join(tmp, "stores", "codex"),
      opencodeConversationsDir: path.join(tmp, "stores", "opencode.db"),
      copilotConversationsDir: path.join(tmp, "stores", "copilot"),
      cursorProjectsDir: path.join(tmp, "stores", "cursor-projects"),
      cursorChatsDir: path.join(tmp, "stores", "cursor-chats"),
      noCodex: true,
      noOpencode: true,
      noCopilot: true,
      noCursor: true,
    };
    fs.writeFileSync(source, "# rules\nprefer the first shape.\n");
    expect(run(args).rc).toBe(0);
    const projectionPath = personalGlossaryCandidateProjectionPath();
    const priorProjection = fs.readFileSync(projectionPath);
    fs.writeFileSync(source, "# rules\nprefer the winning shape.\n");

    const tiersDir = path.join(tmp, "intermediate", "tiers");
    const currentPath = path.join(tiersDir, "current.json");
    const originalRename = fs.renameSync;
    let interleaved = false;
    let projectionAfterLoser: Buffer | null = null;
    let loser: ReturnType<typeof run> | null = null;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from, to) => {
      originalRename(from, to);
      if (!interleaved && String(to) === currentPath) {
        interleaved = true;
        loser = run(args);
        projectionAfterLoser = fs.readFileSync(projectionPath);
      }
    }) as typeof fs.renameSync);

    let winner: ReturnType<typeof run>;
    try {
      winner = run(args);
    } finally {
      rename.mockRestore();
    }

    expect(winner.rc).toBe(0);
    expect(loser).not.toBeNull();
    const loserPayload = JSON.parse(loser!.out);
    const current = readCurrentGeneration(tiersDir)!;
    const projection = readPersonalGlossaryCandidateProjection().projection!;
    expect(loser!.rc).toBe(1);
    expect(loserPayload).toMatchObject({
      status: "fail",
      evidence: { status: "readable", generation: current.manifest.generation },
      projection: {
        status: "failed",
        reason: "another consented refresh is still publishing the current candidate projection",
        recovery: "npx -y agentera@next report refresh --consent local-history",
      },
      privacy: {
        local_history_read: false,
        tier_write: false,
        projection_write: false,
      },
    });
    expect(projectionAfterLoser).toEqual(priorProjection);
    expect(projection.generation).toBe(current.manifest.generation);
    expect(JSON.parse(winner.out).projection.generation).toBe(current.manifest.generation);
    expect(fs.existsSync(path.join(path.dirname(projectionPath), ".refresh.lock"))).toBe(false);
  });

  it("rejects an unknown action", () => {
    const { rc, err } = run({ action: "bogus" });
    expect(rc).toBe(2);
    expect(err).toContain("unsupported stats action 'bogus'");
  });

  it("reports an oversized corpus as not-ready (rc 2)", () => {
    fs.mkdirSync(path.join(tmp, "intermediate"), { recursive: true });
    const p = path.join(tmp, "intermediate", "corpus.json");
    const fd = fs.openSync(p, "w");
    fs.ftruncateSync(fd, MAX_CORPUS_READ_BYTES + 1);
    fs.closeSync(fd);
    const { rc, out } = run({ format: "json" });
    expect(rc).toBe(2);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("stale");
    expect(payload.reason).toContain("too large to load");
  });

  it("runs the usage engine over a ready corpus (rc 0)", () => {
    fs.mkdirSync(path.join(tmp, "intermediate"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "intermediate", "corpus.json"),
      JSON.stringify({
        metadata: { extracted_at: "2026-01-02T03:04:05Z" },
        records: [{ source_kind: "conversation_turn", project_id: "agentera", role: "assistant", timestamp: "t", text: "x" }],
      }),
    );
    const { rc, out } = run({ format: "json" });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(typeof payload.generated_at).toBe("string");
    expect(payload.extracted_at).toBe("2026-01-02T03:04:05Z");
  });
});

describe("usageMain oversized corpus", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-oversized-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("degrades with guidance instead of throwing on oversized corpus", () => {
    const p = path.join(tmp, "corpus.json");
    const fd = fs.openSync(p, "w");
    fs.ftruncateSync(fd, MAX_CORPUS_READ_BYTES + 1);
    fs.closeSync(fd);
    let err = "";
    const rc = usageMain(["--corpus", p, "--json"], {
      out: () => undefined,
      err: (t) => (err += t),
    });
    expect(rc).not.toBe(0);
    expect(err).toContain("too large to load");
  });
});
