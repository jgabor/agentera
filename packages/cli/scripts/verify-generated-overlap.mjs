#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectGeneratedGeneration } from "./build-package.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-real-overlap-"));
const barrier = path.join(root, "barrier");
const participants = {
  source: ["run", "test:source", "--", "test/build/generatedOutputPublication.test.ts", "test/upgrade/appContentRefresh.test.ts", "test/upgrade/installedSkillMdV3.test.ts", "test/upgrade/installedContractV3.test.ts"],
  build: ["run", "build"],
  package: ["run", "verify:package"],
};

function start(participant, args) {
  const output = path.join(root, `${participant}.log`);
  const stream = fs.createWriteStream(output);
  const child = spawn("pnpm", args, {
    cwd: packageRoot,
    env: {
      ...process.env,
      AGENTERA_VERIFICATION_BARRIER: barrier,
      AGENTERA_VERIFICATION_PARTICIPANT: participant,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      stream.end();
      if (code === 0) resolve(output);
      else reject(new Error(`${participant} overlap command failed with exit ${code}; log: ${output}`));
    });
  });
}

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (!Object.keys(participants).every((name) => fs.existsSync(path.join(barrier, `${name}.ready`)))) {
    if (Date.now() >= deadline) throw new Error(`real overlap participants did not become ready under ${barrier}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function counts(text) {
  const files = text.match(/Test Files\s+(\d+) passed/);
  const tests = text.match(/Tests\s+(\d+) passed/);
  return { files: Number(files?.[1] ?? 0), tests: Number(tests?.[1] ?? 0) };
}

try {
  for (const target of [".agentera-generated", "dist", "bundle"]) {
    fs.rmSync(path.join(packageRoot, target), { recursive: true, force: true });
  }
  const running = Object.entries(participants).map(([name, args]) => [name, start(name, args)]);
  await waitForReady();
  fs.writeFileSync(path.join(barrier, "release"), "release\n");
  const logs = Object.fromEntries(await Promise.all(running.map(async ([name, done]) => [name, await done])));
  const source = counts(fs.readFileSync(logs.source, "utf8"));
  const packageResult = counts(fs.readFileSync(logs.package, "utf8"));
  if (source.files < 4 || source.tests < 1 || packageResult.files < 2 || packageResult.tests < 1) {
    throw new Error(`real overlap result validation failed: ${JSON.stringify({ source, package: packageResult, logs })}`);
  }
  const selected = selectGeneratedGeneration(packageRoot);
  const invocation = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(packageRoot, "dist/bin/agentera.js"), "--version"], { cwd: packageRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`selected CLI failed: ${stderr}`)));
  });
  console.log(JSON.stringify({ status: "pass", source, package: packageResult, generation: selected.id, invocation }, null, 2));
} catch (error) {
  console.error(`verify-generated-overlap: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (process.exitCode !== 1) fs.rmSync(root, { recursive: true, force: true });
}
