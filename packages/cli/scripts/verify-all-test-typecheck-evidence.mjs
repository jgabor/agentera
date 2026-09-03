import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EVIDENCE_PATH = path.join(ROOT, "packages/cli/test/fixtures/all-test-typecheck-viability.yaml");

export function verifyEvidence() {
  const evidence = YAML.parse(fs.readFileSync(EVIDENCE_PATH, "utf8"));
  const compiler = evidence.measurement.compiler_diagnostics;
  const files = Object.entries(compiler.files_by_count).flatMap(([count, names]) => names.map((name) => [name, Number(count)]));
  const errors = [];

  if (evidence.outcome !== "source-only-retain") errors.push("outcome must be source-only-retain");
  if (Object.values(compiler.by_code).reduce((sum, count) => sum + Number(count), 0) !== compiler.total) errors.push("by_code total differs");
  if (files.length !== compiler.files || files.reduce((sum, [, count]) => sum + count, 0) !== compiler.total) errors.push("files_by_count differs");
  if (compiler.source !== 0) errors.push("source compiler diagnostics must remain zero");

  const valid = evidence.classification_examples.valid;
  if (!fs.existsSync(path.join(ROOT, "packages/cli", valid.file)) || files.some(([name]) => name === valid.file)) errors.push("valid case is stale");

  const invalid = evidence.classification_examples.intentional_invalid;
  const source = fs.readFileSync(path.join(ROOT, "packages/cli", invalid.file), "utf8");
  if (!source.includes('it("rejects package contract drift outside version and gitRef"') || !source.includes('unexpected: "1.0.0"') || invalid.code !== "TS2353") errors.push("intentional-invalid case is stale");

  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = verifyEvidence();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("all-test typecheck evidence: pass");
  }
}
