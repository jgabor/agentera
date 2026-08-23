import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { sourceModuleUrl, sourceSubprocessEnv } from "./sourceSubprocess.js";

const CLI_DISPATCH_URL = sourceModuleUrl("cli/dispatch.js");
const STATE_LIST_URL = sourceModuleUrl("state/listRetrieval.js");
const FIXTURE_BOUNDARY_MARKER = "__AGENTERA_COLD_CLI_FIXTURE_BOUNDARY__";
const DIAGNOSTIC_UTF8_LIMIT = 4_096;
const DEBUG_ENV_NAMES = ["NODE_INSPECT_RESUME_ON_START", "NODE_OPTIONS"] as const;
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

export function measureColdStateList(options: {
  project: string;
  repoRoot: string;
}): Promise<ColdMeasurement> {
  const { project, repoRoot } = options;
  const runner = `const { boundStateList, listStateEntries } = await import(${JSON.stringify(STATE_LIST_URL)}); await new Promise((resolve) => { const keepAlive = setInterval(() => {}, 1000); globalThis.__agenteraColdCliContinue = () => { clearInterval(keepAlive); resolve(); }; process.stderr.write(${JSON.stringify(`${FIXTURE_BOUNDARY_MARKER}\n`)}); }); const response = boundStateList(listStateEntries(process.cwd(), "progress", 20, {}, undefined, { sourceRoot: ${JSON.stringify(repoRoot)} }), "json", ${JSON.stringify(repoRoot)}, process.cwd()); process.stdout.write(JSON.stringify(response, null, 2) + "\\n");`;
  return measureColdProcess({
    operation: "state progress list",
    runner,
    cwd: project,
    env: {
      ...sourceSubprocessEnv(),
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: repoRoot,
    },
  });
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
    operation: args.join(" "),
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

function bounded(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= DIAGNOSTIC_UTF8_LIMIT) return text;
  const marker = "<truncated>";
  let end = DIAGNOSTIC_UTF8_LIMIT - Buffer.byteLength(marker, "utf8");
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

export function coldCliFailureEvidence(options: {
  operation: string;
  stdout: string;
  stderr: string;
  childArgs: string[];
  env: NodeJS.ProcessEnv;
  exitCode?: number | null;
}): string {
  return JSON.stringify({
    operation: bounded(options.operation),
    exitCode: options.exitCode ?? null,
    stdout: bounded(options.stdout),
    stderr: bounded(options.stderr),
    childArgs: options.childArgs,
    presentDebugEnvNames: DEBUG_ENV_NAMES.filter((name) => options.env[name] !== undefined),
  });
}

function measureColdProcess(options: {
  operation: string;
  runner: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ColdMeasurement> {
  const { operation, runner, cwd, env } = options;
  const childArgs = ["--inspect-brk=127.0.0.1:0", "--input-type=module", "--eval", "<inline-runner>"];
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
      execArgv: childArgs,
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
      () => fail(new Error("cold CLI did not complete serialized output")),
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

    const fail = (error: Error, exitCode?: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.close();
      child.kill();
      reject(new Error(`${error.message}; evidence: ${coldCliFailureEvidence({
        operation,
        stdout,
        stderr,
        childArgs,
        env,
        exitCode,
      })}`));
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
      socket.onerror = () => fail(new Error("inspector connection failed"));
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
        fail(new Error(`cold CLI exited ${code}`), code);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    });
  });
}
