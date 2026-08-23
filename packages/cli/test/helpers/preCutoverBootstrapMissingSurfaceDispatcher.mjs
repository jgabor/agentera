import fs from "node:fs";
import path from "node:path";

import { dispatchPreCutoverBootstrap } from "./preCutoverBootstrapDispatcher.mjs";

const [runtimeRootInput, requiredFilesJson] = process.argv.slice(2);
const command = "npx -y agentera@next prime --context status --format json";

function containedRelativePath(root, relative) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) {
    throw new Error("required runtime surface must be one relative path");
  }
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("required runtime surface escapes the runtime root");
  }
  return target;
}

try {
  const runtimeRoot = path.resolve(runtimeRootInput);
  const requiredFiles = JSON.parse(requiredFilesJson);
  if (!Array.isArray(requiredFiles)) throw new Error("required runtime surfaces must be an array");
  const observations = [];
  for (const [index, relative] of requiredFiles.entries()) {
    const target = containedRelativePath(runtimeRoot, relative);
    const held = `${target}.agentera-held-${process.pid}-${index}`;
    const sentinel = path.join(process.cwd(), `.agentera-missing-surface-${process.pid}-${index}.sentinel`);
    fs.renameSync(target, held);
    let result;
    try {
      result = await dispatchPreCutoverBootstrap({
        identityJson: JSON.stringify({ owner: "prime.status", source: command }),
        candidate: command,
        runtimeRoot,
        project: process.cwd(),
        sentinel,
        environmentEvidence: `${sentinel}.environment.json`,
        spawn() {
          fs.writeFileSync(sentinel, "spawn-boundary-reached\n", { flag: "wx" });
          return { status: 0, stdout: "", stderr: "" };
        },
      });
    } finally {
      fs.renameSync(held, target);
    }
    const childStarted = fs.existsSync(sentinel);
    if (childStarted) fs.rmSync(sentinel);
    observations.push({
      relative,
      status: result.status,
      classification: result.classification,
      childStarted,
      restored: fs.existsSync(target) && !fs.existsSync(held),
      diagnostic: result.diagnostic,
    });
  }
  process.stdout.write(`${JSON.stringify(observations)}\n`);
  process.exit(observations.some(({ status, classification, childStarted, restored }) =>
    status !== 64 || classification !== "invalid_authority" || childStarted || !restored
  ) ? 65 : 0);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ diagnostic: String(error?.message ?? error) })}\n`);
  process.exit(64);
}
