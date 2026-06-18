import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdReport, statsCorpusPath, statsExistingCorpusStatus, ReportArgs } from "../../src/cli/commands/report.js";
import { MAX_CORPUS_READ_BYTES, usageMain } from "../../src/analytics/usageStats.js";

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
});

describe("statsCorpusPath", () => {
  it("prefers PROFILERA_PROFILE_DIR, then AGENTERA_HOME", () => {
    expect(statsCorpusPath({ PROFILERA_PROFILE_DIR: "/p" }, "linux")).toBe(path.join("/p", "intermediate", "corpus.json"));
    expect(statsCorpusPath({ AGENTERA_HOME: "/h" }, "linux")).toBe(path.join("/h", "intermediate", "corpus.json"));
  });
});

describe("cmdReport", () => {
  let tmp: string;
  let prev: string | undefined;
  let prevHome: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-"));
    prev = process.env.PROFILERA_PROFILE_DIR;
    prevHome = process.env.HOME;
    process.env.PROFILERA_PROFILE_DIR = tmp;
    process.env.HOME = tmp;
    process.env.XDG_DATA_HOME = path.join(tmp, ".local", "share");
    process.env.CURSOR_HOME = path.join(tmp, ".cursor");
    process.env.COPILOT_HOME = path.join(tmp, ".copilot");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PROFILERA_PROFILE_DIR;
    else process.env.PROFILERA_PROFILE_DIR = prev;
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

  it("previews refresh in dry-run mode (json)", () => {
    const outp = path.join(tmp, "intermediate", "corpus.json");
    const { rc, out } = run({
      action: "refresh",
      dryRun: true,
      format: "json",
      output: outp,
      projectRoot: [tmp],
      noCodex: true,
      noClaude: true,
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
      corpus_write: false,
      required_consent: "local-history",
      provided_consent: null,
    });
    expect(payload.diagnostics).toEqual([
      "dry-run does not read runtime history or write corpus files",
      "generated corpus is internal state for stats at $PROFILERA_PROFILE_DIR/intermediate/corpus.json",
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
      claudeProjectsDir: path.join(tmp, "stores", "claude"),
      opencodeConversationsDir: path.join(tmp, "stores", "opencode.db"),
      copilotConversationsDir: path.join(tmp, "stores", "copilot"),
      cursorProjectsDir: path.join(tmp, "stores", "cursor-projects"),
      cursorChatsDir: path.join(tmp, "stores", "cursor-chats"),
      noCodex: true,
      noClaude: true,
      noOpencode: true,
      noCopilot: true,
      noCursor: true,
    });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("stats refresh");
    expect(payload.status).toBe("pass");
    expect(fs.existsSync(outp)).toBe(true);
    const corpus = JSON.parse(fs.readFileSync(outp, "utf-8"));
    expect(corpus.metadata.families.instruction_document.count).toBe(1);
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
