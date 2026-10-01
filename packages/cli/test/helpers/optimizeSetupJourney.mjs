import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A cooperative synthetic host, not production approval enforcement or an LLM
// compliance test. The caller supplies either source dispatch or the built CLI.
export function optimizeSetupJourney(cli, scenario = "keep") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-optimize-approval-"));
  const trace = [];
  const call = (args, input) => {
    trace.push({ kind: "cli", args });
    return cli(root, args, input);
  };
  try {
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    // Pre-existing measurement tooling and user content, deliberately not setup effects.
    const source = path.join(root, "work.json");
    const initial = { work: scenario === "already-met" ? 2 : 10, user: "preserve me" };
    fs.writeFileSync(source, JSON.stringify(initial));
    const harness = path.join(root, "measure.mjs");
    fs.writeFileSync(
      harness,
      `import fs from 'node:fs';
const value = JSON.parse(fs.readFileSync('work.json', 'utf8'));
if (process.argv.includes('--check')) { if (value.work < 0 || value.user !== 'preserve me') process.exit(1); }
else console.log(JSON.stringify({metric: value.work, direction: 'lower'}));
`,
    );
    const judge = fs.readFileSync(harness, "utf8");
    const proposal = {
      objective: "Reduce deterministic synthetic work",
      target: 3,
      method: "node measure.mjs",
      regression: "node measure.mjs --check",
      hypothesis: "H1: remove redundant synthetic work",
      scope: ["work.json:work"],
      limits: "one edit, two measurements, no Git/install/profile/history",
      rule: "strict improvement AND regression AND constraints, otherwise restore only work field",
      constraints: "work.json <= 128 bytes and preserve user field",
      writes: "typed objective create/update and verified baseline plus one named experiment publish",
    };
    trace.push({ kind: "proposal", proposal: structuredClone(proposal) });
    trace.push({
      kind: "host-response",
      value: scenario === "decline" ? "decline" : scenario === "silence" ? null : "approve package",
    });
    if (["decline", "silence"].includes(scenario)) {
      assert.equal(fs.existsSync(path.join(root, ".agentera/entities")), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(source)), initial);
      assert.equal(fs.readFileSync(harness, "utf8"), judge);
      return { scenario, status: "waiting", trace, measurements: 0 };
    }
    assert.equal(trace[1].value, "approve package");
    let knownApproval = structuredClone(proposal);
    call(["state", "objective", "explain", "--verb", "create"]);
    call(["state", "objective", "explain", "--verb", "update"]);
    call(["state", "experiments", "explain"]);
    const objective = {
      header: { title: proposal.objective, status: "open", created: "2026-10-01" },
      objective: {
        description: proposal.objective,
        why: "Bounded fixture",
        measurement: proposal.method,
        constraints: [proposal.limits, proposal.constraints],
      },
      metric: {
        description: "synthetic work",
        direction: "minimize",
        unit: "operations",
        target: "3",
      },
      baseline: { description: "Measure approved inputs" },
      gates: {},
      scope: { included: proposal.scope, excluded: ["user content", "judge"] },
    };
    const owner = call(["state", "objective", "create", "--input", "-"], objective);
    assert.match(owner.id, /^[a-z]{10}$/);
    let measurements = 0;
    const measure = () => {
      execFileSync(process.execPath, [harness, "--check"], { cwd: root });
      trace.push({ kind: "regression", passed: true });
      const result = JSON.parse(execFileSync(process.execPath, [harness], { cwd: root, encoding: "utf8" }));
      measurements++;
      trace.push({ kind: "measurement", ...result });
      return result.metric;
    };
    const before = measure();
    const evidence = { input: fs.readFileSync(source, "utf8"), judge, before };
    if (scenario === "already-met") {
      objective.header = {
        ...objective.header,
        status: "closed",
        closed_at: "2026-10-01T00:00:00Z",
        final_value: String(before),
        target_ref: "3",
        reason: "already met at startup",
      };
      objective.closure = {
        final_value: String(before),
        target: "3",
        reason: "already met at startup",
      };
      call(["state", "objective", "update", "--id", owner.id, "--input", "-"], objective);
      const saved = call(["state", "objective", "get", "--id", owner.id]);
      assert.equal(saved.entry.record.header.status, "closed");
      assert.deepEqual(JSON.parse(fs.readFileSync(source)), initial);
      assert.equal(call(["state", "experiments", "list", "--objective", owner.id]).entries.length, 0);
      return { scenario, status: "complete", measurements, trace };
    }
    const baselineRecord = {
      date: "2026-10-01 00:00",
      label: "Approved baseline",
      hypothesis: "Measure before H1",
      method: proposal.method,
      change: "none",
      metric: { primary_value: String(before), delta_vs_baseline: "0" },
      regression: "passed",
      status: "baseline",
      conclusion: "Verified comparable baseline",
      provenance: {
        command: proposal.method,
        conditions: "deterministic work.json; unchanged judge",
      },
    };
    const baseline = call(["state", "experiments", "publish", "--objective", owner.id, "--input", "-"], baselineRecord);
    if (scenario.startsWith("drift-")) {
      const field = scenario.slice(6) === "limit" ? "limits" : scenario.slice(6);
      proposal[field] = field === "target" ? 1 : field === "scope" ? ["other.json"] : "materially changed";
      assert.notDeepEqual(proposal, knownApproval);
      trace.push({ kind: "revised-proposal", proposal: structuredClone(proposal) });
      trace.push({ kind: "host-response", value: "decline revised package" });
    }
    if (scenario === "missing-approval") knownApproval = null;
    if (scenario === "stale-evidence") evidence.input = "different inputs";
    const validApproval = knownApproval !== null && JSON.stringify(proposal) === JSON.stringify(knownApproval);
    const validEvidence = evidence.input === fs.readFileSync(source, "utf8") && evidence.judge === fs.readFileSync(harness, "utf8");
    if (scenario.startsWith("drift-") || ["missing-approval", "stale-evidence", "blocked"].includes(scenario)) {
      assert.ok(!validApproval || !validEvidence || scenario === "blocked");
      trace.push({
        kind: "stop",
        reason: scenario,
        completed: "approved setup and baseline",
        remaining: "bounded recovery or revised approval before experiment",
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(source)), initial);
      assert.equal(call(["state", "experiments", "list", "--objective", owner.id]).entries.length, 1);
      return { scenario, status: "stuck", measurements, trace };
    }
    if (scenario === "resume") {
      trace.push({
        kind: "interruption",
        completed: "setup and matching baseline",
        remaining: "H1 edit, checks and record",
        approval: "known unchanged",
      });
      assert.equal(call(["state", "objective", "get", "--id", owner.id]).entry.id, owner.id);
      assert.ok(validApproval && validEvidence);
      assert.equal(call(["state", "experiments", "get", "--id", baseline.id]).entry.record.status, "baseline");
      call(["state", "experiments", "publish", "--objective", owner.id, "--id", baseline.id, "--input", "-"], baselineRecord);
      trace.push({
        kind: "reuse",
        baseline: before,
        measurements,
        reason: "same inputs, judge and conditions",
      });
    }
    const changed = {
      ...initial,
      work: ["no-improvement", "unsafe-cleanup"].includes(scenario) ? 10 : scenario === "regression-fail" ? -1 : 5,
    };
    if (scenario === "constraint-fail") changed.padding = "x".repeat(200);
    fs.writeFileSync(source, JSON.stringify(changed));
    trace.push({ kind: "implement", hypothesis: proposal.hypothesis });
    let regression = true;
    try {
      execFileSync(process.execPath, [harness, "--check"], { cwd: root, stdio: "pipe" });
    } catch {
      regression = false;
    }
    trace.push({ kind: "regression", passed: regression });
    const after = regression ? JSON.parse(execFileSync(process.execPath, [harness], { cwd: root, encoding: "utf8" })).metric : null;
    if (after !== null) {
      measurements++;
      trace.push({ kind: "measurement", metric: after, direction: "lower" });
    }
    const constraints = fs.statSync(source).size <= 128 && JSON.parse(fs.readFileSync(source)).user === initial.user;
    trace.push({
      kind: "constraints",
      passed: constraints,
      bytes: fs.statSync(source).size,
      maximum: 128,
    });
    const kept = regression && constraints && after < before;
    if (!kept) {
      // Preserve a concurrent unrelated edit in the SAME file, not just another file.
      const current = JSON.parse(fs.readFileSync(source));
      current.user = "user edited during experiment";
      if (scenario === "unsafe-cleanup") {
        current.work = 7;
        fs.writeFileSync(source, JSON.stringify(current));
        assert.notEqual(current.work, changed.work, "overlapping user work is not safe to restore");
        trace.push({
          kind: "stop",
          reason: "unsafe overlapping cleanup",
          completed: "setup, baseline, H1 and checks",
          remaining: "resolve owned edit boundary with user; no reset or replacement",
        });
        assert.equal(JSON.parse(fs.readFileSync(source)).work, 7);
        assert.equal(JSON.parse(fs.readFileSync(source)).user, current.user);
        return { scenario, status: "flagged", measurements, trace };
      }
      current.work = initial.work;
      delete current.padding;
      fs.writeFileSync(source, JSON.stringify(current));
      assert.equal(JSON.parse(fs.readFileSync(source)).user, "user edited during experiment");
    }
    assert.equal(JSON.parse(fs.readFileSync(source)).work, kept ? after : initial.work);
    const record = {
      date: "2026-10-01 00:00",
      label: proposal.hypothesis,
      hypothesis: proposal.hypothesis,
      method: proposal.method,
      change: "work field only",
      metric: {
        primary_value: after === null ? "unmeasured" : String(after),
        delta_vs_baseline: after === null ? "unavailable" : String(after - before),
      },
      regression: regression ? "passed" : "failed; metric not run",
      status: kept ? "kept" : "discarded",
      conclusion: `baseline=${before}; constraints=${constraints}; ${kept ? "improved compliant change" : "owned edits restored; preserve user changes"}`,
      provenance: {
        command: proposal.method,
        conditions: "deterministic work.json; unchanged judge",
      },
    };
    const saved = call(["state", "experiments", "publish", "--objective", owner.id, "--input", "-"], record);
    assert.match(saved.id, /^[a-z]{10}$/);
    if (scenario === "resume") {
      call(["state", "experiments", "publish", "--objective", owner.id, "--id", saved.id, "--input", "-"], record);
    }
    const history = call(["state", "experiments", "list", "--objective", owner.id]);
    assert.equal(history.entries.length, 2, "one baseline and one named experiment, no duplicates");
    assert.equal(call(["state", "experiments", "get", "--id", saved.id]).entry.record.status, record.status);
    assert.equal(fs.readFileSync(harness, "utf8"), judge);
    assert.equal(trace.filter((event) => event.kind === "host-response").length, 1);
    assert.equal(trace.filter((event) => event.kind === "implement").length, 1);
    assert.equal(measurements, regression ? 2 : 1);
    assert.equal(fs.existsSync(path.join(root, ".agentera/optimize")), false, "reuse tooling, no duplicate harness");
    trace.push({
      kind: "stop",
      retained: "relevant open objective, existing usable judge, baseline and one actionable experiment record",
      remaining: "none within named experiment",
    });
    return { scenario, status: record.status, measurements, trace };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export const optimizeScenarios = ["keep", "decline", "silence", "already-met", "no-improvement", "regression-fail", "constraint-fail", "unsafe-cleanup", "resume", "missing-approval", "stale-evidence", "blocked", ...["target", "method", "hypothesis", "scope", "limit"].map((field) => `drift-${field}`)];
