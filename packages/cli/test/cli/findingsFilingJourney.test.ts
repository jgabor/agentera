import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { todoReconciliationActivationBytes, TODO_RECONCILIATION_ACTIVATION_PATH } from "../../src/state/todoReconciliationActivation.js";
import { findingsFiling } from "../../src/capabilities/findingsFiling.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { mutateTodoDocsEntity } from "../../src/state/todoDocsEntities.js";
import { operationSpec } from "../../src/state/write/operations.js";
import { useSourceAppHome } from "../helpers/managedAppStub.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

useSourceAppHome();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-findings-filing-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  fs.writeFileSync(path.join(root, TODO_RECONCILIATION_ACTIVATION_PATH), todoReconciliationActivationBytes([]));
  fs.writeFileSync(path.join(root, "TODO.md"), "# TODO\n");
  fs.writeFileSync(path.join(root, "code.ts"), "// must not be fixed\n");
  fs.writeFileSync(path.join(root, ".agentera/vision.yaml"), "purpose: protected fixture\n");
  return root;
}

function cli(root: string, args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, [path.join(sourceBuildOutputRoot(), "bin/agentera.js"), ...args], {
    cwd: root,
    env: sourceSubprocessEnv({
      ...process.env,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."),
    }),
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout, result.stderr).not.toBe("");
  return { rc: result.status, json: JSON.parse(result.stdout) };
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString("hex");
    }
  };
  visit(root);
  return result;
}

const record = (title: string, severity = "degraded") => ({
  kind: "fix",
  title,
  severity,
  target_version: null,
  release_blocker: false,
  requirements: ["Retain cited finding evidence"],
  acceptance: ["The reported failure no longer occurs"],
});
const batch = (records: ReturnType<typeof record>[]) => ({
  schema_version: "agentera.todoCreateBatch.v1",
  creates: records.map((value, index) => ({ local_ref: `finding_${index}`, record: value })),
});
const create = ["state", "todo", "create", "--input", "-"];

describe.each(["research", "audit"])("%s selected findings host journey", (capability) => {
  // These sequences model a compliant host, not CLI enforcement of human consent.
  // Effect binding/replay are executable CLI contracts; semantic dedup and Yes/No
  // remain host responsibilities and are exercised by explicit selections below.
  function guidance(root: string) {
    const response = cli(root, ["prime", "--context", capability, "--detail", "instructions", "--section", "instructions", "--limit", "20"]);
    expect(response.rc, JSON.stringify(response.json)).toBe(0);
    expect(response.json.completeness.complete).toBe(true);
    const text = response.json.items.map((item: { content: string }) => item.content).join("");
    // Exact served procedure parity, not only isolated keywords.
    expect(text).toContain(findingsFiling.trim().replaceAll("`agentera ", "`npx -y agentera@next "));
    return text;
  }

  it("files only the displayed deduplicated set with one approval, then verifies an unchanged replay", () => {
    const root = fixture();
    guidance(root);
    const tracked = record("Existing request timeout");
    expect(cli(root, create, tracked).rc).toBe(0);
    const existing = cli(root, ["state", "todo", "list", "--limit", "100"]).json.entries;
    expect(existing).toHaveLength(1);
    // Host identifies a differently worded finding as the same tracked issue,
    // and merges repeated evidence for the selected new finding before preview.
    const selected = [record("Bound missing source response", "critical"), record("Explain unsupported input", "annoying")];
    const input = batch(selected);
    const before = snapshot(root);
    const preview = cli(root, [...create, "--dry-run"], input);
    expect(preview.rc).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const approved = [...create, "--effect-sha256", preview.json.effect_sha256, "--yes"];
    const saved = cli(root, approved, input);
    expect(saved.rc).toBe(0);
    expect(saved.json.records.map((entry: any) => entry.record.title)).toEqual(selected.map((entry) => entry.title));
    for (const [index, id] of Object.values(saved.json.local_refs).entries()) {
      const actual = cli(root, ["state", "todo", "get", "--id", String(id)]);
      expect(actual.rc).toBe(0);
      expect(actual.json.entry.record).toMatchObject(selected[index]);
    }
    const after = snapshot(root);
    const replay = cli(root, approved, input);
    expect(replay.rc).toBe(0);
    expect(replay.json.operation.idempotent_replay).toBe(true);
    expect(snapshot(root)).toEqual(after);
    expect(cli(root, ["state", "todo", "list", "--limit", "100"]).json.entries).toHaveLength(3);
    expect(fs.readFileSync(path.join(root, "code.ts"), "utf8")).toBe("// must not be fixed\n");
    expect(fs.readFileSync(path.join(root, ".agentera/vision.yaml"), "utf8")).toBe("purpose: protected fixture\n");
  });

  it("makes no write on refusal and rejects changed entries or severity under the old effect", () => {
    const root = fixture();
    guidance(root);
    const input = batch([record("Bound missing source response")]);
    const before = snapshot(root);
    const preview = cli(root, [...create, "--dry-run"], input);
    expect(preview.rc).toBe(0);
    // User says No: the host issues no apply or downstream command.
    expect(snapshot(root)).toEqual(before);
    const noConfirmation = cli(root, [...create, "--effect-sha256", preview.json.effect_sha256], input);
    expect(noConfirmation.rc).not.toBe(0);
    expect(snapshot(root)).toEqual(before);
    for (const changed of [batch([record("A different finding")]), batch([record("Bound missing source response", "critical")]), batch([input.creates[0].record, record("Additional finding")])]) {
      const rejected = cli(root, [...create, "--effect-sha256", preview.json.effect_sha256, "--yes"], changed);
      expect(rejected.rc).not.toBe(0);
      expect(snapshot(root)).toEqual(before);
    }
  });

  it("reports unreadable interrupted state, refuses a changed retry, and verifies exact recovery without duplicates", () => {
    const root = fixture();
    guidance(root);
    const input = batch([record("First interrupted finding"), record("Second interrupted finding", "critical")]);
    const preview = cli(root, [...create, "--dry-run"], input);
    expect(preview.rc).toBe(0);
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("expected entity mode");
    try {
      // Use the existing writer fault seam, never add a public fault flag.
      expect(() =>
        mutateTodoDocsEntity(
          {
            artifact: "todo",
            spec: operationSpec("todo", "create")!,
            projectRoot: root,
            dryRun: false,
            force: false,
            values: { confirmed: true, effect_sha256: preview.json.effect_sha256 },
            callerPayload: input,
            input,
          },
          { publicationContext: binding.publicationContext, interruptAfterTarget: 1 },
        ),
      ).toThrow(/interruption/);
    } finally {
      binding.publicationContext.close();
    }
    const interrupted = snapshot(root);
    const unreadable = cli(root, ["state", "todo", "list"]);
    expect(unreadable.rc).not.toBe(0);
    expect(unreadable.json.error.message).toContain("pending");
    expect(unreadable.json.error.recovery).toContain("exact");
    expect(snapshot(root)).toEqual(interrupted);
    const approved = [...create, "--effect-sha256", preview.json.effect_sha256, "--yes"];
    const refused = cli(root, approved, batch([record("Unapproved replacement")]));
    expect(refused.rc).not.toBe(0);
    expect(snapshot(root)).toEqual(interrupted);
    const recovered = cli(root, approved, input);
    expect(recovered.rc).toBe(0);
    expect(recovered.json.local_refs).toEqual(preview.json.local_refs);
    for (const [index, id] of Object.values(recovered.json.local_refs).entries()) {
      const saved = cli(root, ["state", "todo", "get", "--id", String(id)]);
      expect(saved.rc).toBe(0);
      expect(saved.json.entry.record).toMatchObject(input.creates[index].record);
    }
    expect(cli(root, ["state", "todo", "list"]).json.entries).toHaveLength(2);
    const complete = snapshot(root);
    expect(cli(root, approved, input).json.operation.idempotent_replay).toBe(true);
    expect(snapshot(root)).toEqual(complete);
  });
});
