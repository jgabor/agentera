import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const discussScenarios = ["bundle", "decision-only", "refusal", "silence", "changed-proposal", "scoped-pivot", "qualified-gap", "resume", "writer-failure"];

// Cooperative host model, not an LLM/UI test or enforcement of human consent.
// Every observable save/read uses the supplied real CLI; no production consent store.
export function discussCloseoutJourney(cli, scenario, interruptTodo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-discuss-closeout-"));
  const trace = [];
  const call = (args, input, ok = true) => {
    const result = cli(root, args, input);
    trace.push({ kind: "cli", args, rc: result.rc });
    if (ok) assert.equal(result.rc, 0, JSON.stringify(result.json));
    else assert.notEqual(result.rc, 0);
    return result.json;
  };
  const snapshot = () => {
    const files = {};
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else files[path.relative(root, file)] = fs.readFileSync(file).toString("hex");
      }
    };
    visit(root);
    return files;
  };
  try {
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(root, ".agentera/todo-reconciliation-activation.json"), '{"schema_version":"agentera.todoReconciliationActivation.v1","retained_legacy_rows":[]}\n');
    fs.writeFileSync(path.join(root, "TODO.md"), "# TODO\n\nUser notes must remain.\n");
    fs.writeFileSync(path.join(root, ".agentera/vision.yaml"), "purpose: preserve unrelated vision\n");
    fs.writeFileSync(path.join(root, "code.ts"), "// not authorized to implement\n");
    const detail = call(["prime", "--context", "discuss", "--detail", "instructions", "--section", "instructions", "--limit", "20"]);
    assert.equal(detail.completeness.complete, true);
    const guidance = detail.items.map((item) => item.content).join("");
    assert.ok(guidance.includes("Save this exact closeout?"));
    assert.ok(!guidance.includes("Offer to capture and connect"));
    const shared = call(["schema", "--protocol", "--section", "OPERATING_RULES"]);
    assert.equal(shared.completeness.complete, true);
    assert.ok(JSON.stringify(shared).includes("whole-project audit"));
    const inventory = call(["state", "query", "--list-artifacts"]);
    const design = inventory.artifacts.find((item) => item.artifact === "design");
    assert.equal(design.path.exists, false);
    for (const [artifact, verb] of [
      ["decisions", "append"],
      ["todo", "create"],
      ["plan", "update"],
    ]) {
      call(["state", artifact, "explain", "--verb", verb, "--section", "detail"]);
    }
    const previousDecision = {
      date: "2026-10-01",
      question: "Which clients should retry?",
      context: "Existing commitment",
      alternatives: [{ name: "All clients", status: "chosen" }],
      choice: "Retry all clients",
      reasoning: "Original scope",
      confidence: "firm",
      feeds_into: "Existing client plan",
    };
    const previous = call(["state", "decisions", "append", "--input", "-"], previousDecision);
    const plan = call(["state", "plan", "create", "--input", "-"], {
      header: { level: "light", created: "2026-10-01", status: "open", title: "Client retry plan" },
      what: "Specify retry scope for `code.ts` without changing code",
      why: "Retain the selected scope",
      scope: { included: ["client retry policy"], excluded: ["implementation"] },
      tasks: [
        {
          number: 1,
          name: "Specify client retries",
          status: "pending",
          acceptance: ["All clients retry"],
        },
      ],
    });
    const tasks = call(["state", "plan", "get", "--id", plan.id]).tasks;
    const task = tasks[0];
    assert.equal(task.record.status, "pending");
    const before = snapshot();
    const pivot = scenario === "scoped-pivot";
    const gap = scenario === "qualified-gap";
    if (pivot || gap) {
      trace.push({
        kind: "question",
        text: pivot ? "Allow a mobile-only exception?" : "Close with the missing design authority flagged?",
        options: ["Accept scoped outcome", "Done"],
      });
      trace.push({ kind: "host-response", value: "Accept scoped outcome" });
    }
    const decision = {
      date: "2026-10-01",
      question: "How should client retries be bounded?",
      context: gap ? "Design authority is absent; its implications remain unverified." : "Bound the existing retry policy without implementation.",
      alternatives: [{ name: pivot ? "Mobile-only exception" : "Bound all clients", status: "chosen" }],
      choice: pivot ? "Mobile-only exception to the prior all-client commitment; desktop remains unchanged." : "Bound retries to three attempts",
      reasoning: pivot ? `Explicit scoped exception to decision ${previous.id}; preserve its history.` : "Avoid unbounded retries",
      confidence: gap ? "provisional" : "firm",
      feeds_into: gap ? "Client retry plan; unresolved design tension, flagged closure" : "Client retry plan and TODO; implementation separately gated",
    };
    const todo = {
      schema_version: "agentera.todoCreateBatch.v1",
      creates: [
        {
          local_ref: "retry",
          record: {
            kind: "feat",
            title: "Bound client retry attempts",
            severity: "normal",
            target_version: null,
            release_blocker: false,
            requirements: [decision.choice],
            acceptance: ["At most three approved attempts"],
          },
        },
      ],
    };
    const patch = { acceptance: [decision.choice] };
    const update = ["state", "plan", "update", "--id", task.id, "--plan", plan.id, "--input", "-"];
    const create = ["state", "todo", "create", "--input", "-"];
    const preview = call([...create, "--dry-run"], todo);
    call([...update, "--dry-run"], patch);
    assert.deepEqual(snapshot(), before);
    const proposal = {
      decision,
      todo,
      plan: { id: plan.id, task: task.id, patch },
      basis: { previous: previous.id, task: task.record },
    };
    trace.push({ kind: "proposal", proposal: structuredClone(proposal) });
    trace.push({
      kind: "question",
      text: "Save this exact closeout?",
      options: ["Approve displayed bundle", "Decision only", "Done (skip saving)"],
    });
    const response = scenario === "refusal" ? "Done (skip saving)" : scenario === "silence" ? null : scenario === "decision-only" ? "Decision only" : "Approve displayed bundle";
    trace.push({ kind: "host-response", value: response });
    if (!response || response === "Done (skip saving)") {
      assert.deepEqual(snapshot(), before);
      return { scenario, status: "waiting", trace };
    }
    const approved = structuredClone(proposal);
    if (scenario === "changed-proposal") {
      proposal.decision.choice = "Unlimited retries and implement now";
      assert.notDeepEqual(proposal, approved);
      trace.push({ kind: "blocked", reason: "Changed proposal requires fresh approval" });
      assert.deepEqual(snapshot(), before);
      return { scenario, status: "waiting", trace };
    }
    const saved = call(["state", "decisions", "append", "--input", "-"], decision);
    assert.deepEqual(call(["state", "decisions", "get", "--id", saved.id]).entry.record, decision);
    if (response === "Decision only") {
      assert.equal(call(["state", "todo", "list"]).entries.length, 0);
      assert.deepEqual(call(["state", "plan", "get", "--id", plan.id]).tasks[0].record, task.record);
    } else {
      const apply = [...create, "--effect-sha256", preview.effect_sha256, "--yes"];
      if (scenario === "resume" || scenario === "writer-failure") {
        if (scenario === "writer-failure") {
          // Fixture-only environmental failure: the approved public file becomes
          // a directory. Restore its exact bytes, never change the approved batch.
          const publicPath = path.join(root, "TODO.md");
          const original = fs.readFileSync(publicPath);
          fs.unlinkSync(publicPath);
          fs.mkdirSync(publicPath);
          call(apply, todo, false);
          assert.deepEqual(call(["state", "plan", "get", "--id", plan.id]).tasks[0].record, task.record);
          trace.push({
            kind: "incomplete",
            saved: [saved.id],
            remaining: ["TODO batch", "dependent plan patch"],
          });
          fs.rmdirSync(publicPath);
          fs.writeFileSync(publicPath, original);
        } else
          trace.push({
            kind: "incomplete",
            saved: [saved.id],
            remaining: ["TODO batch", "dependent plan patch"],
          });
        // Current-state proof before continuing an unchanged approval. Native
        // append replay proves no duplicate; it does not authorize new content.
        assert.deepEqual(call(["state", "decisions", "get", "--id", saved.id]).entry.record, decision);
        assert.equal(call(["state", "todo", "list"]).entries.length, 0);
        const replay = call(["state", "decisions", "append", "--input", "-"], decision);
        assert.equal(replay.id, saved.id);
        assert.equal(replay.operation.idempotent_replay, true);
      }
      if (scenario === "pending-transaction") {
        interruptTodo(root, todo, preview.effect_sha256);
        const blocked = call(["state", "todo", "list"], undefined, false);
        assert.ok(blocked.error.message.includes("pending"));
        trace.push({
          kind: "incomplete",
          saved: [saved.id],
          unverified: ["TODO batch"],
          remaining: ["dependent plan patch"],
        });
        const pending = snapshot();
        call(apply, { ...todo, creates: [] }, false);
        assert.deepEqual(snapshot(), pending);
      }
      const created = call(apply, todo);
      const id = created.local_refs.retry;
      assert.deepEqual(call(["state", "todo", "get", "--id", id]).entry.record.requirements, [decision.choice]);
      assert.deepEqual(call(["state", "decisions", "get", "--id", saved.id]).entry.record, decision);
      call(update, patch);
      const actual = call(["state", "plan", "get", "--id", plan.id]).tasks[0];
      assert.deepEqual(actual.record.acceptance, patch.acceptance);
      assert.equal(actual.record.status, "pending");
      assert.equal(actual.record.name, task.record.name);
      const complete = snapshot();
      assert.equal(call(apply, todo).operation.idempotent_replay, true);
      assert.equal(call(update, patch).operation.idempotent_replay, true);
      assert.deepEqual(snapshot(), complete);
    }
    assert.deepEqual(call(["state", "decisions", "get", "--id", previous.id]).entry.record, previousDecision);
    assert.equal(call(["state", "decisions", "list"]).entries.length, 2);
    assert.equal(fs.readFileSync(path.join(root, ".agentera/vision.yaml"), "utf8"), "purpose: preserve unrelated vision\n");
    assert.equal(fs.readFileSync(path.join(root, "code.ts"), "utf8"), "// not authorized to implement\n");
    assert.ok(fs.readFileSync(path.join(root, "TODO.md"), "utf8").includes("User notes must remain."));
    const approvalQuestions = trace.filter((item) => item.kind === "question" && item.text === "Save this exact closeout?");
    assert.equal(approvalQuestions.length, 1);
    trace.push({ kind: "verified", status: gap ? "flagged" : "complete" });
    return { scenario, status: gap ? "flagged" : "complete", trace };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
