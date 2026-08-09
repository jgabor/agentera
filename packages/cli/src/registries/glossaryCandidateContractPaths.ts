import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";

/** Resolve the authority shared by the candidate-layer contract readers. */
export function glossaryCandidateContractsAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "artifacts", "glossary-entry-contract.yaml");
}
