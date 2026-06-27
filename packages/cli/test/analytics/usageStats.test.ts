import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CorpusUnavailable,
  analyzeCorpus,
  buildJsonPayload,
  classifyTrigger,
  defaultCorpusPath,
  defaultUsageDir,
  findMarkers,
  loadCorpusOrRaise,
  usageMain,
  pairInvocations,
  renderMarkdown,
} from "../../src/analytics/usageStats.js";

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
        data: { actor: "assistant", content: "─── ⧉ build · cycle ───\nwork\n─── ⧉ build · complete ───" },
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
      data: { content: "─── ⧉ build · cycle ───\n─── ⧉ build · cycle 2 ───\n─── ⧉ build · flagged ───" },
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

  it("renders a markdown report and JSON payload", () => {
    const analysis = analyzeCorpus(corpusFixture(), null);
    const md = renderMarkdown(analysis, { generatedAt: "GEN", extractedAt: "2026-01-04T00:00:00Z" });
    expect(md).toContain("# Suite Usage");
    expect(md).toContain("| build | 1 |");
    expect(md).toContain("## Per-project totals");
    const payload = buildJsonPayload(analysis, { generatedAt: "GEN", extractedAt: "2026-01-04T00:00:00Z" });
    expect(payload.generated_at).toBe("GEN");
    expect(payload.invocations.length).toBe(2);
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
  it("honors AGENTERA_USAGE_DIR and AGENTERA_PROFILE_DIR overrides", () => {
    expect(defaultUsageDir({ AGENTERA_USAGE_DIR: "/x/usage" })).toBe("/x/usage");
    expect(defaultUsageDir({ AGENTERA_PROFILE_DIR: "/x/prof" })).toBe("/x/prof");
    expect(defaultCorpusPath({ AGENTERA_PROFILE_DIR: "/x/prof" })).toBe(
      path.join("/x/prof", "intermediate", "corpus.json"),
    );
  });

  it("falls back to PROFILERA_PROFILE_DIR when AGENTERA_PROFILE_DIR is unset", () => {
    expect(defaultUsageDir({ PROFILERA_PROFILE_DIR: "/legacy/prof" })).toBe("/legacy/prof");
    expect(defaultCorpusPath({ PROFILERA_PROFILE_DIR: "/legacy/prof" })).toBe(
      path.join("/legacy/prof", "intermediate", "corpus.json"),
    );
  });

  it("uses XDG default on linux", () => {
    expect(defaultUsageDir({ HOME: "/home/u", XDG_DATA_HOME: "/home/u/.local/share" }, "linux")).toBe(
      path.join("/home/u/.local/share", "agentera"),
    );
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
    const rc = usageMain(["--corpus", path.join(tmp, "missing.json"), "--json"], {
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
    const rc = usageMain(["--corpus", corpusPath, "--json"], {
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
});
