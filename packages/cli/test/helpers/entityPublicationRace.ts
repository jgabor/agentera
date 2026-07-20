import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceSubprocessEnv } from "./sourceSubprocess.js";

const publicationWorker = fileURLToPath(new URL("../state/entityPublicationWorker.mjs", import.meta.url));

export interface PublicationResult {
  published: boolean;
  error?: string;
}

function publicationProcess(
  root: string,
  artifact: string,
  boundary: string,
  resultPath: string,
  readyPath: string,
  startPath: string,
  controls: { ownerOpenedPath?: string; continuePath?: string; waitingPath?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [publicationWorker], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_ENTITY_TEST_ROOT: root,
        AGENTERA_ENTITY_TEST_ARTIFACT: artifact,
        AGENTERA_ENTITY_TEST_BOUNDARY: boundary,
        AGENTERA_ENTITY_TEST_RESULT: resultPath,
        AGENTERA_ENTITY_TEST_READY: readyPath,
        AGENTERA_ENTITY_TEST_START: startPath,
        AGENTERA_ENTITY_TEST_OWNER_OPENED: controls.ownerOpenedPath,
        AGENTERA_ENTITY_TEST_CONTINUE: controls.continuePath,
        AGENTERA_ENTITY_TEST_WAITING: controls.waitingPath,
      },
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`publication worker exited ${code}: ${stderr}`)));
  });
}

export async function waitForFiles(paths: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => fs.existsSync(candidate))) {
    if (Date.now() >= deadline) throw new Error(`publication workers did not become ready: ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function concurrentPublication(root: string, suffix = ""): Promise<PublicationResult[]> {
  const healthResult = path.join(root, `health${suffix}-result.json`);
  const decisionsResult = path.join(root, `decisions${suffix}-result.json`);
  const healthReady = path.join(root, `health${suffix}.ready`);
  const decisionsReady = path.join(root, `decisions${suffix}.ready`);
  const startPath = path.join(root, `publication${suffix}.start`);
  const workers = [
    publicationProcess(root, "health", "health_audit", healthResult, healthReady, startPath),
    publicationProcess(root, "decisions", "decision", decisionsResult, decisionsReady, startPath),
  ];
  await waitForFiles([healthReady, decisionsReady]);
  fs.writeFileSync(startPath, "start\n");
  await Promise.all(workers);
  return [healthResult, decisionsResult].map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as PublicationResult);
}

export { publicationProcess };
