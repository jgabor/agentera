import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

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
