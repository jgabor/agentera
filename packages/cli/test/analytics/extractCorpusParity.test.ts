import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  buildExtractCorpusParityManifest,
  opencodeParitySnapshot,
} from "../../src/analytics/extractCorpus/extractCorpusParity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURE_MANIFEST = path.join(__dirname, "fixtures/extract-corpus-parity-manifest.json");
const PYTHON_WRAPPER = path.join(REPO_ROOT, "scripts/extract_corpus.py");
const PKG_ROOT = path.join(REPO_ROOT, "packages/cli");

let tmp: string;

function seedOpencodeParityFixture(dbp: string): void {
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE session(id TEXT, cwd TEXT, time_created INTEGER)");
  db.exec("CREATE TABLE message(id TEXT, sessionID TEXT, role TEXT, time_created INTEGER, content TEXT, data TEXT)");
  db.exec("CREATE TABLE part(id TEXT, messageID TEXT, type TEXT, text TEXT, data TEXT, time_created INTEGER)");
  db.prepare("INSERT INTO session VALUES (?,?,?)").run("s1", "/proj/foo", 1_700_000_000);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run("m1", "s1", "user", 1_700_000_001, null, null);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run("m2", "s1", "assistant", 1_700_000_002, null, null);
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
    "p1",
    "m1",
    "text",
    "why should we avoid this approach?",
    null,
    1_700_000_001,
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
    "p2",
    "m2",
    "text",
    "Because of the tradeoff.",
    null,
    1_700_000_002,
  );
  db.close();
}

function runPythonParityProbe(dbPath: string): unknown {
  const proc = spawnSync("uv", ["run", PYTHON_WRAPPER, "--parity-probe-opencode", dbPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return JSON.parse(proc.stdout);
}

beforeAll(() => {
  const build = spawnSync("pnpm", ["-C", PKG_ROOT, "run", "build"], { stdio: "inherit" });
  expect(build.status).toBe(0);
  const gen = spawnSync(process.execPath, [path.join(PKG_ROOT, "scripts/generate-extract-corpus-parity.mjs"), "--write"], {
    stdio: "inherit",
  });
  expect(gen.status).toBe(0);
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extract-parity-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extractCorpusParity manifest", () => {
  it("matches the committed fixture generated from TypeScript", () => {
    const live = buildExtractCorpusParityManifest();
    const committed = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, "utf8"));
    expect(live).toEqual(committed);
  });

  it("fails bundle parity check when manifest would drift", () => {
    const check = spawnSync(process.execPath, [path.join(PKG_ROOT, "scripts/generate-extract-corpus-parity.mjs")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(check.status, check.stderr || check.stdout).toBe(0);
  });
});

describe("parityCheck opencode.db", () => {
  it("matches record_count, earliest, and latest across probe shapes for TS", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeParityFixture(dbp);
    const snapshot = opencodeParitySnapshot(dbp);
    expect(snapshot.record_count).toBe(snapshot.probe_shapes.extraction.record_count);
    expect(snapshot.earliest).toBe(snapshot.probe_shapes.coverage.earliest);
    expect(snapshot.latest).toBe(snapshot.probe_shapes.coverage.latest);
    expect(snapshot.probe_shapes.discovery.status).toBe("available");
    expect(snapshot.probe_shapes.discovery.file_count).toBe(1);
    expect(snapshot.probe_shapes.discovery).not.toHaveProperty("candidate_count");
    expect(snapshot.record_count).toBeGreaterThan(0);
    expect(snapshot.earliest).toMatch(/^2023-11-14T22:13:20/);
    expect(snapshot.latest).toMatch(/^2023-11-14T22:13:20/);
  });

  it("matches TypeScript and generated Python extractor probes on seeded opencode.db", () => {
    const dbp = path.join(tmp, "opencode.db");
    seedOpencodeParityFixture(dbp);
    const tsSnapshot = opencodeParitySnapshot(dbp);
    const pySnapshot = runPythonParityProbe(dbp);
    expect(pySnapshot).toEqual(tsSnapshot);
  });
});
