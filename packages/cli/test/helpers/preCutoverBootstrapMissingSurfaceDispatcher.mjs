import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRootInput, requiredFilesJson] = process.argv.slice(2);

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
  const authority = await import(
    pathToFileURL(path.join(runtimeRoot, "dist/core/developmentInvocation.js")).href
  );
  const observations = [];
  for (const [index, relative] of requiredFiles.entries()) {
    const target = containedRelativePath(runtimeRoot, relative);
    const held = `${target}.agentera-held-${process.pid}-${index}`;
    fs.renameSync(target, held);
    let classification = "accepted";
    let diagnostic = "";
    try {
      authority.assertDevelopmentRuntimeSurface(runtimeRoot);
    } catch (error) {
      classification = error && typeof error === "object" && "classification" in error
        ? error.classification
        : "invalid_authority";
      diagnostic = String(error?.message ?? error);
    } finally {
      fs.renameSync(held, target);
    }
    observations.push({
      relative,
      status: classification === "accepted" ? 0 : 64,
      classification,
      childStarted: false,
      restored: fs.existsSync(target) && !fs.existsSync(held),
      diagnostic,
    });
  }
  process.stdout.write(`${JSON.stringify(observations)}\n`);
  process.exit(observations.some(({ classification, restored }) => classification === "accepted" || !restored) ? 65 : 0);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ diagnostic: String(error?.message ?? error) })}\n`);
  process.exit(64);
}
