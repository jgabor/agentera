import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { sourceModuleUrl, sourceSubprocessEnv } from "./sourceSubprocess.js";

const CLI_DISPATCH_URL = sourceModuleUrl("cli/dispatch.js");

export type ColdMeasurement = {
  elapsedMs: number;
  heapDeltaBytes: number;
  peakHeapBytes: number;
  baselineHeapBytes: number;
  inspectorSamples: number;
  stdout: string;
};

export function measureColdCli(options: {
  args: string[];
  project: string;
  home: string;
  repoRoot: string;
}): Promise<ColdMeasurement> {
  const { args, project, home, repoRoot } = options;
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const runner = `const { main } = await import(${JSON.stringify(CLI_DISPATCH_URL)}); debugger; process.exitCode = main(["node", "agentera", ...${JSON.stringify(args)}]);`;
    const child = spawn(
      process.execPath,
      ["--inspect-brk=127.0.0.1:0", "--input-type=module", "--eval", runner],
      {
        cwd: project,
        env: {
          ...sourceSubprocessEnv(),
          AGENTERA_BOOTSTRAP_SOURCE_ROOT: repoRoot,
          AGENTERA_HOME: path.join(home, "agentera"),
          HOME: home,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let outputAt: number | undefined;
    let socket: WebSocket | undefined;
    let nextId = 1;
    let result: ColdMeasurement | undefined;
    let settled = false;
    const timeout = setTimeout(
      () => fail(new Error(`cold CLI did not complete serialized output: ${stderr || stdout}`)),
      30_000,
    );
    let continueFromFixtureBoundary: (() => void) | undefined;
    const fixtureBoundary = new Promise<void>((boundaryResolve) => {
      continueFromFixtureBoundary = boundaryResolve;
    });
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.close();
      child.kill();
      reject(error);
    };
    const request = (method: string): Promise<any> =>
      new Promise((requestResolve, requestReject) => {
        const id = nextId++;
        pending.set(id, { resolve: requestResolve, reject: requestReject });
        socket?.send(JSON.stringify({ id, method }));
      });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      try {
        JSON.parse(stdout);
        outputAt ??= performance.now();
      } catch {
        // Wait for the complete serialized JSON envelope.
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      const endpoint = stderr.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
      if (!endpoint || socket) return;
      socket = new WebSocket(endpoint);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          method?: string;
          result?: any;
          error?: { message: string };
        };
        if (message.method === "Debugger.paused") {
          continueFromFixtureBoundary?.();
          continueFromFixtureBoundary = undefined;
        }
        if (message.id === undefined) return;
        const handler = pending.get(message.id);
        if (!handler) return;
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error.message));
        else handler.resolve(message.result);
      };
      socket.onerror = () => fail(new Error(`inspector connection failed: ${stderr}`));
      socket.onopen = async () => {
        try {
          await request("Runtime.enable");
          await request("Debugger.enable");
          await request("Runtime.runIfWaitingForDebugger");
          await fixtureBoundary;
          const baseline = (await request("Runtime.getHeapUsage")) as { usedSize: number };
          let peakHeapBytes = baseline.usedSize;
          let inspectorSamples = 1;
          await request("Debugger.resume");
          while (outputAt === undefined) {
            await new Promise((sample) => setTimeout(sample, 1));
            const usage = (await request("Runtime.getHeapUsage")) as { usedSize: number };
            peakHeapBytes = Math.max(peakHeapBytes, usage.usedSize);
            inspectorSamples += 1;
          }
          const finalUsage = (await request("Runtime.getHeapUsage")) as { usedSize: number };
          peakHeapBytes = Math.max(peakHeapBytes, finalUsage.usedSize);
          inspectorSamples += 1;
          result = {
            elapsedMs: outputAt - startedAt,
            heapDeltaBytes: peakHeapBytes - baseline.usedSize,
            peakHeapBytes,
            baselineHeapBytes: baseline.usedSize,
            inspectorSamples,
            stdout,
          };
          socket?.close();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || !result) {
        fail(new Error(`cold CLI exited ${code}: ${stderr || stdout}`));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

function entityId(index: number): string {
  let value = index;
  const letters = Array.from({ length: 10 }, () => {
    const letter = String.fromCharCode(97 + (value % 26));
    value = Math.floor(value / 26);
    return letter;
  });
  return letters.reverse().join("");
}

type FixtureEntity = {
  id: string;
  artifact: string;
  boundary: string;
  record: Record<string, any>;
};

export function createEntityAuthorityFixture(
  project: string,
  count: number,
  contract: Record<string, any>,
): {
  exactId: string;
  progressCount: number;
  boundaryCounts: Record<string, number>;
  relationshipEdges: string[];
} {
  fs.rmSync(path.join(project, ".agentera"), { recursive: true, force: true });
  fs.mkdirSync(path.join(project, ".agentera"));
  fs.writeFileSync(
    path.join(project, ".agentera", "state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  const entities: FixtureEntity[] = [];
  const add = (artifact: string, boundary: string, record: Record<string, any>): string => {
    const id = entityId(entities.length);
    const directory = path.join(project, ".agentera", "entities", artifact, boundary);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact, record }));
    entities.push({ id, artifact, boundary, record });
    return id;
  };
  const progress = (index: number): string =>
    add("progress", "progress_cycle", {
      timestamp: `2026-07-${String((index % 28) + 1).padStart(2, "0")} 00:00`,
      type: "test",
      phase: "audit",
      what: `Fixture ${index}`,
      context: { intent: "Measure" },
    });

  const decisionRecord = {
    date: "2026-07-19",
    question: "Decision 0?",
    context: "Budget graph",
    alternatives: [{ name: "E", status: "chosen" }],
    choice: "E",
    reasoning: "R",
    confidence: "firm",
  };
  const decision = add("decisions", "decision", decisionRecord);
  add("decisions", "decision_satisfaction", {
    decision,
    state: "user_confirmed_satisfied",
    user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-19T00:00:00Z" },
  });
  add("decisions", "decision_revision", {
    decision,
    date: "2026-07-19",
    provenance: "historical_revision",
    base_sha256: createHash("sha256").update(canonicalRecordJson(decisionRecord)).digest("hex"),
    changes: { choice: "E0" },
  });
  const plan = add("plan", "plan", {
    header: { title: "Plan 0", created: "2026-07-19", status: "complete" },
    what: "W",
    why: "Y",
    scope: { included: ["T"], excluded: [] },
  });
  const dependency = add("plan", "plan_task", {
    plan,
    name: "A",
    status: "complete",
    depends_on: [],
    acceptance: ["V"],
  });
  add("plan", "plan_task", {
    plan,
    name: "B",
    status: "complete",
    depends_on: [dependency],
    acceptance: ["V"],
  });
  const objective = add("objective", "objective", {
    header: { title: "Objective 0", status: "complete", created: "2026-07-19" },
    objective: { description: "D", measurement: "M" },
    metric: {},
    baseline: {},
    scope: {},
  });
  add("experiments", "experiment", {
    objective,
    date: "2026-07-19 00:00",
    label: "Experiment 0",
    hypothesis: "H",
    method: "M",
    change: "C",
    metric: {},
    regression: "R",
    status: "baseline",
    conclusion: "C",
  });
  let exactId = progress(0);
  add("health", "health_audit", {
    date: "2026-07-19",
    dimensions: ["test_health"],
    findings_summary: { critical: 0, warning: 0, info: 0 },
    trajectory: "S",
    grades: { test_health: "A" },
  });
  add("todo", "todo_item", { severity: "normal", status: "resolved", description: "TODO 0" });
  add("docs", "documentation_inventory_entry", {
    document: "Doc 0",
    path: "docs/0.md",
    last_updated: "2026-07-19",
    status: "current",
  });
  while (entities.length < count) {
    const id = progress(entities.length);
    exactId ||= id;
  }

  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const relationshipEdges = (
    contract.entity_target.relationships.declarations as Array<Record<string, string>>
  )
    .filter((declaration) =>
      entities.some((entity) => {
        if (entity.boundary !== declaration.source) return false;
        const values = Array.isArray(entity.record[declaration.field])
          ? entity.record[declaration.field]
          : [entity.record[declaration.field]];
        return values.some((id) => byId.get(id)?.boundary === declaration.target);
      }),
    )
    .map((declaration) => `${declaration.source}.${declaration.field}->${declaration.target}`);
  const boundaryCounts = Object.fromEntries(
    (contract.entity_target.entities as Array<Record<string, string>>).map(({ boundary }) => [
      boundary,
      entities.filter((entity) => entity.boundary === boundary).length,
    ]),
  );
  return {
    exactId,
    progressCount: boundaryCounts.progress_cycle,
    boundaryCounts,
    relationshipEdges,
  };
}
