import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const discussScenarios = ["approve", "refusal", "silence", "changed-proposal", "intent-gap", "scoped-pivot", "provisional", "writer-failure"];

// The served Discuss rule each scenario follows; the journey asserts it is present.
const RULES = {
  approve: "append the decision, then file the follow-up work the decision calls for and report each write with its undo",
  refusal: "Skip or silence writes nothing",
  silence: "Skip or silence writes nothing",
  "changed-proposal": '"Save this exact closeout?"',
  "intent-gap": "If the user still ends, save nothing as firm and exit flagged with the gap named",
  "scoped-pivot": "the conclusion contradicts prior decisions without acknowledgment",
  provisional: "Record facts you cannot check as conditions in the decision",
  "writer-failure": "if one fails, report what saved and what did not",
  "pending-transaction": "if one fails, report what saved and what did not",
};

// Cooperative host model, not an LLM/UI test or enforcement of human consent.
// Every observable save/read uses the supplied real CLI; no production consent store.
export async function discussCloseoutJourney(cli, scenario, interruptTodo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-discuss-closeout-"));
  const trace = [];
  const call = async (args, input, ok = true) => {
    const result = await cli(root, args, input);
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
    const detail = await call(["prime", "--context", "discuss", "--detail", "instructions", "--section", "instructions", "--limit", "20"]);
    assert.equal(detail.completeness.complete, true);
    const guidance = detail.items.map((item) => item.content).join("");
    assert.ok(guidance.includes(RULES[scenario]), `served Discuss instructions lack the ${scenario} rule`);
    assert.ok(guidance.includes("Offer **Approve**, **Revise** and **Done (skip saving)**"));
    assert.ok(guidance.includes("Larger or ordered work is a suggestion of ≡ plan that waits for the user's yes"));
    for (const [artifact, verb] of [
      ["decisions", "append"],
      ["todo", "create"],
    ]) {
      await call(["state", artifact, "explain", "--verb", verb, "--section", "detail"]);
    }
    const previousDecision = {
      date: "2026-10-01",
      question: "Which clients should retry?",
      context: "Existing commitment",
      alternatives: [{ name: "All clients", status: "chosen" }],
      choice: "Retry all clients",
      reasoning: "Original scope",
      confidence: "firm",
      feeds_into: "Client retry work",
    };
    const previous = await call(["state", "decisions", "append", "--input", "-"], previousDecision);
    const before = snapshot();
    const unchanged = () => assert.deepEqual(snapshot(), before);

    if (scenario === "intent-gap") {
      trace.push({ kind: "question", text: "Should retries cover desktop clients too?", options: ["Desktop too", "Mobile only", "Done"] });
      trace.push({ kind: "host-response", value: "Done" });
      trace.push({ kind: "gap", text: "Whether desktop clients retry is still open" });
      unchanged();
      return { scenario, status: "flagged", trace };
    }

    const pivot = scenario === "scoped-pivot";
    const provisional = scenario === "provisional";
    const decision = {
      date: "2026-10-01",
      question: "How should client retries be bounded?",
      context: provisional ? "Bound the retry policy. Condition: the mobile SDK's retry hook is unverified." : "Bound the existing retry policy without implementation.",
      alternatives: [{ name: pivot ? "Mobile-only exception" : "Bound all clients", status: "chosen" }],
      choice: pivot ? "Mobile-only exception to the prior all-client commitment; desktop remains unchanged." : "Bound retries to three attempts",
      reasoning: pivot ? `Explicit scoped exception to decision ${previous.id}; preserve its history.` : "Avoid unbounded retries",
      confidence: provisional ? "provisional" : "firm",
      feeds_into: "Client retry TODO; implementation separately gated",
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
    const proposal = { decision, followUp: "one build cycle: file a TODO", basis: { previous: previous.id } };
    trace.push({ kind: "proposal", proposal: structuredClone(proposal) });
    trace.push({ kind: "question", text: "Save this exact closeout?", options: ["Approve", "Revise", "Done (skip saving)"] });
    const response = scenario === "refusal" ? "Done (skip saving)" : scenario === "silence" ? null : "Approve";
    trace.push({ kind: "host-response", value: response });
    if (!response || response === "Done (skip saving)") {
      unchanged();
      return { scenario, status: "waiting", trace };
    }
    if (scenario === "changed-proposal") {
      const approved = structuredClone(proposal);
      proposal.decision.choice = "Unlimited retries and implement now";
      assert.notDeepEqual(proposal, approved);
      trace.push({ kind: "blocked", reason: "Changed proposal requires fresh approval" });
      unchanged();
      return { scenario, status: "waiting", trace };
    }

    const saved = await call(["state", "decisions", "append", "--input", "-"], decision);
    assert.deepEqual((await call(["state", "decisions", "get", "--id", saved.id])).entry.record, decision);
    const create = ["state", "todo", "create", "--input", "-"];
    const preview = await call([...create, "--dry-run"], todo);
    const apply = [...create, "--effect-sha256", preview.effect_sha256, "--yes"];

    if (scenario === "writer-failure" || scenario === "pending-transaction") {
      if (scenario === "writer-failure") {
        // Fixture-only environmental failure: the public TODO file becomes a directory.
        const publicPath = path.join(root, "TODO.md");
        fs.unlinkSync(publicPath);
        fs.mkdirSync(publicPath);
        await call(apply, todo, false);
      } else {
        interruptTodo(root, todo, preview.effect_sha256);
        const blocked = await call(["state", "todo", "list"], undefined, false);
        assert.ok(blocked.error.message.includes("pending"));
      }
      trace.push({ kind: "report", saved: [{ artifact: "decisions", id: saved.id }], notSaved: ["TODO: Bound client retry attempts"] });
      assert.deepEqual((await call(["state", "decisions", "get", "--id", saved.id])).entry.record, decision);
      return { scenario, status: "stuck", trace };
    }

    const created = await call(apply, todo);
    const id = created.local_refs.retry;
    assert.deepEqual((await call(["state", "todo", "get", "--id", id])).entry.record.requirements, [decision.choice]);
    trace.push({
      kind: "report",
      saved: [
        { artifact: "decisions", id: saved.id, undo: `remove uncommitted ${path.relative(root, saved.path)}` },
        { artifact: "todo", id, undo: `state todo resolve --id ${id}` },
      ],
    });
    const complete = snapshot();
    assert.equal((await call(apply, todo)).operation.idempotent_replay, true);
    assert.deepEqual(snapshot(), complete);
    trace.push({ kind: "suggestion", capability: "plan", started: false });
    assert.equal((await call(["state", "plan", "list"])).entries.length, 0);
    assert.deepEqual((await call(["state", "decisions", "get", "--id", previous.id])).entry.record, previousDecision);
    assert.equal((await call(["state", "decisions", "list"])).entries.length, 2);
    assert.equal(fs.readFileSync(path.join(root, ".agentera/vision.yaml"), "utf8"), "purpose: preserve unrelated vision\n");
    assert.equal(fs.readFileSync(path.join(root, "code.ts"), "utf8"), "// not authorized to implement\n");
    assert.ok(fs.readFileSync(path.join(root, "TODO.md"), "utf8").includes("User notes must remain."));
    const approvalQuestions = trace.filter((item) => item.kind === "question" && item.text === "Save this exact closeout?");
    assert.equal(approvalQuestions.length, 1);
    const status = provisional ? "flagged" : "complete";
    trace.push({ kind: "verified", status });
    return { scenario, status, trace };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
