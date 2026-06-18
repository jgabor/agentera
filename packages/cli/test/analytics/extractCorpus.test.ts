import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCorpus,
  COVERAGE_EXIT_FLAGGED,
  dedupeRecords,
  discoverRuntimeStore,
  extractCopilotSessions,
  extractCorpusMain,
  extractCursorAgentSessions,
  extractInstructionDocuments,
  extractOpencodeSessions,
  extractProjectConfigSignals,
  formatCoverageSummaryText,
  projectIdFromPath,
  runCoverageAudit,
  signalType,
  stableId,
} from "../../src/analytics/extractCorpus.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extract-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extract_corpus helpers", () => {
  it("stableId is deterministic 24-hex", () => {
    const a = stableId("conversation_turn", "/p", 1, "user");
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(stableId("conversation_turn", "/p", 1, "user")).toBe(a);
    expect(stableId("conversation_turn", "/p", 2, "user")).not.toBe(a);
  });
  it("projectIdFromPath slugs the basename, null -> global", () => {
    expect(projectIdFromPath(null)).toBe("global");
    expect(projectIdFromPath("/home/me/My Proj!")).toBe("my-proj");
  });
  it("signalType classifies decision/question/correction", () => {
    expect(signalType("should we avoid this?")).toBe("question");
    expect(signalType("no, actually prefer X")).toBe("correction");
    expect(signalType("let's decide to keep it")).toBe("decision");
    expect(signalType("hello there")).toBeNull();
  });
});

describe("filesystem extractors", () => {
  it("extracts AGENTS.md instruction docs + package.json config signals", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# rules\nprefer X.\n");
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "tsc" }, dependencies: { yaml: "^2" } }));
    const errors: string[] = [];
    const docs = extractInstructionDocuments([tmp], errors);
    const cfg = extractProjectConfigSignals([tmp], errors);
    expect(docs).toHaveLength(1);
    expect(docs[0].source_kind).toBe("instruction_document");
    expect(docs[0].data.doc_type).toBe("agents_md");
    expect(cfg).toHaveLength(1);
    expect(cfg[0].data.config_type).toBe("package_json");
    expect(cfg[0].data.signals).toContain("name=demo");
    expect(cfg[0].data.signals).toContain("dependencies:yaml");
    expect(errors).toEqual([]);
  });
});

describe("discoverRuntimeStore", () => {
  it("missing store", () => {
    expect(discoverRuntimeStore("codex", path.join(tmp, "nope")).status).toBe("missing");
  });
  it("disabled (null)", () => {
    expect(discoverRuntimeStore("codex", null).status).toBe("skipped");
  });
  it("available file store for opencode", () => {
    const f = path.join(tmp, "opencode.db");
    fs.writeFileSync(f, "");
    const d = discoverRuntimeStore("opencode", f);
    expect(d.status).toBe("available");
    expect(d.file_count).toBe(1);
    expect(d).not.toHaveProperty("candidate_count");
  });
});

function seedOpencode(dbp: string): void {
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE session(id TEXT, cwd TEXT, time_created INTEGER)");
  db.exec("CREATE TABLE message(id TEXT, sessionID TEXT, role TEXT, time_created INTEGER, content TEXT, data TEXT)");
  db.exec("CREATE TABLE part(id TEXT, messageID TEXT, type TEXT, text TEXT, data TEXT, time_created INTEGER)");
  db.prepare("INSERT INTO session VALUES (?,?,?)").run("s1", "/proj/foo", 1700000000);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run("m1", "s1", "user", 1700000001, null, null);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run("m2", "s1", "assistant", 1700000002, null, null);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p1", "m1", "text", "why should we avoid this approach?", null, 1700000001);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p2", "m2", "text", "Because of the tradeoff.", null, 1700000002);
  db.close();
}

function seedOpencodeManySessions(dbp: string, count: number, baseTime = 1_700_000_000): void {
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE session(id TEXT, cwd TEXT, time_created INTEGER)");
  db.exec("CREATE TABLE message(id TEXT, sessionID TEXT, role TEXT, time_created INTEGER, content TEXT, data TEXT)");
  db.exec("CREATE TABLE part(id TEXT, messageID TEXT, type TEXT, text TEXT, data TEXT, time_created INTEGER)");
  for (let i = 0; i < count; i++) {
    const sid = `s${i}`;
    const ts = baseTime + i;
    db.prepare("INSERT INTO session VALUES (?,?,?)").run(sid, "/proj", ts);
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(`m${i}`, sid, "user", ts, null, null);
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(`p${i}`, `m${i}`, "text", "hello", null, ts);
  }
  db.close();
}

describe("SQLite extractors (node:sqlite)", () => {
  it("opencode: conversation_turn + history_prompt with signal", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencode(dbp);
    const errors: string[] = [];
    const recs = extractOpencodeSessions(dbp, errors);
    const kinds = recs.map((r) => r.source_kind).sort();
    expect(kinds).toEqual(["conversation_turn", "conversation_turn", "history_prompt"]);
    const userTurn = recs.find((r) => r.data.actor === "user");
    expect(userTurn!.data.signal_type).toBe("question");
    expect(userTurn!.runtime).toBe("opencode");
    expect(errors).toEqual([]);
  });

  it("copilot: extracts turns from sessions/turns schema", () => {
    const dbp = path.join(tmp, "session-store.db");
    const db = new DatabaseSync(dbp);
    db.exec("CREATE TABLE sessions(id TEXT, cwd TEXT, time INTEGER)");
    db.exec("CREATE TABLE turns(id TEXT, session_id TEXT, role TEXT, time INTEGER, content TEXT)");
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s1", "/proj", 1700000000);
    db.prepare("INSERT INTO turns VALUES (?,?,?,?,?)").run("t1", "s1", "user", 1700000001, "should we change the plan?");
    db.close();
    const errors: string[] = [];
    const recs = extractCopilotSessions(dbp, errors);
    expect(recs.some((r) => r.source_kind === "conversation_turn" && r.runtime === "github-copilot")).toBe(true);
    expect(recs.some((r) => r.source_kind === "history_prompt")).toBe(true);
  });

  it("cursor-agent: extracts blob messages from store.db", () => {
    const chats = path.join(tmp, "chats");
    const ws = path.join(chats, "wshash");
    const sess = path.join(ws, "sess1");
    fs.mkdirSync(sess, { recursive: true });
    const dbp = path.join(sess, "store.db");
    const db = new DatabaseSync(dbp);
    db.exec("CREATE TABLE blobs(id INTEGER, data BLOB)");
    const msg = JSON.stringify({ role: "user", content: [{ type: "text", text: "why avoid this?" }] });
    db.prepare("INSERT INTO blobs VALUES (?,?)").run(1, Buffer.from(msg, "utf-8"));
    db.close();
    const errors: string[] = [];
    const recs = extractCursorAgentSessions(chats, errors, [], null);
    expect(recs.some((r) => r.runtime === "cursor-agent" && r.source_kind === "conversation_turn")).toBe(true);
  });
});

describe("dedupeRecords", () => {
  it("dedupes by source_id and sorts by timestamp/kind/actor/id", () => {
    const r = (id: string, ts: string, kind: string, actor?: string) => ({
      source_id: id,
      timestamp: ts,
      source_kind: kind,
      data: actor ? { actor } : {},
    });
    const out = dedupeRecords([
      r("b", "2026-01-02", "conversation_turn", "assistant"),
      r("a", "2026-01-01", "conversation_turn", "user"),
      r("a", "2026-01-01", "conversation_turn", "user"), // dup id -> last wins
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBe("2026-01-01");
  });
});

function isolatedEnv(root: string): Record<string, string> {
  return {
    HOME: root,
    XDG_DATA_HOME: path.join(root, ".local", "share"),
    CURSOR_HOME: path.join(root, ".cursor"),
    CURSOR_CONFIG_HOME: path.join(root, ".config", "cursor"),
    COPILOT_HOME: path.join(root, ".copilot"),
    AGENTERA_HOME: root,
  };
}

describe("coverage audit", () => {
  it("flags available-but-skipped runtimes without accept flag", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencode(dbp);
    let log = "";
    let errLog = "";
    const rc = extractCorpusMain(
      [
        "--output",
        path.join(tmp, "out", "corpus.json"),
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-opencode",
        "--no-codex",
        "--no-claude",
        "--no-copilot",
        "--no-cursor",
      ],
      { out: (t) => (log += t + "\n"), err: (t) => (errLog += t), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(COVERAGE_EXIT_FLAGGED);
    expect(log).toContain("Coverage Audit (pre-extraction)");
    expect(log).toContain("opencode: available");
    expect(log).toContain("Skipped available runtimes:");
    expect(log).toContain("disabled_by_flag");
    expect(errLog).toContain("EX2");
    expect(fs.existsSync(path.join(tmp, "out", "corpus.json"))).toBe(false);
  });

  it("proceeds when user accepts coverage gap", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencode(dbp);
    const outp = path.join(tmp, "out", "corpus.json");
    let log = "";
    const rc = extractCorpusMain(
      [
        "--output",
        outp,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-opencode",
        "--no-codex",
        "--no-claude",
        "--no-copilot",
        "--no-cursor",
        "--accept-coverage-gap",
      ],
      { out: (t) => (log += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    expect(log.startsWith("Coverage Audit (pre-extraction)")).toBe(true);
    expect(log).toContain("Coverage gap accepted");
    expect(fs.existsSync(outp)).toBe(true);
    const corpus = JSON.parse(fs.readFileSync(outp, "utf-8"));
    expect(corpus.metadata.available_runtimes).toEqual(["opencode"]);
    expect(corpus.metadata.selected_runtimes).not.toContain("opencode");
    expect(corpus.metadata.available_but_not_selected).toEqual([
      { runtime: "opencode", reason: "disabled_by_flag", store_path: dbp },
    ]);
  });

  it("does not flag when all available runtimes are selected", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencode(dbp);
    const audit = runCoverageAudit(
      {
        output: path.join(tmp, "corpus.json"),
        projectRoot: [tmp],
        codexSessionsDir: path.join(tmp, "nope"),
        claudeProjectsDir: path.join(tmp, "nope2"),
        opencodeConversationsDir: dbp,
        copilotConversationsDir: null,
        cursorProjectsDir: null,
        cursorChatsDir: null,
        noCodex: true,
        noClaude: true,
        noOpencode: false,
        noCopilot: true,
        noCursor: true,
        acceptCoverageGap: false,
        coverageAuditOnly: false,
        format: "text",
      },
      isolatedEnv(tmp),
    );
    expect(audit.coverage_gap_flagged).toBe(false);
    expect(audit.available_runtimes).toEqual(["opencode"]);
    expect(audit.skipped_available).toEqual([]);
    const summary = formatCoverageSummaryText(audit);
    expect(summary).toContain("All available runtimes are selected");
    expect(summary).toMatch(/earliest|sessions=/);
  });

  it("coverage-audit-only emits summary without writing corpus", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencode(dbp);
    const outp = path.join(tmp, "out", "corpus.json");
    let log = "";
    const rc = extractCorpusMain(
      [
        "--output",
        outp,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-codex",
        "--no-claude",
        "--no-copilot",
        "--no-cursor",
        "--coverage-audit-only",
      ],
      { out: (t) => (log += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    expect(log).toContain("Coverage Audit (pre-extraction)");
    expect(fs.existsSync(outp)).toBe(false);
  });
});

describe("runtime metadata file_count", () => {
  it("reports file_count=1 and record_count>>1 for SQLite stores with many records", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeManySessions(dbp, 100);
    const corpus = buildCorpus({
      projectRoots: [tmp],
      codexSessionsDir: null,
      claudeProjectsDir: null,
      opencodeConversationsDir: dbp,
      sqliteCaps: { maxSessions: 100, maxRows: 100_000 },
    });
    const opencodeStatus = corpus.metadata.runtime_statuses.find((s: { runtime: string }) => s.runtime === "opencode");
    expect(opencodeStatus?.file_count).toBe(1);
    expect(opencodeStatus?.record_count).toBeGreaterThan(1);
    expect(opencodeStatus?.record_count).toBeGreaterThan(opencodeStatus?.file_count ?? 0);
    expect(opencodeStatus).not.toHaveProperty("candidate_count");
  });
});

describe("buildCorpus + extractCorpusMain", () => {
  it("builds the corpus envelope from a project + opencode store", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# rules\nprefer X.\n");
    const dbp = path.join(tmp, "opencode.db");
    seedOpencode(dbp);
    const corpus = buildCorpus({
      projectRoots: [tmp],
      codexSessionsDir: null,
      claudeProjectsDir: null,
      opencodeConversationsDir: dbp,
    });
    expect(corpus.metadata.adapter_version).toBe("agentera-v2-corpus-1");
    expect(corpus.metadata.families.instruction_document.count).toBe(1);
    expect(corpus.metadata.families.conversation_turn.count).toBeGreaterThanOrEqual(1);
    expect(corpus.metadata.runtimes).toContain("opencode");
    expect(corpus.metadata.runtimes).toContain("filesystem");
    expect(corpus.metadata.available_runtimes).toEqual([]);
    expect(corpus.metadata.selected_runtimes).toEqual([]);
    expect(corpus.metadata.available_but_not_selected).toEqual([]);
    expect(corpus.records.some((r: any) => r.source_kind === "conversation_turn")).toBe(true);
  });

  it("extractCorpusMain writes corpus.json and returns 0", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# rules\n");
    const outp = path.join(tmp, "out", "corpus.json");
    let log = "";
    const rc = extractCorpusMain(
      [
        "--output",
        outp,
        "--project-root",
        tmp,
        "--codex-sessions-dir",
        path.join(tmp, "stores", "codex"),
        "--claude-projects-dir",
        path.join(tmp, "stores", "claude"),
        "--opencode-conversations-dir",
        path.join(tmp, "stores", "opencode.db"),
        "--copilot-conversations-dir",
        path.join(tmp, "stores", "copilot"),
        "--cursor-projects-dir",
        path.join(tmp, "stores", "cursor-projects"),
        "--cursor-chats-dir",
        path.join(tmp, "stores", "cursor-chats"),
        "--no-codex",
        "--no-claude",
        "--no-opencode",
        "--no-copilot",
        "--no-cursor",
      ],
      { out: (t) => (log += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    expect(fs.existsSync(outp)).toBe(true);
    expect(log).toContain("wrote corpus:");
    const c = JSON.parse(fs.readFileSync(outp, "utf-8"));
    expect(c.metadata.families.instruction_document.count).toBe(1);
  });
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
    const outp = path.join(tmp, "out", "corpus.json");
    let errLog = "";
    const rc = extractCorpusMain(
      [
        "--output",
        outp,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-codex",
        "--no-claude",
        "--no-copilot",
        "--no-cursor",
        "--max-sqlite-sessions",
        "100",
      ],
      { out: () => {}, err: (t) => (errLog += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    const corpus = JSON.parse(fs.readFileSync(outp, "utf-8"));
    const opencodeStatus = corpus.metadata.runtime_statuses.find((s: { runtime: string }) => s.runtime === "opencode");
    expect(opencodeStatus?.truncated_at).toBeUndefined();
    expect(errLog).not.toContain("SQLite extraction truncated");
  });

  it("honors AGENTERA_EXTRACT_MAX_SQLITE_SESSIONS env override", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeManySessions(dbp, 65);
    const outp = path.join(tmp, "out", "corpus-env.json");
    const rc = extractCorpusMain(
      [
        "--output",
        outp,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-codex",
        "--no-claude",
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
    const corpus = JSON.parse(fs.readFileSync(outp, "utf-8"));
    const opencodeStatus = corpus.metadata.runtime_statuses.find((s: { runtime: string }) => s.runtime === "opencode");
    expect(opencodeStatus?.truncated_at).toBeUndefined();
  });

  it("emits user-visible truncation warning after extraction", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeManySessions(dbp, 65);
    const outp = path.join(tmp, "out", "corpus.json");
    let errLog = "";
    const rc = extractCorpusMain(
      [
        "--output",
        outp,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-codex",
        "--no-claude",
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
