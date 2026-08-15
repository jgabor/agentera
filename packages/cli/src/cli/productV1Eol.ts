import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCandidate } from "../state/installRoot.js";
import {
  isProductV1PackageVersion,
  loadProductV1ResetAuthority,
} from "../upgrade/productV1ResetAuthority.js";
import type { Io } from "./dispatch/shared.js";
import { emitStructured } from "./structured.js";

type Format = "text" | "json" | "yaml";
const authority = loadProductV1ResetAuthority();

function installedProductV1Evidence(): string | null {
  const [installRoot] = resolveCandidate(null, { env: process.env, home: os.homedir() });
  const manifest = path.join(installRoot, authority.installationPackage.manifest);
  if (!fs.existsSync(manifest)) return null;
  try {
    const registry = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      skills?: Array<{ version?: unknown }>;
    };
    const version = registry.skills?.[0]?.version;
    return typeof version === "string" && isProductV1PackageVersion(version) ? manifest : null;
  } catch {
    return null;
  }
}

export function productV1Evidence(projectRoot: string): string[] {
  const evidence = authority.projectArtifacts
    .filter(({ triggersReset, path: relativePath }) => triggersReset && fs.existsSync(path.join(projectRoot, relativePath)))
    .map(({ path: relativePath }) => path.join(projectRoot, relativePath));
  const installation = installedProductV1Evidence();
  if (installation) evidence.push(installation);
  return evidence;
}

/** Read-only EOL gate. Reset preview and apply are delivered by later tasks. */
export function enforceProductV1Eol(projectRoot: string, format: Format, io: Io = {}): number | null {
  const evidence = productV1Evidence(path.resolve(projectRoot));
  if (evidence.length === 0) return null;

  const error = {
    class: "product_v1_eol",
    message: "Agentera product v1 is end-of-life and cannot be used by the v3 CLI.",
    evidence,
    reset_workflow: [
      "Preview the declared product-v1 reset scope when the reset workflow is available.",
      "Review every deletion, recreation, and irreversible loss in that preview.",
      "Explicitly approve apply to remove scoped Agentera state and initialize fresh v3 state.",
    ],
    recovery: "Wait for the product-v1 reset preview and apply workflow; this command did not change state.",
  };
  if (format === "json" || format === "yaml") {
    emitStructured({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error }, format, io.out ?? ((text) => process.stdout.write(text)));
  } else {
    const err = io.err ?? ((text: string) => process.stderr.write(text));
    err(`Error: ${error.message}\nReset workflow: ${error.reset_workflow.join(" ")}\nRecovery: ${error.recovery}\n`);
  }
  return 1;
}
