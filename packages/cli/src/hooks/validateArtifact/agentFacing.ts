/**
 * Re-exports of protocol classification sets used by the validator.
 * Kept as a separate module so the runtime, schema, and orchestrator
 * submodules can all share the same set identity (no duplication of
 * the AGENT_FACING_ARTIFACT_IDS computation across hot paths).
 */

import { ARTIFACT_PROTOCOL_PATHS, HUMAN_FACING_ARTIFACT_IDS } from "../../registries/artifactProtocolIds.js";

export { ARTIFACT_PROTOCOL_PATHS, HUMAN_FACING_ARTIFACT_IDS };

export const AGENT_FACING_ARTIFACT_IDS = new Set(
  Object.keys(ARTIFACT_PROTOCOL_PATHS).filter((id) => !HUMAN_FACING_ARTIFACT_IDS.has(id)),
);
