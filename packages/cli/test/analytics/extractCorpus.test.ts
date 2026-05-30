import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCorpus,
  dedupeRecords,
  discoverRuntimeStore,
  extractCopilotSessions,
  extractCorpusMain,
  extractCursorAgentSessions,
  extractInstructionDocuments,
  extractOpencodeSessions,
  extractProjectConfigSignals,
  projectIdFromPath,
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
    expect(d.candidate_count).toBe(1);
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
    expect(corpus.records.some((r: any) => r.source_kind === "conversation_turn")).toBe(true);
  });

  it("extractCorpusMain writes corpus.json and returns 0", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# rules\n");
    const outp = path.join(tmp, "out", "corpus.json");
    let log = "";
    const rc = extractCorpusMain(
      ["--output", outp, "--project-root", tmp, "--no-codex", "--no-claude", "--no-opencode", "--no-copilot", "--no-cursor"],
      { out: (t) => (log += t + "\n"), env: {}, cwd: tmp },
    );
    expect(rc).toBe(0);
    expect(fs.existsSync(outp)).toBe(true);
    expect(log).toContain("wrote corpus:");
    const c = JSON.parse(fs.readFileSync(outp, "utf-8"));
    expect(c.metadata.families.instruction_document.count).toBe(1);
  });
});
