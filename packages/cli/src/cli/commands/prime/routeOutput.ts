import path from "node:path";

import { loadCapabilitySchemaContract } from "../../../registries/capabilityContract.js";
import { loadTriggerModel } from "../../../registries/triggerLoader.js";
import { routeInput } from "../../../routing/index.js";
import { resolveSourceRoot } from "../../../core/sourceRoot.js";

/**
 * `prime --route` output builder. Invokes the Layer 3-4 routing engine against
 * the loaded trigger model and emits the request-derived route payload defined
 * in references/cli/trigger-schema-enrichment.md §7.1. Mutually exclusive with
 * the orientation dashboard: this payload MUST NOT include `next_action` or any
 * state-derived field (spec §7.3).
 */

const ROUTE_CONTRACT_REL = "skills/agentera/capability_schema_contract.yaml";
const ROUTE_SPEC = "references/cli/trigger-schema-enrichment.md";

function roundConfidence(n: number): number {
  return Math.round(n);
}

export interface RoutePayloadCandidate {
  capability: string;
  confidence: number;
  hint?: string;
}

export interface RoutePayloadRoute {
  capability: string;
  confidence: number;
  fallback: boolean;
  candidates: RoutePayloadCandidate[];
}

export interface RoutePayload {
  command: "prime --route";
  status: "ok";
  route: RoutePayloadRoute;
  input: string;
  source_contract: {
    engine: "layer-3-4";
    spec: string;
  };
}

/** Build the `prime --route` JSON payload for the given input text. */
export function buildRoutePayload(input: string, options: { sourceRoot?: string } = {}): RoutePayload {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contractPath = path.join(sourceRoot, ROUTE_CONTRACT_REL);
  const contract = loadCapabilitySchemaContract(contractPath);
  const model = loadTriggerModel(contract, { sourceRoot });
  const result = routeInput(input, model);

  const candidates: RoutePayloadCandidate[] = result.candidates.map((c) => {
    const rounded: RoutePayloadCandidate = {
      capability: c.capability,
      confidence: roundConfidence(c.confidence),
    };
    if (c.hint !== undefined) rounded.hint = c.hint;
    return rounded;
  });

  return {
    command: "prime --route",
    status: "ok",
    route: {
      capability: result.capability,
      confidence: roundConfidence(result.confidence),
      fallback: result.fallback,
      candidates,
    },
    input,
    source_contract: {
      engine: "layer-3-4",
      spec: ROUTE_SPEC,
    },
  };
}
