import os from "node:os";
import path from "node:path";

import { expanduser } from "../core/paths.js";
import { assessProductV1Evidence, loadProductV1ResetAuthority, productV1EvidencePaths, productV1InstallRootCandidate } from "../upgrade/productV1ResetAuthority.js";
import type { Io } from "./dispatch/shared.js";
import { emitStructured } from "./structured.js";

type Format = "text" | "json" | "yaml";
const authority = loadProductV1ResetAuthority();

export function productV1Evidence(projectRoot: string, env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string[] {
  const installRoot = path.resolve(expanduser(productV1InstallRootCandidate(null, env, home)));
  return productV1EvidencePaths(assessProductV1Evidence({ project: projectRoot, installRoot }, authority));
}

/** Read-only EOL gate. */
export function enforceProductV1Eol(projectRoot: string, format: Format, io: Io = {}): number | null {
  const evidence = productV1Evidence(path.resolve(projectRoot));
  if (evidence.length === 0) return null;

  const error = {
    class: "product_v1_eol",
    message: "Agentera product v1 is end-of-life and cannot be used by the v3 CLI.",
    evidence,
    reset_workflow: ["Run agentera upgrade --reset-product-v1 --dry-run.", "Review every deletion, recreation, and irreversible loss in that preview.", "Explicitly approve apply to remove scoped Agentera state and initialize fresh v3 state."],
    recovery: "Preview the product-v1 reset, then apply with --yes and the preview authorization; this command did not change state.",
  };
  if (format === "json" || format === "yaml") {
    emitStructured({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error }, format, io.out ?? ((text) => process.stdout.write(text)));
  } else {
    const err = io.err ?? ((text: string) => process.stderr.write(text));
    err(`Error: ${error.message}\nReset workflow: ${error.reset_workflow.join(" ")}\nRecovery: ${error.recovery}\n`);
  }
  return 1;
}
