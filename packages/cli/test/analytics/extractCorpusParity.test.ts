import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildExtractCorpusParityManifest, opencodeParitySnapshot } from "../../src/analytics/extractCorpus/extractCorpusParity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURE_MANIFEST = path.join(__dirname, "fixtures/extract-corpus-parity-manifest.json");
const PYTHON_WRAPPER = path.join(REPO_ROOT, "scripts/extract_corpus.py");
function seedOpencodeParityFixture(dbp: string): void {
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE session(id TEXT, cwd TEXT, time_created INTEGER)");
  db.exec("CREATE TABLE message(id TEXT, sessionID TEXT, role TEXT, time_created INTEGER, content TEXT, data TEXT)");
  db.exec("CREATE TABLE part(id TEXT, messageID TEXT, type TEXT, text TEXT, data TEXT, time_created INTEGER)");
  db.prepare("INSERT INTO session VALUES (?,?,?)").run("s1", "/proj/foo", 1_700_000_000);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run("m1", "s1", "user", 1_700_000_001, null, null);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run("m2", "s1", "assistant", 1_700_000_002, null, null);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p1", "m1", "text", "why should we avoid this approach?", null, 1_700_000_001);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p2", "m2", "text", "Because of the tradeoff.", null, 1_700_000_002);
  db.close();
}

function invokePythonParityProbe(dbPath: string) {
  return spawnSync("python3", [PYTHON_WRAPPER, "--parity-probe-opencode", dbPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runPythonParityProbe(dbPath: string): unknown {
  const proc = invokePythonParityProbe(dbPath);
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return JSON.parse(proc.stdout);
}

describe("extractCorpusParity manifest", () => {
  it("matches the committed fixture generated from TypeScript", () => {
    const live = buildExtractCorpusParityManifest();
    const committed = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, "utf8"));
    expect(live).toEqual(committed);
  });
});

describe("parityCheck opencode.db", () => {
  let refDir: string;
  let refDb: string;
  let tsReference!: ReturnType<typeof opencodeParitySnapshot>;

  beforeAll(() => {
    refDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-parity-ref-"));
    refDb = path.join(refDir, "opencode.db");
    seedOpencodeParityFixture(refDb);
    tsReference = opencodeParitySnapshot(refDb);
  }, 30_000);

  afterAll(() => {
    fs.rmSync(refDir, { recursive: true, force: true });
  });

  it("keeps the generated Python oracle independent from Node and checkout-local dist", () => {
    const python = fs.readFileSync(PYTHON_WRAPPER, "utf8");
    expect(python).not.toContain("subprocess");
    expect(python).not.toContain("PROBE_SCRIPT");
    expect(python).not.toContain('["node"');
    expect(python).not.toContain("dist/");
    expect(fs.existsSync(path.join(REPO_ROOT, "packages/cli/scripts/extract-corpus-parity-probe.mjs"))).toBe(false);
  });

  it("matches record_count, earliest, and latest across probe shapes for TS", () => {
    expect(tsReference.record_count).toBe(tsReference.probe_shapes.extraction.record_count);
    expect(tsReference.earliest).toBe(tsReference.probe_shapes.coverage.earliest);
    expect(tsReference.latest).toBe(tsReference.probe_shapes.coverage.latest);
    expect(tsReference.probe_shapes.discovery.status).toBe("available");
    expect(tsReference.probe_shapes.discovery.file_count).toBe(1);
    expect(tsReference.probe_shapes.discovery).not.toHaveProperty("candidate_count");
    expect(tsReference.record_count).toBeGreaterThan(0);
    expect(tsReference.earliest).toMatch(/^2023-11-14T22:13:20/);
    expect(tsReference.latest).toMatch(/^2023-11-14T22:13:20/);
  });

  it("matches generated Python extractor probe on the shared seeded opencode.db", () => {
    const pySnapshot = runPythonParityProbe(refDb);
    expect(pySnapshot).toEqual(tsReference);
  });

  it("rejects a missing database through both independent parity paths", () => {
    const missing = path.join(refDir, "missing.db");
    expect(() => opencodeParitySnapshot(missing)).toThrow(`extract-corpus parity: missing opencode db at ${missing}`);
    const python = invokePythonParityProbe(missing);
    expect(python.status).toBe(1);
    expect(python.stderr).toContain(`extract-corpus parity: missing opencode db at ${missing}`);
  });
});
