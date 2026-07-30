import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { sourceModuleUrl, sourceSubprocessEnv } from "./sourceSubprocess.js";

const CLI_DISPATCH_URL = sourceModuleUrl("cli/dispatch.js");
const FIXTURE_BOUNDARY_MARKER = "__AGENTERA_COLD_CLI_FIXTURE_BOUNDARY__";
export const EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT = 512;

export type ColdMeasurement = {
  elapsedMs: number;
  heapDeltaBytes: number;
  peakHeapBytes: number;
  baselineHeapBytes: number;
  inspectorSamples: number;
  baselineNormalization: "HeapProfiler.collectGarbage";
  runtime: {
    node: string;
    v8: string;
    effectiveChildFlags: {
      execArgv: string[];
      nodeOptions: {
        value: string;
        truncated: false;
        utf8Bytes: number;
      } | null;
      nodeOptionsUtf8Limit: number;
    };
  };
  stdout: string;
};

type InspectorRequest = (method: string, params?: Record<string, unknown>) => Promise<any>;

export async function collectGarbageThenReadBaseline(
  request: InspectorRequest,
): Promise<{ usedSize: number }> {
  await request("HeapProfiler.collectGarbage");
  return (await request("Runtime.getHeapUsage")) as { usedSize: number };
}

export function measureColdCli(options: {
  args: string[];
  project: string;
  home: string;
  repoRoot: string;
}): Promise<ColdMeasurement> {
  return measureColdCliOperation(options, "");
}

export function measureColdCliWithRetainedAllocation(options: {
  args: string[];
  project: string;
  home: string;
  repoRoot: string;
  elements: number;
}): Promise<ColdMeasurement> {
  if (!Number.isSafeInteger(options.elements) || options.elements < 1) {
    throw new Error("retained allocation elements must be a positive safe integer");
  }
  return measureColdCliOperation(
    options,
    `globalThis.__coldMeasurementRetained = new Array(${options.elements}).fill(1);`,
  );
}

function measureColdCliOperation(
  options: { args: string[]; project: string; home: string; repoRoot: string },
  beforeOperation: string,
): Promise<ColdMeasurement> {
  const { args, project, home, repoRoot } = options;
  const runner = `const { main } = await import(${JSON.stringify(CLI_DISPATCH_URL)}); await new Promise((resolve) => { const keepAlive = setInterval(() => {}, 1000); globalThis.__agenteraColdCliContinue = () => { clearInterval(keepAlive); resolve(); }; process.stderr.write(${JSON.stringify(`${FIXTURE_BOUNDARY_MARKER}\n`)}); }); ${beforeOperation} process.exitCode = main(["node", "agentera", ...${JSON.stringify(args)}]);`;
  return measureColdProcess({
    runner,
    cwd: project,
    env: {
      ...sourceSubprocessEnv(),
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: repoRoot,
      AGENTERA_HOME: path.join(home, "agentera"),
      HOME: home,
    },
  });
}

function measureColdProcess(options: {
  runner: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ColdMeasurement> {
  const { runner, cwd, env } = options;
  const nodeOptions = env.NODE_OPTIONS;
  const nodeOptionsUtf8Bytes = Buffer.byteLength(nodeOptions ?? "", "utf8");
  if (nodeOptionsUtf8Bytes > EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT) {
    throw new Error(
      `effective NODE_OPTIONS is ${nodeOptionsUtf8Bytes} UTF-8 bytes; evidence limit ${EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT}`,
    );
  }
  const runtime: ColdMeasurement["runtime"] = {
    node: process.version,
    v8: process.versions.v8,
    effectiveChildFlags: {
      execArgv: ["--inspect-brk=127.0.0.1:0", "--input-type=module", "--eval", "<inline-runner>"],
      nodeOptionsUtf8Limit: EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT,
      nodeOptions:
        nodeOptions === undefined
          ? null
          : {
              value: nodeOptions,
              truncated: false,
              utf8Bytes: nodeOptionsUtf8Bytes,
            },
    },
  };
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      ["--inspect-brk=127.0.0.1:0", "--input-type=module", "--eval", runner],
      {
        cwd,
        env,
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
      () => fail(new Error(`cold CLI did not complete serialized output; stderr: ${stderr}; stdout: ${stdout}`)),
      30_000,
    );
    const fixtureBoundary = new Promise<void>((boundaryResolve) => {
      const waitForBoundary = (chunk: unknown): void => {
        if (!String(chunk).includes(FIXTURE_BOUNDARY_MARKER)) return;
        child.stderr.off("data", waitForBoundary);
        boundaryResolve();
      };
      child.stderr.on("data", waitForBoundary);
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
    const request: InspectorRequest = (method, params) =>
      new Promise((requestResolve, requestReject) => {
        const id = nextId++;
        pending.set(id, { resolve: requestResolve, reject: requestReject });
        socket?.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
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
          await request("HeapProfiler.enable");
          await request("Runtime.runIfWaitingForDebugger");
          await fixtureBoundary;
          const baseline = await collectGarbageThenReadBaseline(request);
          let peakHeapBytes = baseline.usedSize;
          let inspectorSamples = 1;
          await request("Runtime.evaluate", {
            expression:
              "globalThis.__agenteraColdCliContinue(); delete globalThis.__agenteraColdCliContinue",
          });
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
            baselineNormalization: "HeapProfiler.collectGarbage",
            runtime,
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
