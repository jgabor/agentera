import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CORPUS_GUIDANCE, CorpusUnavailable, analyzeCorpus, buildJsonPayload, classifyTrigger, defaultCorpusPath, findMarkers, loadCorpusOrRaise, usageMain, pairInvocations } from "../../src/analytics/usageStats.js";
import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { tiersDirForCorpusPath } from "../../src/analytics/extractCorpus/tierReader.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function corpusFixture(): any {
  return {
    metadata: { extracted_at: "2026-01-04T00:00:00Z" },
    records: [
      {
        source_kind: "conversation_turn",
        source_id: "u1",
        session_id: "c1",
        project_id: "agentera",
        timestamp: "2026-01-01T00:00:00Z",
        data: { actor: "user", content: "/build go" },
      },
      {
        source_kind: "conversation_turn",
        source_id: "a1",
        session_id: "c1",
        project_id: "agentera",
        timestamp: "2026-01-01T00:00:01Z",
        data: {
          actor: "assistant",
          content: "─── ⧉ build · cycle ───\nwork\n─── ⧉ build · complete ───",
        },
      },
      {
        source_kind: "conversation_turn",
        source_id: "a2",
        session_id: "c2",
        project_id: "jg-go",
        timestamp: "2026-01-02T00:00:01Z",
        data: { actor: "assistant", content: "─── ≡ plan · planning ───\nplanning..." },
      },
    ],
  };
}

describe("findMarkers", () => {
  it("classifies intro and exit markers", () => {
    const markers = findMarkers("─── ⧉ build · cycle ───\n─── ⧉ build · complete ───");
    expect(markers.map((m) => [m.kind, m.skill, m.word])).toEqual([
      ["intro", "build", "cycle"],
      ["exit", "build", "complete"],
    ]);
  });

  it("supports a trailing number in the phase word", () => {
    const markers = findMarkers("─── ⧉ build · cycle 2 ───");
    expect(markers[0].word).toBe("cycle 2");
  });
});

describe("classifyTrigger", () => {
  it("detects bare slash and XML command, else natural", () => {
    expect(classifyTrigger("/build go")).toBe("slash");
    expect(classifyTrigger("<command-name>/build</command-name>")).toBe("slash");
    expect(classifyTrigger("please plan the next feature")).toBe("natural");
    expect(classifyTrigger(null)).toBe("natural");
  });
});

describe("pairInvocations", () => {
  it("pairs nested same-skill markers LIFO and emits incomplete intros", () => {
    const turn = {
      source_id: "a",
      timestamp: "t",
      data: {
        content: "─── ⧉ build · cycle ───\n─── ⧉ build · cycle 2 ───\n─── ⧉ build · flagged ───",
      },
    };
    const invs = pairInvocations([turn]);
    expect(invs.length).toBe(2);
    const completed = invs.filter((i) => i.completed);
    expect(completed.length).toBe(1);
    expect(completed[0].exit_status).toBe("flagged");
  });
});

describe("analyzeCorpus", () => {
  it("aggregates skills, triggers, and per-project totals", () => {
    const analysis = analyzeCorpus(corpusFixture(), null);
    expect(analysis.skills.build).toEqual({
      total: 1,
      completed: 1,
      incomplete: 0,
      trigger_slash: 1,
      trigger_natural: 0,
    });
    expect(analysis.skills.plan.incomplete).toBe(1);
    expect(analysis.per_project.agentera.build.total).toBe(1);
    expect(analysis.per_project["jg-go"].plan.total).toBe(1);
  });

  it("scopes to a single project when filtered", () => {
    const analysis = analyzeCorpus(corpusFixture(), "agentera");
    expect(Object.keys(analysis.skills)).toEqual(["build"]);
    expect(analysis.per_project).toEqual({});
  });

  it("builds the JSON payload", () => {
    const analysis = analyzeCorpus(corpusFixture(), null);
    const payload = buildJsonPayload(analysis, {
      generatedAt: "GEN",
      extractedAt: "2026-01-04T00:00:00Z",
    });
    expect(payload.generated_at).toBe("GEN");
    expect(payload.invocations.length).toBe(2);
  });

  it("excludes historical imports by default and includes them only in the labeled all-sources view", () => {
    const corpus = corpusFixture();
    corpus.records.push(
      {
        source_kind: "conversation_turn",
        source_id: "hu1",
        session_id: "historical",
        project_id: "agentera",
        timestamp: "2025-12-01T00:00:00Z",
        source_class: "historical_import",
        source_product: "claude-code",
        active_runtime: false,
        runtime: null,
        data: { actor: "user", content: "/build old" },
      },
      {
        source_kind: "conversation_turn",
        source_id: "ha1",
        session_id: "historical",
        project_id: "agentera",
        timestamp: "2025-12-01T00:00:01Z",
        source_class: "historical_import",
        source_product: "claude-code",
        active_runtime: false,
        runtime: null,
        data: {
          actor: "assistant",
          content: "─── ⧉ build · cycle ───\n─── ⧉ build · complete ───",
        },
      },
    );

    expect(analyzeCorpus(corpus).skills.build.total).toBe(1);
    const all = analyzeCorpus(corpus, null, "all");
    expect(all.skills.build.total).toBe(2);
    expect(all.source_provenance).toContainEqual({
      source_class: "historical_import",
      source_product: "claude-code",
      active_runtime: false,
      records: 2,
    });
  });
});

describe("loadCorpusOrRaise", () => {
  it("raises when the corpus file is missing", () => {
    const missing = path.join(tmp, "corpus.json");
    expect(() => loadCorpusOrRaise(missing)).toThrow(CorpusUnavailable);
    try {
      loadCorpusOrRaise(missing);
    } catch (err) {
      expect((err as Error).message).toContain("corpus.json not found");
    }
  });

  it("raises when the corpus has no conversation_turn records", () => {
    const p = path.join(tmp, "corpus.json");
    fs.writeFileSync(p, JSON.stringify({ records: [{ source_kind: "instruction_document" }] }));
    expect(() => loadCorpusOrRaise(p)).toThrow(/no conversation_turn records/);
  });

  it("loads a valid corpus", () => {
    const p = path.join(tmp, "corpus.json");
    fs.writeFileSync(p, JSON.stringify(corpusFixture()));
    expect(loadCorpusOrRaise(p).metadata.extracted_at).toBe("2026-01-04T00:00:00Z");
  });
});

describe("default paths", () => {
  it("honors the AGENTERA_PROFILE_DIR override", () => {
    expect(defaultCorpusPath({ AGENTERA_PROFILE_DIR: "/x/prof" })).toBe(path.join("/x/prof", "intermediate", "corpus.json"));
  });

  it("falls back to PROFILERA_PROFILE_DIR when AGENTERA_PROFILE_DIR is unset", () => {
    expect(defaultCorpusPath({ PROFILERA_PROFILE_DIR: "/legacy/prof" })).toBe(path.join("/legacy/prof", "intermediate", "corpus.json"));
  });

  it("uses XDG default on linux", () => {
    expect(defaultCorpusPath({ HOME: "/home/u", XDG_DATA_HOME: "/home/u/.local/share" }, "linux")).toBe(path.join("/home/u/.local/share", "agentera", "intermediate", "corpus.json"));
  });
});

describe("usageMain engine", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usagemain-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 2 and reports an unavailable corpus on stderr", () => {
    let err = "";
    const rc = usageMain(["--corpus", path.join(tmp, "missing.json")], {
      out: () => {},
      err: (t) => (err += t),
      env: {},
    });
    expect(rc).toBe(2);
    expect(err).toContain("corpus.json not found");
  });

  it("emits a JSON document for a valid corpus", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    fs.writeFileSync(
      corpusPath,
      JSON.stringify({
        metadata: { extracted_at: "2026-01-02T03:04:05Z" },
        records: [
          {
            source_kind: "conversation_turn",
            project_id: "agentera",
            role: "assistant",
            timestamp: "2026-01-01T00:00:00Z",
            text: "<route>plan</route> let me plan",
          },
        ],
      }),
    );
    let out = "";
    const rc = usageMain(["--corpus", corpusPath], {
      out: (t) => (out += t),
      err: () => {},
      env: {},
    });
    expect(rc).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.project_filter).toBeNull();
    expect(parsed.extracted_at).toBe("2026-01-02T03:04:05Z");
    expect(typeof parsed.generated_at).toBe("string");
    expect(typeof parsed.skills).toBe("object");
  });

  function isolatedUsageEnv(): Record<string, string> {
    return {
      HOME: path.join(tmp, "home"),
      XDG_DATA_HOME: path.join(tmp, "xdg-data"),
      XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
      XDG_STATE_HOME: path.join(tmp, "xdg-state"),
      XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
      AGENTERA_PROFILE_DIR: path.join(tmp, "data"),
      AGENTERA_USAGE_DIR: path.join(tmp, "usage"),
    };
  }

  function usageReportCandidates(env: Record<string, string>): string[] {
    return [path.join(env.AGENTERA_USAGE_DIR, "USAGE.md"), path.join(env.AGENTERA_PROFILE_DIR, "USAGE.md"), path.join(env.XDG_DATA_HOME, "agentera", "USAGE.md"), path.join(env.HOME, "USAGE.md")];
  }

  function runIsolated(argv: string[], env: Record<string, string>): { rc: number; out: string; err: string; writes: number } {
    let out = "";
    let err = "";
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    try {
      const rc = usageMain(argv, { out: (t) => (out += t), err: (t) => (err += t), env });
      return { rc, out, err, writes: writeFile.mock.calls.length + mkdir.mock.calls.length };
    } finally {
      writeFile.mockRestore();
      mkdir.mockRestore();
    }
  }

  it("emits unchanged JSON analytics for ready evidence without writing USAGE.md, ignoring AGENTERA_USAGE_DIR", () => {
    const env = isolatedUsageEnv();
    fs.mkdirSync(path.join(env.AGENTERA_PROFILE_DIR, "intermediate"), { recursive: true });
    fs.writeFileSync(path.join(env.AGENTERA_PROFILE_DIR, "intermediate", "corpus.json"), JSON.stringify(corpusFixture()));

    const withOverride = runIsolated([], env);
    const { AGENTERA_USAGE_DIR: _ignored, ...withoutOverrideEnv } = env;
    const withoutOverride = runIsolated([], withoutOverrideEnv as Record<string, string>);

    const { generated_at: _generated, ...expected } = buildJsonPayload(analyzeCorpus(corpusFixture()), { generatedAt: "GEN", extractedAt: "2026-01-04T00:00:00Z" });
    for (const run of [withOverride, withoutOverride]) {
      expect(run.rc).toBe(0);
      expect(run.err).toBe("");
      expect(run.writes).toBe(0);
      const { generated_at: generatedAt, ...payload } = JSON.parse(run.out);
      expect(typeof generatedAt).toBe("string");
      expect(payload).toEqual(expected);
    }
    expect(withOverride.out.replace(/"generated_at": "[^"]*"/, "")).toBe(withoutOverride.out.replace(/"generated_at": "[^"]*"/, ""));
    expect(fs.existsSync(env.AGENTERA_USAGE_DIR)).toBe(false);
    for (const candidate of usageReportCandidates(env)) expect(fs.existsSync(candidate)).toBe(false);
  });

  it("keeps privacy-safe recovery for missing or stale evidence and writes no USAGE.md", () => {
    const env = isolatedUsageEnv();
    const missing = runIsolated([], env);
    expect(missing.rc).toBe(2);
    expect(missing.out).toBe("");
    expect(missing.err).toContain("corpus.json not found");
    expect(missing.err).toContain(CORPUS_GUIDANCE);
    expect(missing.writes).toBe(0);

    fs.mkdirSync(path.join(env.AGENTERA_PROFILE_DIR, "intermediate"), { recursive: true });
    fs.writeFileSync(path.join(env.AGENTERA_PROFILE_DIR, "intermediate", "corpus.json"), JSON.stringify({ records: [{ source_kind: "instruction_document" }] }));
    const stale = runIsolated([], env);
    expect(stale.rc).toBe(2);
    expect(stale.out).toBe("");
    expect(stale.err).toContain("no conversation_turn records");
    expect(stale.err).toContain(CORPUS_GUIDANCE);
    expect(stale.writes).toBe(0);
    for (const candidate of usageReportCandidates(env)) expect(fs.existsSync(candidate)).toBe(false);
  });
});

describe("usageMain tier-aware path", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-tier-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("analyzes from bounded tiers without reading the monolithic corpus", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    const records = [
      {
        source_id: "c1",
        source_kind: "conversation_turn",
        session_id: "s1",
        conversation_key: "s1",
        origin_id: originIdentity("fixture:s1:user"),
        content_fingerprint: contentFingerprint("/build go"),
        author_class: "user",
        project_id: "agentera",
        timestamp: "2026-01-01T00:00:00.000Z",
        runtime: "opencode",
        source_class: "active_runtime",
        source_product: "opencode",
        active_runtime: true,
        adapter_version: ADAPTER_VERSION,
        data: { actor: "user", content: "/build go" },
      },
      {
        source_id: "a1",
        source_kind: "conversation_turn",
        session_id: "s1",
        conversation_key: "s1",
        origin_id: originIdentity("fixture:s1:assistant"),
        content_fingerprint: contentFingerprint("done"),
        author_class: "agent",
        project_id: "agentera",
        timestamp: "2026-01-01T00:00:01.000Z",
        runtime: "opencode",
        source_class: "active_runtime",
        source_product: "opencode",
        active_runtime: true,
        adapter_version: ADAPTER_VERSION,
        data: { actor: "assistant", content: "done" },
      },
    ];
    const runtimeStatuses = [
      {
        runtime: "opencode",
        source_product: "opencode",
        source_class: "active_runtime",
        active_runtime: true,
        status: "available",
        reason: "candidate_files_found",
      },
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

    let out = "";
    const rc = usageMain(["--corpus", corpusPath], {
      out: (t) => (out += t),
      err: () => {},
      env: {},
    });
    expect(rc).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.extracted_at).toBe("2026-01-15T00:00:00Z");
  });

  it("falls back to legacy corpus when no tiers are published", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    fs.writeFileSync(
      corpusPath,
      JSON.stringify({
        metadata: { extracted_at: "2026-01-02T03:04:05Z" },
        records: [
          {
            source_kind: "conversation_turn",
            project_id: "agentera",
            role: "assistant",
            timestamp: "2026-01-01T00:00:00Z",
            text: "hello",
          },
        ],
      }),
    );
    let out = "";
    const rc = usageMain(["--corpus", corpusPath], {
      out: (t) => (out += t),
      err: () => {},
      env: {},
    });
    expect(rc).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.extracted_at).toBe("2026-01-02T03:04:05Z");
  });
});
