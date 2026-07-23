import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { HybridRouteRegistryError, resolveRouteRequest } from "../../src/registries/hybridRoute.js";
import { loadCapabilitySchemaContract } from "../../src/registries/capabilityContract.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const CAPABILITY_CONTRACT = loadCapabilitySchemaContract(path.join(ROOT, "skills/agentera/capability_schema_contract.yaml"));
const CORPUS = YAML.parse(fs.readFileSync(path.join(ROOT, "fixtures/routing/hybrid-corpus.yaml"), "utf8")) as {
  route_cases: Array<{ id: string; request: string; expected: Record<string, string> }>;
};
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function route(request: string) {
  return resolveRouteRequest(request, ROOT);
}

function copiedAuthority(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-route-"));
  temporaryRoots.push(root);
  fs.cpSync(path.join(ROOT, "skills"), path.join(root, "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, "references", "cli"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "references/cli/hybrid-route-contract.yaml"),
    path.join(root, "references/cli/hybrid-route-contract.yaml"),
  );
  return root;
}

describe("deterministic hybrid route resolver", () => {
  it("resolves every canonical capability name and primary alias through direct routing", () => {
    for (const { capability, alias } of CAPABILITY_CONTRACT.routeAliases.primaryAliases) {
      for (const name of new Set([capability, alias])) {
        const result = route(`/agentera ${name} preserve this topic`);
        expect(result).toMatchObject({ outcome: "deterministic_selection", tier: "direct", capability });
        if (result.outcome === "deterministic_selection") {
          const bytes = Buffer.from(`/agentera ${name} preserve this topic`, "utf8");
          expect(bytes.subarray(result.topic_span.start, result.topic_span.end).toString("utf8")).toBe(" preserve this topic");
        }
      }
    }
  });

  it("resolves every frozen deterministic case with exact byte spans", () => {
    for (const routeCase of CORPUS.route_cases) {
      const result = route(routeCase.request);
      expect(result.outcome, routeCase.id).toBe(routeCase.expected.phase1);
      if (result.outcome === "deterministic_selection") {
        expect(result.tier, routeCase.id).toBe(routeCase.expected.tier);
        expect(result.capability, routeCase.id).toBe(routeCase.expected.capability);
        const bytes = Buffer.from(routeCase.request, "utf8");
        expect(bytes.subarray(result.topic_span.start, result.topic_span.end).toString("utf8"), routeCase.id)
          .toBe(routeCase.expected.topic ?? bytes.subarray(result.recognized_span.end).toString("utf8"));
      }
    }
  });

  it("normalizes phrase comparison while retaining original Unicode, whitespace, and separator bytes", () => {
    const result = route("  ＨＥＬＰ\tＭＥ　ＤＥＣＩＤＥ： cache");
    expect(result).toMatchObject({ outcome: "deterministic_selection", tier: "phrase", capability: "discuss" });
    if (result.outcome !== "deterministic_selection") return;
    const bytes = Buffer.from("  ＨＥＬＰ\tＭＥ　ＤＥＣＩＤＥ： cache", "utf8");
    expect(bytes.subarray(result.recognized_span.start, result.recognized_span.end).toString("utf8"))
      .toBe("ＨＥＬＰ\tＭＥ　ＤＥＣＩＤＥ");
    expect(bytes.subarray(result.topic_span.start, result.topic_span.end).toString("utf8")).toBe("： cache");
  });

  it("abstains for negated, quoted, partial, unsupported punctuation, and non-owned text", () => {
    for (const request of [
      "Do not help me decide; just show alternatives.",
      'The words "help me decide" appear in this quote.',
      "help me deciding now",
      "help me decide! now",
      "refine the vision",
      "/agentera planner import safety",
    ]) {
      expect(route(request).outcome, request).toBe("semantic_required");
    }
  });

  it("rejects a phrase collision before routing", () => {
    const root = copiedAuthority();
    const phrasesPath = path.join(root, "skills/agentera/route-phrases.yaml");
    const phrases = YAML.parse(fs.readFileSync(phrasesPath, "utf8"));
    phrases.phrases.push({
      id: "RP_DUPLICATE",
      capability: "vision",
      phrase: "HELP ME DECIDE",
      status: "deprecated",
    });
    fs.writeFileSync(phrasesPath, YAML.stringify(phrases));
    expect(() => resolveRouteRequest("help me decide", root)).toThrow(HybridRouteRegistryError);
  });

  it("does not let malformed retired matcher metadata change semantic abstention", () => {
    const request = "uniquely legacy route";
    const expected = resolveRouteRequest(request, copiedAuthority());

    for (const [field, value] of [
      ["patterns", 1],
      ["patterns_regex", ["(unclosed"]],
      ["confidence_threshold", "invalid"],
      ["borderline_band", {}],
    ]) {
      const root = copiedAuthority();
      const triggersPath = path.join(root, "skills/agentera/capabilities/status/schemas/triggers.yaml");
      const triggers = YAML.parse(fs.readFileSync(triggersPath, "utf8"));
      triggers.TRIGGERS[1][field] = value;
      fs.writeFileSync(triggersPath, YAML.stringify(triggers));

      expect(resolveRouteRequest(request, root), field).toEqual(expected);
    }
  });
});
