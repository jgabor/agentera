#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const requireFromCli = createRequire(path.resolve(SCRIPT_DIR, "../packages/cli/package.json"));
const YAML = requireFromCli("yaml");
const CLI = path.resolve(SCRIPT_DIR, "../packages/cli/dist/bin/agentera.js");
const MAX_SERIALIZED_BYTES = 32_768;
const FIXTURE_ROOT = path.join(os.tmpdir(), "agentera-task4-retrieval-evidence-v1");
const FIXTURE_MARKER = ".agentera-task4-retrieval-evidence-v1";
const ACTIVE_ID = "plan:123e4567-e89b-42d3-a456-426614174000";
const ARCHIVE_ID = "plan:223e4567-e89b-42d3-a456-426614174000";
const MISSING_ID = "plan:923e4567-e89b-42d3-a456-426614174000";
const ACTIVE_PLAN_FILE = `plan${".yaml"}`;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function plan(id, title, created, status = "complete") {
  return {
    header: { ...(id ? { id } : {}), title, created, status },
    what: `Deliver ${title}`,
    tasks: [{ number: 1, name: "Ship it", status: status === "complete" ? "complete" : "pending" }],
  };
}

function run(root, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  assert(
    result.status === expectedStatus,
    `${args.join(" ")} exited ${result.status}; expected ${expectedStatus}: ${result.stdout}${result.stderr}`,
  );
  return result.stdout;
}

function prepareFixture() {
  if (fs.existsSync(FIXTURE_ROOT)) {
    assert(
      fs.existsSync(path.join(FIXTURE_ROOT, FIXTURE_MARKER)),
      `refusing to replace unowned fixture path ${FIXTURE_ROOT}`,
    );
    fs.rmSync(FIXTURE_ROOT, { recursive: true });
  }
  fs.mkdirSync(path.join(FIXTURE_ROOT, ".agentera", "archive"), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_ROOT, FIXTURE_MARKER), "owned by verify-task4-retrieval-evidence.mjs\n");
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, ".agentera", ACTIVE_PLAN_FILE),
    YAML.stringify(plan(ACTIVE_ID, "Active", "2026-07-15", "open")),
  );
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, ".agentera", "archive", "PLAN-archive.yaml"),
    YAML.stringify(plan(ARCHIVE_ID, "Archive", "2026-07-14")),
  );
  for (let index = 0; index < 30; index += 1) {
    const suffix = index.toString(16).padStart(12, "0");
    const id = `plan:323e4567-e89b-42d3-a456-${suffix}`;
    fs.writeFileSync(
      path.join(FIXTURE_ROOT, ".agentera", "archive", `PLAN-yaml-pressure-${String(index).padStart(2, "0")}.yaml`),
      YAML.stringify(plan(id, `YAML ${index} ${"é🙂漢字".repeat(180)}`, "2026-07-13")),
    );
  }
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, ".agentera", "archive", "PLAN-legacy.yaml"),
    YAML.stringify(plan(undefined, "Legacy", "2026-07-12")),
  );
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, ".agentera", "archive", "PLAN-invalid.yaml"),
    YAML.stringify(plan(undefined, "Invalid", "2026-07-11")).replace("status: complete", "status: broken"),
  );
}

function parseJsonList(text) {
  const payload = JSON.parse(text);
  const required = [
    "schemaVersion", "command", "status", "entries", "counts", "order", "filters",
    "snapshot", "source", "source_contract", "retrieval", "omitted", "omitted_count", "omission_reason",
  ];
  assert(required.every((field) => Object.hasOwn(payload, field)), "plan list omitted a required response field");
  return payload;
}

function verifyLive() {
  assert(fs.existsSync(CLI), `built CLI not found at ${CLI}; run pnpm -C packages/cli build first`);
  const bytes = Buffer.byteLength(run(process.cwd(), ["state", "plan", "list", "--limit", "100"]), "utf8");
  assert(bytes < MAX_SERIALIZED_BYTES, `live JSON response is ${bytes} bytes, not < ${MAX_SERIALIZED_BYTES}`);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "agentera.task4LiveSmoke.v1",
    assertion: "serialized_bytes < 32768",
    serialized_bytes: bytes,
    pass: true,
  }, null, 2)}\n`);
}

function verifyFixture() {
  assert(fs.existsSync(CLI), `built CLI not found at ${CLI}; run pnpm -C packages/cli build first`);
  prepareFixture();
  try {
    const args = ["state", "plan", "list", "--limit", "100"];
    const firstText = run(FIXTURE_ROOT, args);
    const secondText = run(FIXTURE_ROOT, args);
    assert(firstText === secondText, "repeated deterministic fixture responses differ");
    const serializedBytes = Buffer.byteLength(firstText, "utf8");
    assert(serializedBytes < MAX_SERIALIZED_BYTES, `fixture JSON response is ${serializedBytes} bytes, not < ${MAX_SERIALIZED_BYTES}`);

    const first = parseJsonList(firstText);
    assert(first.command === "state plan list", "unexpected list command identity");
    assert(first.order === "created_desc_then_plan_id_asc", "unexpected plan ordering");
    assert(first.entries[0]?.stable_id === ACTIVE_ID && first.entries[1]?.stable_id === ARCHIVE_ID, "active/archive recency is unstable");
    assert(first.entries.every((entry) =>
      typeof entry.stable_id === "string"
      && typeof entry.active === "boolean"
      && typeof entry.archived === "boolean"
      && entry.detail_availability === "full"
      && Array.isArray(entry.provenance?.lifecycle_positions)
      && typeof entry.retrieval?.get === "string"), "an entry omitted identity, lifecycle, detail, provenance, or exact recovery");
    assert(first.omitted === true && first.omitted_count > 0, "byte pressure did not report whole-entry omissions");
    assert(first.omission_reason === "serialized_output_byte_budget", "byte-pressure omission reason is not explicit");
    assert(typeof first.next_cursor === "string" && first.next_cursor.length > 0, "byte-pressure response omitted its cursor");
    assert(first.retrieval.continue.includes(`--cursor ${first.next_cursor}`), "response omitted usable cursor recovery");
    assert(first.retrieval.get === "agentera state plan get --plan PLAN_ID --format json", "response omitted exact-get recovery");

    const allEntries = [...first.entries];
    const firstIds = new Set(first.entries.map((entry) => entry.stable_id));
    let cursor = first.next_cursor;
    let continuationCount = 0;
    while (cursor) {
      const continuedText = run(FIXTURE_ROOT, ["state", "plan", "list", "--limit", "100", "--cursor", cursor]);
      assert(Buffer.byteLength(continuedText, "utf8") < MAX_SERIALIZED_BYTES, "continued JSON response is not strictly below budget");
      const continued = parseJsonList(continuedText);
      assert(continued.entries.length > 0, "cursor recovery returned no entries");
      assert(continued.entries.every((entry) => !firstIds.has(entry.stable_id)), "cursor recovery duplicated a first-page identity");
      for (const entry of continued.entries) {
        assert(!allEntries.some((existing) => existing.stable_id === entry.stable_id), "cursor recovery duplicated an identity");
        allEntries.push(entry);
      }
      cursor = continued.next_cursor;
      continuationCount += 1;
      assert(continuationCount < 10, "cursor recovery did not terminate");
    }
    assert(allEntries.some((entry) => entry.stable_id.startsWith("legacy-plan:") && entry.compatibility === "degraded"), "legacy compatibility is not explicit");
    assert(first.source.compatibility_diagnostics.some((diagnostic) => diagnostic.path.endsWith("PLAN-invalid.yaml")), "invalid archive diagnostic is not explicit");

    const selected = JSON.parse(run(FIXTURE_ROOT, ["state", "plan", "get", "--plan", ARCHIVE_ID, "--format", "json"]));
    assert(selected.entry.stable_id === ARCHIVE_ID && selected.plan.what === "Deliver Archive", "exact get did not return the full selected plan");
    assert(selected.source.provenance.lifecycle_positions.includes("archived"), "exact get omitted archive provenance");
    const missing = JSON.parse(run(FIXTURE_ROOT, ["state", "plan", "get", "--plan", MISSING_ID, "--format", "json"], 1));
    assert(missing.error?.class === "not_found" && missing.error?.stable_id === MISSING_ID, "missing plan behavior is not structured");

    process.stdout.write(`${JSON.stringify({
      schemaVersion: "agentera.task4RetrievalEvidence.v1",
      fixture: "generated:task4-plan-retrieval-v1",
      root_runnable_command: "pnpm -C packages/cli build && node scripts/verify-task4-retrieval-evidence.mjs",
      deterministic_serialization: {
        repeated_bytes_equal: true,
        format: "json",
        serialized_bytes: serializedBytes,
        sha256: createHash("sha256").update(firstText, "utf8").digest("hex"),
        assertion: "serialized_bytes < 32768",
        pass: true,
      },
      task_4_acceptance: {
        AC1: {
          pass: true,
          evidence: ["deterministic recency", "stable identity", "lifecycle state", "whole-entry omissions", "opaque cursor", "usable continuation", "exact recovery"],
          returned: first.entries.length,
          omitted: first.omitted_count,
          omission_reason: first.omission_reason,
        },
        AC2: {
          pass: true,
          evidence: ["exact identity get", "full plan document", "archive provenance", "no caller-side traversal"],
          selected_plan: ARCHIVE_ID,
        },
        AC3: {
          pass: true,
          evidence: ["legacy identity compatibility", "invalid archive diagnostic", "structured not-found behavior"],
        },
      },
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(FIXTURE_ROOT, { recursive: true });
  }
}

try {
  if (process.argv.slice(2).includes("--live")) verifyLive();
  else verifyFixture();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
