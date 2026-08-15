import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isolatedEnv, seedOpencodeManySessions } from "./extractCorpusFixtures.js";

import {
  buildCorpus,
  COVERAGE_EXIT_FLAGGED,
  contentFingerprint,
  countIndependentOrigins,
  dedupeRecords,
  discoverRuntimeStore,
  extractCopilotSessions,
  extractCorpusMain,
  extractCursorAgentSessions,
  extractInstructionDocuments,
  extractCodexSessions,
  extractOpencodeSessions,
  extractProjectConfigSignals,
  formatCoverageSummaryText,
  projectIdFromPath,
  originIdentity,
  publishEvidenceTiers,
  record,
  runCoverageAudit,
  signalType,
  stableId,
  readSignalTier,
  resolveEvidenceAnchor,
  evidenceTierCompatibility,
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
  it("uses deterministic bounded origin identities and exact content fingerprints", () => {
    expect(originIdentity("instruction://one")).toMatch(/^[a-f0-9]{64}$/);
    expect(originIdentity("instruction://one")).toBe(originIdentity("instruction://one"));
    expect(originIdentity("instruction://one")).not.toBe(originIdentity("instruction://two"));
    expect(contentFingerprint("same")).toBe("0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5");
    expect(contentFingerprint("same")).not.toBe(contentFingerprint("same\n"));
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
    expect(userTurn!.author_class).toBe("user");
    expect(userTurn!.origin_id).toBe(originIdentity("session:s1"));
    expect(userTurn!.content_fingerprint).toBe(contentFingerprint("why should we avoid this approach?"));
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
    const user = recs.find((r) => r.source_kind === "conversation_turn" && r.data.actor === "user");
    expect(user).toMatchObject({ runtime: "copilot", source_product: "github-copilot", author_class: "user" });
    expect(user!.content_fingerprint).toBe(contentFingerprint("should we change the plan?"));
    expect(user!.origin_id).toBe(originIdentity("session:s1"));
    expect(recs.some((r) => r.source_kind === "history_prompt")).toBe(true);
  });

  it("Cursor CLI surface extracts blob messages without becoming a separate runtime", () => {
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
    const user = recs.find((r) => r.runtime === "cursor" && r.source_product === "cursor-agent" && r.source_kind === "conversation_turn");
    expect(user).toMatchObject({ author_class: "user", origin_id: originIdentity("session:sess1") });
    expect(user!.content_fingerprint).toBe(contentFingerprint("why avoid this?"));
  });
});

describe("bounded provenance", () => {
  it("preserves explicit transport origin and author through extraction and tier round-trip", () => {
    const sessionsDir = path.join(tmp, "codex");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const transcript = path.join(sessionsDir, "session.jsonl");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/project" } }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-01-01T00:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            provenance: { origin: "instruction://shared", author_class: "injected_instruction" },
            content: [{ type: "input_text", text: "prefer the bounded route" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        }),
      ].join("\n") + "\n",
    );

    const errors: string[] = [];
    const records = extractCodexSessions(sessionsDir, errors);
    expect(errors).toEqual([]);
    const user = records.find((record) => record.data.actor === "user")!;
    const agent = records.find((record) => record.data.actor === "assistant")!;
    expect(user).toMatchObject({
      origin_id: originIdentity("instruction://shared"),
      author_class: "injected_instruction",
      source_class: "active_runtime",
      runtime: "codex",
      project_id: "project",
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    expect(user.content_fingerprint).toBe(contentFingerprint("prefer the bounded route"));
    expect(agent.author_class).toBe("agent");
    expect(agent.origin_id).not.toBe(user.origin_id);

    const tiersDir = path.join(tmp, "tiers");
    publishEvidenceTiers(records, {
      tiersDir,
      adapterVersion: "agentera-v3-corpus-3",
      runtimeStatuses: [{ runtime: "codex", source_product: "codex", source_class: "active_runtime", active_runtime: true, status: "ok", reason: "records_extracted" }],
      publishedAt: "2026-01-03T00:00:00.000Z",
    });
    const signal = readSignalTier(tiersDir);
    expect(signal).not.toBeNull();
    const transported = signal!.records.find((record) => record.source_id === user.source_id)!;
    expect(transported).toMatchObject({
      origin_id: user.origin_id,
      author_class: "injected_instruction",
      source_class: "active_runtime",
      runtime: "codex",
      project_id: "project",
      timestamp: user.timestamp,
      evidence_anchor: user.source_id,
    });
  });

  it("preserves session provenance and accepts a matching message author override", () => {
    const sessionsDir = path.join(tmp, "codex-session-author");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const transcript = path.join(sessionsDir, "session.jsonl");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "s1",
            cwd: "/project",
            provenance: { origin: "instruction://session", author_class: "injected_instruction" },
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-01-01T00:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "session-bound text" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: {
            type: "message",
            role: "user",
            provenance: { origin: "instruction://session", author_class: "user" },
            content: [{ type: "input_text", text: "specific source wording" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const errors: string[] = [];
    const records = extractCodexSessions(sessionsDir, errors);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(2);
    const sessionBound = records.find((record) => record.data.content === "session-bound text")!;
    const messageOverride = records.find((record) => record.data.content === "specific source wording")!;
    expect(sessionBound).toMatchObject({
      origin_id: originIdentity("instruction://session"),
      author_class: "injected_instruction",
    });
    expect(messageOverride).toMatchObject({
      origin_id: sessionBound.origin_id,
      author_class: "user",
    });

    const tiersDir = path.join(tmp, "session-author-tiers");
    publishEvidenceTiers(records, {
      tiersDir,
      adapterVersion: "agentera-v3-corpus-3",
      runtimeStatuses: [{ runtime: "codex", source_product: "codex", source_class: "active_runtime", active_runtime: true, status: "ok", reason: "records_extracted" }],
      publishedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(evidenceTierCompatibility(tiersDir)).toMatchObject({ state: "current" });
    const signal = readSignalTier(tiersDir)!;
    expect(signal.records).toHaveLength(2);
    expect(signal.records.find((record) => record.source_id === sessionBound.source_id)).toMatchObject({
      origin_id: sessionBound.origin_id,
      author_class: "injected_instruction",
    });
    expect(signal.records.find((record) => record.source_id === messageOverride.source_id)).toMatchObject({
      origin_id: sessionBound.origin_id,
      author_class: "user",
    });
    expect(resolveEvidenceAnchor(sessionBound.source_id as string, tiersDir)).toEqual(sessionBound);
  });

  it("retains a bound author across same-origin partial session metadata", () => {
    const sessionsDir = path.join(tmp, "codex-session-transition-same");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "s1", cwd: "/project", provenance: { origin: "instruction://session", author_class: "injected_instruction" } },
        }),
        JSON.stringify({
          type: "session_meta",
          payload: { id: "s1", provenance: { origin: "instruction://session" } },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "retained session author" }] },
        }),
        JSON.stringify({
          type: "session_meta",
          payload: { id: "s1", provenance: { author_class: "user" } },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "replacement session author" }] },
        }),
      ].join("\n") + "\n",
    );

    const errors: string[] = [];
    const records = extractCodexSessions(sessionsDir, errors);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.data.content === "retained session author")).toMatchObject({
      origin_id: originIdentity("instruction://session"),
      author_class: "injected_instruction",
    });
    expect(records.find((record) => record.data.content === "replacement session author")).toMatchObject({
      origin_id: originIdentity("instruction://session"),
      author_class: "user",
    });
  });

  it("clears a bound author when partial session metadata changes origin", () => {
    const sessionsDir = path.join(tmp, "codex-session-transition-changed");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "s1", cwd: "/project", provenance: { origin: "instruction://one", author_class: "injected_instruction" } },
        }),
        JSON.stringify({
          type: "session_meta",
          payload: { id: "s1", provenance: { origin: "instruction://two" } },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "changed session origin" }] },
        }),
      ].join("\n") + "\n",
    );

    const corpus = buildCorpus({
      projectRoots: [],
      codexSessionsDir: sessionsDir,
      claudeProjectsDir: null,
      opencodeConversationsDir: null,
      copilotConversationsDir: null,
      cursorProjectsDir: null,
      cursorChatsDir: null,
    });
    expect(corpus.records).toHaveLength(1);
    expect(corpus.records[0]).toMatchObject({
      origin_id: originIdentity("instruction://two"),
      data: { actor: "user", content: "changed session origin" },
    });
    expect(corpus.records[0]!.author_class).toBeUndefined();
    expect(corpus.metadata.runtime_statuses.find((item) => item.runtime === "codex")).toMatchObject({
      status: "degraded",
      reason: "provenance_missing",
      provenance_missing_fields: ["author_class"],
      provenance_missing_records: 1,
    });
  });

  it("distinguishes absent message origin from malformed message provenance", () => {
    const sessionsDir = path.join(tmp, "codex-message-provenance-shapes");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const message = (timestamp: string, text: string, provenance: Record<string, unknown>) => JSON.stringify({
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "user",
        provenance,
        content: [{ type: "input_text", text }],
      },
    });
    fs.writeFileSync(
      path.join(sessionsDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "s1", cwd: "/project", provenance: { origin: "instruction://session", author_class: "injected_instruction" } },
        }),
        message("2026-01-01T00:00:01.000Z", "author only absent origin", { author_class: "user" }),
        message("2026-01-01T00:00:02.000Z", "malformed origin with author", { origin: 42, author_class: "user" }),
        message("2026-01-01T00:00:03.000Z", "malformed author with origin", { origin: "instruction://session", author_class: [] }),
        message("2026-01-01T00:00:04.000Z", "matching origin without author", { origin: "instruction://session" }),
        message("2026-01-01T00:00:05.000Z", "malformed author without origin", { author_class: null }),
        message("2026-01-01T00:00:06.000Z", "malformed origin without author", { origin: "" }),
      ].join("\n") + "\n",
    );

    const corpus = buildCorpus({
      projectRoots: [],
      codexSessionsDir: sessionsDir,
      claudeProjectsDir: null,
      opencodeConversationsDir: null,
      copilotConversationsDir: null,
      cursorProjectsDir: null,
      cursorChatsDir: null,
    });
    expect(corpus.records).toHaveLength(6);
    const byContent = new Map(corpus.records.map((record) => [record.data.content, record]));
    const sessionOrigin = originIdentity("instruction://session");
    expect(byContent.get("author only absent origin")).toMatchObject({ origin_id: sessionOrigin, author_class: "user" });
    expect(byContent.get("matching origin without author")).toMatchObject({ origin_id: sessionOrigin, author_class: "injected_instruction" });
    for (const text of [
      "malformed origin with author",
      "malformed author with origin",
      "malformed author without origin",
      "malformed origin without author",
    ]) {
      expect(byContent.get(text)).toMatchObject({ origin_id: sessionOrigin, data: { actor: "user", content: text } });
      expect(byContent.get(text)!.author_class).toBeUndefined();
    }
    expect(corpus.metadata.runtime_statuses.find((item) => item.runtime === "codex")).toMatchObject({
      status: "degraded",
      reason: "provenance_missing",
      provenance_missing_fields: ["author_class"],
      provenance_missing_records: 4,
    });

    const tiersDir = path.join(tmp, "message-provenance-shape-tiers");
    publishEvidenceTiers(corpus.records, {
      tiersDir,
      adapterVersion: "agentera-v3-corpus-3",
      runtimeStatuses: corpus.metadata.runtime_statuses,
      publishedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(evidenceTierCompatibility(tiersDir)).toMatchObject({ state: "incomplete", reason: "provenance_missing" });
    expect(readSignalTier(tiersDir)).toBeNull();
  });

  it("degrades a transported origin when original author provenance is omitted", () => {
    const sessionsDir = path.join(tmp, "codex-author-gap");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const transcript = path.join(sessionsDir, "session.jsonl");
    const message = (timestamp: string, origin: string | null, text: string, authorClass?: string) =>
      JSON.stringify({
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "user",
          ...(origin === null
            ? {}
            : { provenance: { origin, ...(authorClass === undefined ? {} : { author_class: authorClass }) } }),
          content: [{ type: "input_text", text }],
        },
      });
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/project", provenance: { origin: "instruction://session-origin" } } }),
        message("2026-01-01T00:00:01.000Z", "instruction://with-author", "transported with author", "injected_instruction"),
        message("2026-01-01T00:00:02.000Z", "instruction://missing-author", "transported without author"),
        message("2026-01-01T00:00:03.000Z", null, "session origin without author"),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionsDir, "mismatch.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "s2",
            cwd: "/project",
            provenance: { origin: "instruction://authored-session", author_class: "injected_instruction" },
          },
        }),
        message("2026-01-01T00:00:04.000Z", "instruction://mismatched-message", "mismatched message origin"),
      ].join("\n") + "\n",
    );

    const errors: string[] = [];
    const records = extractCodexSessions(sessionsDir, errors);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(4);
    const withAuthor = records.find((record) => record.data.content === "transported with author")!;
    const withoutAuthor = records.find((record) => record.data.content === "transported without author")!;
    const withoutSessionAuthor = records.find((record) => record.data.content === "session origin without author")!;
    const mismatchedMessage = records.find((record) => record.data.content === "mismatched message origin")!;
    expect(withAuthor.author_class).toBe("injected_instruction");
    expect(withoutAuthor.origin_id).toBe(originIdentity("instruction://missing-author"));
    expect(withoutAuthor.author_class).toBeUndefined();
    expect(withoutAuthor.data.actor).toBe("user");
    expect(withoutSessionAuthor.origin_id).toBe(originIdentity("instruction://session-origin"));
    expect(withoutSessionAuthor.author_class).toBeUndefined();
    expect(mismatchedMessage.origin_id).toBe(originIdentity("instruction://mismatched-message"));
    expect(mismatchedMessage.author_class).toBeUndefined();
    expect(mismatchedMessage.data.actor).toBe("user");

    const corpus = buildCorpus({
      projectRoots: [],
      codexSessionsDir: sessionsDir,
      claudeProjectsDir: null,
      opencodeConversationsDir: null,
      copilotConversationsDir: null,
      cursorProjectsDir: null,
      cursorChatsDir: null,
    });
    const status = corpus.metadata.runtime_statuses.find((item) => item.runtime === "codex")!;
    expect(status).toMatchObject({ status: "degraded", reason: "provenance_missing" });
    expect(status.provenance_missing_fields).toContain("author_class");
    expect(status.provenance_missing_records).toBe(3);
    expect(corpus.records.find((record) => record.data.content === "transported without author")!.author_class).toBeUndefined();

    const tiersDir = path.join(tmp, "author-gap-tiers");
    publishEvidenceTiers(corpus.records, {
      tiersDir,
      adapterVersion: "agentera-v3-corpus-3",
      runtimeStatuses: corpus.metadata.runtime_statuses,
      publishedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(evidenceTierCompatibility(tiersDir)).toMatchObject({ state: "incomplete", reason: "provenance_missing" });
    expect(readSignalTier(tiersDir)).toBeNull();
  });

  it("counts one repeated origin/fingerprint once and keeps a distinct origin independent", () => {
    const make = (id: string, origin: string) =>
      record({
        sourceKind: "conversation_turn",
        timestamp: "2026-01-01T00:00:00.000Z",
        projectPath: "/project",
        runtime: "codex",
        sessionId: id,
        origin,
        authorClass: "injected_instruction",
        content: "same injected instruction",
        sourceParts: [id],
        data: { actor: "user", content: "same injected instruction" },
      });
    const repeated = make("s1", "instruction://one");
    const copied = { ...make("s2", "instruction://one"), source_id: "different-record-id" };
    const distinct = make("s3", "instruction://two");
    expect(countIndependentOrigins([repeated, copied])).toBe(1);
    expect(countIndependentOrigins([repeated, copied, distinct])).toBe(2);
  });

  it("degrades coverage for missing provenance instead of loading a user conversation", () => {
    const record = {
      source_id: "missing-provenance",
      source_kind: "conversation_turn",
      timestamp: "2026-01-01T00:00:00.000Z",
      project_id: "project",
      runtime: "codex",
      source_class: "active_runtime",
      source_product: "codex",
      active_runtime: true,
      adapter_version: "agentera-v3-corpus-3",
      data: { actor: "assistant", content: "unknown origin" },
    };
    const tiersDir = path.join(tmp, "missing-provenance-tiers");
    publishEvidenceTiers([record], { tiersDir, adapterVersion: "agentera-v3-corpus-3" });
    const assessment = evidenceTierCompatibility(tiersDir);
    expect(assessment.state).toBe("incomplete");
    expect(assessment.reason).toBe("provenance_missing");
    expect(readSignalTier(tiersDir)).toBeNull();
  });

  it("flags an adapter with an unknown author rather than converting it to user", () => {
    const sessionsDir = path.join(tmp, "codex-unknown");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "session.jsonl"),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "external", content: [{ type: "input_text", text: "prefer this" }] } }) + "\n",
    );
    const corpus = buildCorpus({
      projectRoots: [],
      codexSessionsDir: sessionsDir,
      claudeProjectsDir: null,
      opencodeConversationsDir: null,
      copilotConversationsDir: null,
      cursorProjectsDir: null,
      cursorChatsDir: null,
    });
    const status = corpus.metadata.runtime_statuses.find((item) => item.runtime === "codex")!;
    expect(status).toMatchObject({ status: "degraded", reason: "provenance_missing" });
    expect(status.provenance_missing_fields).toContain("author_class");
    expect(corpus.records[0]!.data.actor).toBe("external");
    expect(corpus.records[0]!.author_class).toBeUndefined();
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
    const tiersDir = path.join(tmp, "out", "tiers");
    let log = "";
    const rc = extractCorpusMain(
      [
        "--tier-output",
        tiersDir,
        "--project-root",
        tmp,
        "--opencode-conversations-dir",
        dbp,
        "--no-opencode",
        "--no-codex",
        "--no-copilot",
        "--no-cursor",
        "--accept-coverage-gap",
      ],
      { out: (t) => (log += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    expect(log.startsWith("Coverage Audit (pre-extraction)")).toBe(true);
    expect(log).toContain("Coverage gap accepted");
    expect(log).toContain("published tiers:");
    const tier = readSignalTier(tiersDir);
    expect(tier).not.toBeNull();
    const envelope = tier!.manifest.corpus_metadata?.coverage_envelope;
    expect(envelope?.available_runtimes).toEqual(["opencode"]);
    expect(envelope?.selected_runtimes).not.toContain("opencode");
    expect(envelope?.available_but_not_selected).toEqual([
      { runtime: "opencode", reason: "disabled_by_flag", store_path: dbp },
    ]);
    // No monolithic corpus.json is written — tiers are the canonical output.
    expect(fs.existsSync(path.join(tmp, "out", "corpus.json"))).toBe(false);
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
        importSources: [],
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
    expect(corpus.metadata.adapter_version).toBe("agentera-v3-corpus-3");
    expect(corpus.metadata.families.instruction_document.count).toBe(1);
    expect(corpus.metadata.families.conversation_turn.count).toBeGreaterThanOrEqual(1);
    expect(corpus.metadata.runtimes).toContain("opencode");
    expect(corpus.metadata.runtimes).not.toContain("filesystem");
    expect(corpus.metadata.source_products).toContain("filesystem");
    expect(corpus.metadata.available_runtimes).toEqual([]);
    expect(corpus.metadata.selected_runtimes).toEqual([]);
    expect(corpus.metadata.available_but_not_selected).toEqual([]);
    expect(corpus.records.some((r: any) => r.source_kind === "conversation_turn")).toBe(true);
  });

  it("extractCorpusMain publishes tiers and returns 0", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# rules\n");
    const tiersDir = path.join(tmp, "out", "tiers");
    let log = "";
    const rc = extractCorpusMain(
      [
        "--tier-output",
        tiersDir,
        "--project-root",
        tmp,
        "--codex-sessions-dir",
        path.join(tmp, "stores", "codex"),
        "--opencode-conversations-dir",
        path.join(tmp, "stores", "opencode.db"),
        "--copilot-conversations-dir",
        path.join(tmp, "stores", "copilot"),
        "--cursor-projects-dir",
        path.join(tmp, "stores", "cursor-projects"),
        "--cursor-chats-dir",
        path.join(tmp, "stores", "cursor-chats"),
        "--no-codex",
        "--no-opencode",
        "--no-copilot",
        "--no-cursor",
      ],
      { out: (t) => (log += t + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(0);
    expect(log).toContain("published tiers:");
    const tier = readSignalTier(tiersDir);
    expect(tier).not.toBeNull();
    expect(tier!.manifest.total_records).toBeGreaterThanOrEqual(1);
    // No monolithic corpus.json is written — tiers are the canonical output.
    expect(fs.existsSync(path.join(tmp, "out", "corpus.json"))).toBe(false);
  });

  it("does not read Claude history during default active-runtime extraction", () => {
    const claudeDir = path.join(tmp, ".claude", "projects", "project");
    fs.mkdirSync(claudeDir, { recursive: true });
    const transcript = path.join(claudeDir, "session.jsonl");
    fs.writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"secret"}}\n');
    const readSpy = vi.spyOn(fs, "readFileSync");
    const tiersDir = path.join(tmp, "out", "tiers");

    const rc = extractCorpusMain(
      ["--tier-output", tiersDir, "--project-root", tmp, "--no-codex", "--no-opencode", "--no-copilot", "--no-cursor", "--accept-coverage-gap"],
      { out: () => {}, err: () => {}, env: isolatedEnv(tmp), cwd: tmp },
    );

    expect(rc).toBe(0);
    expect(readSpy.mock.calls.some(([target]) => String(target).startsWith(path.join(tmp, ".claude")))).toBe(false);
    const tier = readSignalTier(tiersDir);
    expect(tier).not.toBeNull();
    const products = new Set(tier!.records.map((r) => r.source_product));
    expect(products.has("claude-code")).toBe(false);
    readSpy.mockRestore();
  });

  it("imports Claude history only with explicit opt-in and labels every record as historical", () => {
    const claudeDir = path.join(tmp, "claude-history");
    fs.mkdirSync(claudeDir, { recursive: true });
    const transcript = path.join(claudeDir, "session.jsonl");
    const bytes = '{"type":"user","sessionId":"s1","message":{"role":"user","content":"should we keep this?"}}\n';
    fs.writeFileSync(transcript, bytes);
    const tiersDir = path.join(tmp, "out", "tiers");
    let warnings = "";

    const rc = extractCorpusMain(
      [
        "--tier-output", tiersDir,
        "--project-root", tmp,
        "--import-source", "claude",
        "--claude-projects-dir", claudeDir,
        "--no-codex", "--no-opencode", "--no-copilot", "--no-cursor", "--accept-coverage-gap",
      ],
      { out: () => {}, err: (text) => (warnings += text + "\n"), env: isolatedEnv(tmp), cwd: tmp },
    );

    expect(rc).toBe(0);
    expect(fs.readFileSync(transcript, "utf8")).toBe(bytes);
    expect(warnings).toContain("can contain secrets, file contents, and command output");
    expect(warnings).toContain("local and read-only");
    const tier = readSignalTier(tiersDir);
    expect(tier).not.toBeNull();
    const imported = tier!.records.filter((r) => r.source_product === "claude-code");
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.every((r) => r.runtime === null && r.source_class === "historical_import")).toBe(true);
    expect(imported.some((r) => r.author_class === "user" && r.content_fingerprint)).toBe(true);
  });

  it("requires the import flag before accepting a Claude history path", () => {
    let error = "";
    const rc = extractCorpusMain(
      ["--claude-projects-dir", path.join(tmp, "history")],
      { out: () => {}, err: (text) => (error += text), env: isolatedEnv(tmp), cwd: tmp },
    );
    expect(rc).toBe(2);
    expect(error).toContain("requires explicit --import-source claude");
  });
});
