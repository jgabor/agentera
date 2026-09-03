import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "@typescript/typescript6";

const sourceRoot = fs.realpathSync(fileURLToPath(new URL("../src/", import.meta.url)));
const approvedSourceUrls = new Set();

export function canonicalContainedRegularFile(root, candidate) {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonicalCandidate = fs.realpathSync(candidate);
    if (!canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)) return null;
    return fs.statSync(canonicalCandidate).isFile() ? canonicalCandidate : null;
  } catch {
    return null;
  }
}

function explicitRelative(specifier) {
  return (specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.includes("?") && !specifier.includes("#");
}

function sourceFile(specifier, parentURL) {
  if (!parentURL || !explicitRelative(specifier)) return null;
  try {
    const parent = new URL(parentURL);
    if (parent.protocol !== "file:" || parent.search || parent.hash) return null;
    const candidate = new URL(specifier, parent);
    if (candidate.protocol !== "file:" || candidate.search || candidate.hash) return null;
    return canonicalContainedRegularFile(sourceRoot, fileURLToPath(candidate));
  } catch {
    return null;
  }
}

function canonicalSourceUrl(url) {
  try {
    const candidate = new URL(url);
    if (candidate.protocol !== "file:" || candidate.search || candidate.hash) return null;
    const canonical = canonicalContainedRegularFile(sourceRoot, fileURLToPath(candidate));
    return canonical ? pathToFileURL(canonical).href : null;
  } catch {
    return null;
  }
}

function resolvedSource(canonical) {
  const url = pathToFileURL(canonical).href;
  approvedSourceUrls.add(url);
  return { format: "module", shortCircuit: true, url };
}

export async function resolve(specifier, context, nextResolve) {
  if (explicitRelative(specifier) && specifier.endsWith(".js") && canonicalSourceUrl(context.parentURL)) {
    const canonical = sourceFile(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (canonical) return resolvedSource(canonical);
  }

  if (explicitRelative(specifier) && specifier.endsWith(".ts")) {
    const canonical = sourceFile(specifier, context.parentURL);
    if (canonical) return resolvedSource(canonical);
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const canonical = canonicalSourceUrl(url);
  if (!canonical || !approvedSourceUrls.has(canonical) || !canonical.endsWith(".ts")) {
    return nextLoad(url, context);
  }

  const file = fileURLToPath(canonical);
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  });
  return { format: "module", shortCircuit: true, source: output.outputText };
}
