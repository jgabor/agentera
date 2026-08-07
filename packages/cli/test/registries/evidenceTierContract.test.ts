import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ADAPTER_VERSION,
  FAMILIES,
} from "../../src/analytics/extractCorpus/core.js";
import {
  compatibilityStates,
  consumerMap,
  EvidenceTierContractError,
  evidenceTierAuthorityPath,
  loadEvidenceTierContract,
  PROFILE_SYNTHESIS_CONSUMER,
  REQUIRED_COMPATIBILITY_STATES,
  REQUIRED_SIGNAL_KINDS,
  REQUIRED_SOURCE_FAMILIES,
  signalSemantics,
  STARTUP_ANALYSIS_CONSUMER,
  supportedSourceFamilies,
  validateEvidenceTierContract,
  type CompatibilityStateId,
  type TierId,
} from "../../src/registries/evidenceTierContract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PRODUCTION_CONTRACT = evidenceTierAuthorityPath();
const RELATIVE_CONTRACT = "references/analysis/evidence-tier-authority.yaml";

// Runtime source products emitted by resolveRuntimeStoreConfigs (coverageAudit.ts).
// The contract must cover every one without silent omission.
const RUNTIME_SOURCE_PRODUCTS = [
  "codex",
  "cursor",
  "cursor-agent",
  "opencode",
  "github-copilot",
  "claude-code",
] as const;

// signalType() (core.ts) yields these kinds; the contract must reserve them.
const RUNTIME_SIGNAL_TYPES = ["correction", "question", "decision"] as const;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-tier-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Build a complete, valid contract object that the validator accepts. */
function validContractObject(): Record<string, unknown> {
  const families: Record<string, unknown> = {};
  for (const family of REQUIRED_SOURCE_FAMILIES) {
    const isHistorical = family === "claude-code";
    families[family] = {
      source_class: isHistorical ? "historical_import" : "active_runtime",
      source_product: family === "copilot" ? "github-copilot" : family,
      active_runtime: !isHistorical,
      accepted_input: "fixtures",
      store_glob: "*.jsonl",
      ...(isHistorical ? { inclusion_rule: "explicit import only" } : {}),
    };
  }

  const consumers: Record<string, unknown> = {
    usage_stats: {
      tier: "signal",
      purpose: "analytics",
      required_fields: ["source_kind", "timestamp"],
      source_identity: "source_id",
      input_contract: "signal conversation_turn",
    },
    [STARTUP_ANALYSIS_CONSUMER]: {
      tier: "signal",
      purpose: "startup analysis",
      required_fields: ["source_kind", "timestamp", "evidence_anchor"],
      source_identity: "source_id",
      input_contract: "signal projection",
    },
    [PROFILE_SYNTHESIS_CONSUMER]: {
      tier: "signal",
      purpose: "profile synthesis",
      required_fields: ["source_kind", "signal_type", "timestamp", "evidence_anchor"],
      source_identity: "source_id and evidence_anchor",
      input_contract: "signal instruction/decision/question/config projection",
    },
  };

  const semantics: Record<string, unknown> = {};
  for (const kind of REQUIRED_SIGNAL_KINDS) {
    semantics[kind] = {
      meaning: `${kind} meaning`,
      derivable_from: "records",
      consumer: "glossary",
    };
  }

  const states: Record<string, unknown> = {};
  for (const state of REQUIRED_COMPATIBILITY_STATES) {
    states[state] = {
      trigger: `${state} trigger`,
      status: "stale",
      reason: state,
      outcome: "degrade",
      recovery: "refresh tiers",
    };
  }

  return {
    schema_version: "agentera.evidenceTierAuthority.v1",
    status: "active_authority",
    tiers: {
      full_evidence: { tier_id: "full_evidence", rank: 1, stored_fields: { required: ["source_id"], optional: [] } },
      signal: { tier_id: "signal", rank: 2, stored_fields: { required: ["source_id"], optional: [] } },
    },
    source_families: { families },
    consumer_map: {
      consumers,
      semantic_consumers: {
        glossary: {
          tier: "signal",
          status: "active",
          input_scope: "bounded_personal_history",
          excluded_evidence_classes: ["project_file"],
          required_semantics: [...REQUIRED_SIGNAL_KINDS],
        },
      },
    },
    signal_semantics: { kinds: semantics },
    compatibility_states: { states },
    bounds: {
      reader_byte_cap: 67108864,
      shard_byte_cap: 67108864,
      signal_byte_cap: 67108864,
    },
    profile_sufficiency: {
      profile_signal_types: ["decision", "question", "correction", "instruction", "configuration"],
      minimum_family_retention: 0.5,
    },
    decision_55_reconciliation: { decision_number: 55 },
  };
}

function writeFixture(mutate?: (obj: Record<string, unknown>) => void): string {
  const obj = validContractObject();
  mutate?.(obj);
  const contractPath = path.join(tmp, "authority.yaml");
  fs.writeFileSync(contractPath, YAML.stringify(obj));
  return contractPath;
}

describe("evidence tier authority — production contract", () => {
  it("resolves, loads, and satisfies every Task 1 invariant (AC1-AC4)", () => {
    expect(fs.existsSync(PRODUCTION_CONTRACT), PRODUCTION_CONTRACT).toBe(true);
    const model = loadEvidenceTierContract(PRODUCTION_CONTRACT);
    expect(model.schemaVersion).toBe("agentera.evidenceTierAuthority.v1");
    expect(model.status).toBe("active_authority");
    expect(model.tierIds).toEqual(["full_evidence", "signal"]);
    expect(validateEvidenceTierContract(PRODUCTION_CONTRACT)).toEqual([]);
  });

});

describe("AC1 — one bounded input contract supplies every required field with source identity", () => {
  it("every consumer declares a tier, required fields, source identity, and input contract", () => {
    for (const consumer of consumerMap(PRODUCTION_CONTRACT)) {
      expect(["full_evidence", "signal"] as TierId[]).toContain(consumer.tier);
      expect(consumer.required_fields.length, consumer.consumer_id).toBeGreaterThan(0);
      expect(consumer.source_identity, consumer.consumer_id).toBeTruthy();
      expect(consumer.input_contract, consumer.consumer_id).toBeTruthy();
    }
  });

  it("includes the latent startup-analysis reader in the consumer map", () => {
    const ids = consumerMap(PRODUCTION_CONTRACT).map((c) => c.consumer_id);
    expect(ids).toContain(STARTUP_ANALYSIS_CONSUMER);
  });

  it("rejects a consumer missing its input contract", () => {
    const errors = validateEvidenceTierContract(
      writeFixture((obj) => {
        const consumers = (obj.consumer_map as Record<string, unknown>).consumers as Record<string, unknown>;
        delete (consumers.usage_stats as Record<string, unknown>).input_contract;
      }),
    );
    expect(errors.some((e) => e.includes("usage_stats") && e.includes("input_contract"))).toBe(true);
  });
});

describe("AC2 — no supported source family is silently omitted", () => {
  it("covers Codex, Cursor, OpenCode, Copilot, and historical Claude", () => {
    const families = supportedSourceFamilies(PRODUCTION_CONTRACT);
    expect(families.sort()).toEqual([...REQUIRED_SOURCE_FAMILIES].sort());
  });

  it("the cursor family covers both Cursor and Cursor Agent source products", () => {
    const model = loadEvidenceTierContract(PRODUCTION_CONTRACT);
    const cursor = model.families.get("cursor");
    expect(cursor).toBeDefined();
    const products = Array.isArray(cursor!.source_product) ? cursor!.source_product : [cursor!.source_product];
    expect(products).toEqual(expect.arrayContaining(["cursor", "cursor-agent"]));
  });

  it("historical Claude is import-only and not an active runtime", () => {
    const claude = loadEvidenceTierContract(PRODUCTION_CONTRACT).families.get("claude-code");
    expect(claude?.source_class).toBe("historical_import");
    expect(claude?.active_runtime).toBe(false);
    expect(claude?.inclusion_rule).toBeTruthy();
  });

  it("contract source products cover every runtime extractor source product exactly", () => {
    const model = loadEvidenceTierContract(PRODUCTION_CONTRACT);
    const declared = new Set<string>();
    for (const family of model.families.values()) {
      const products = Array.isArray(family.source_product) ? family.source_product : [family.source_product];
      for (const product of products) declared.add(product);
    }
    for (const product of RUNTIME_SOURCE_PRODUCTS) {
      expect(declared.has(product), `runtime product ${product} not covered by contract`).toBe(true);
    }
  });

  it("rejects a contract that drops a supported source family", () => {
    const errors = validateEvidenceTierContract(
      writeFixture((obj) => {
        const families = (obj.source_families as Record<string, unknown>).families as Record<string, unknown>;
        delete families.opencode;
      }),
    );
    expect(errors.some((e) => e.includes("opencode") && e.includes("omitted"))).toBe(true);
  });
});

describe("AC3 — signal semantics required meaning available to current and deferred consumers", () => {
  it("reserves signal meaning and conversation provenance identity fields", () => {
    const kinds = signalSemantics(PRODUCTION_CONTRACT).map((s) => s.kind);
    expect(kinds.sort()).toEqual([...REQUIRED_SIGNAL_KINDS].sort());
    for (const semantic of signalSemantics(PRODUCTION_CONTRACT)) {
      expect(semantic.meaning, semantic.kind).toBeTruthy();
      expect(semantic.derivable_from, semantic.kind).toBeTruthy();
      expect(semantic.consumer, semantic.kind).toBe("glossary");
    }
  });

  it("every record family and runtime signal type the extractor emits is represented in the contract", () => {
    const model = loadEvidenceTierContract(PRODUCTION_CONTRACT);
    // Extractor record families (source_kind) map to instruction/configuration/etc.
    const semantics = new Set(model.signalSemantics.keys());
    expect(semantics.has("instruction")).toBe(FAMILIES.includes("instruction_document"));
    expect(semantics.has("configuration")).toBe(FAMILIES.includes("project_config_signal"));
    for (const type of RUNTIME_SIGNAL_TYPES) {
      expect(semantics.has(type), `runtime signal type ${type} reserved`).toBe(true);
    }
  });

  it("active glossary consumer requires only semantics the contract actually defines", () => {
    const model = loadEvidenceTierContract(PRODUCTION_CONTRACT);
    const glossary = model.semanticConsumers.get("glossary");
    expect(glossary?.status).toBe("active");
    for (const kind of glossary!.required_semantics) {
      expect(model.signalSemantics.has(kind), `glossary requires undefined ${kind}`).toBe(true);
    }
  });

  it("reserves bounded personal history without classifying project files as history evidence", () => {
    const glossary = loadEvidenceTierContract(PRODUCTION_CONTRACT).semanticConsumers.get("glossary");
    expect(glossary?.input_scope).toBe("bounded_personal_history");
    expect(glossary?.excluded_evidence_classes).toContain("project_file");
  });

  it("rejects an active glossary declaration that admits project files as history evidence", () => {
    const errors = validateEvidenceTierContract(
      writeFixture((obj) => {
        const consumers = (obj.consumer_map as Record<string, any>).semantic_consumers;
        consumers.glossary.excluded_evidence_classes = [];
      }),
    );
    expect(errors).toContain(
      "active glossary evidence must use bounded personal history and exclude project files",
    );
  });

  it("rejects a contract that drops a reserved signal semantic", () => {
    const errors = validateEvidenceTierContract(
      writeFixture((obj) => {
        delete ((obj.signal_semantics as Record<string, unknown>).kinds as Record<string, unknown>).decision;
      }),
    );
    expect(errors.some((e) => e.includes("decision") && e.includes("omitted"))).toBe(true);
  });

  it("rejects a contract that drops conversation content fingerprints", () => {
    const errors = validateEvidenceTierContract(
      writeFixture((obj) => {
        delete ((obj.signal_semantics as Record<string, unknown>).kinds as Record<string, unknown>)
          .content_fingerprint;
      }),
    );
    expect(errors.some((e) => e.includes("content_fingerprint") && e.includes("omitted"))).toBe(true);
  });
});

describe("AC4 — oversized, legacy, missing, corrupt, incomplete compatibility is deterministic and actionable", () => {
  it("every required state has a fixed status, reason, recover/degrade outcome, and recovery action", () => {
    const states = compatibilityStates(PRODUCTION_CONTRACT);
    const ids = states.map((s) => s.state_id).sort();
    expect(ids).toEqual([...REQUIRED_COMPATIBILITY_STATES].sort());
    for (const state of states) {
      expect(["recover", "degrade"]).toContain(state.outcome);
      expect(state.status).toBeTruthy();
      expect(state.reason).toBeTruthy();
      expect(state.recovery, state.state_id).toBeTruthy();
    }
  });

  it("oversized degrades but keeps the signal tier usable (useful analysis, not merely graceful failure)", () => {
    const oversized = loadEvidenceTierContract(PRODUCTION_CONTRACT).compatibilityStates.get("oversized");
    expect(oversized?.outcome).toBe("degrade");
    expect(oversized?.recovery).toContain("signal tier");
  });

  it("legacy monolithic state receives deterministic refresh guidance, not indefinite read compatibility", () => {
    const legacy = loadEvidenceTierContract(PRODUCTION_CONTRACT).compatibilityStates.get("legacy");
    expect(legacy?.outcome).toBe("degrade");
    expect(legacy?.recovery).toContain("refresh");
    expect(legacy?.reason).toBe("legacy_monolithic_state");
  });

  it("rejects a compatibility state with a non-deterministic outcome", () => {
    const contractPath = writeFixture((obj) => {
      const states = (obj.compatibility_states as Record<string, unknown>).states as Record<string, unknown>;
      (states.missing as Record<string, unknown>).outcome = "maybe";
    });
    // Structurally the loader rejects non-canonical outcomes before validation.
    expect(() => loadEvidenceTierContract(contractPath)).toThrow(EvidenceTierContractError);
  });

  it("flags a compatibility state missing actionable recovery", () => {
    const errors = validateEvidenceTierContract(
      writeFixture((obj) => {
        const states = (obj.compatibility_states as Record<string, unknown>).states as Record<string, unknown>;
        delete (states.corrupt as Record<string, unknown>).recovery;
        // Make outcome valid so the validator reaches the recovery check.
        (states.corrupt as Record<string, unknown>).outcome = "recover";
      }),
    );
    expect(errors.some((e) => e.includes("corrupt") && e.includes("recovery"))).toBe(true);
  });

  it("rejects an omitted compatibility state", () => {
    const errors = validateEvidenceTierContract(
      writeFixture((obj) => {
        const states = (obj.compatibility_states as Record<string, unknown>).states as Record<string, unknown>;
        delete states.incomplete;
      }),
    );
    expect(errors.some((e) => e.includes("incomplete") && e.includes("omitted"))).toBe(true);
  });
});

describe("Decision 55 reconciliation", () => {
  it("references Decision 55 by number without rewriting its adopted text", () => {
    const raw = YAML.parse(fs.readFileSync(PRODUCTION_CONTRACT, "utf8")) as Record<string, unknown>;
    const rec = raw.decision_55_reconciliation as Record<string, unknown>;
    expect(rec.decision_number).toBe(55);
    expect(String(rec.preserved_intent)).toContain("agentera stats");
    expect(String(rec.superseded_surface)).toContain("corpus.json");
    expect(String(rec.non_goal)).toContain("rewrite");
  });

  it("loader exposes the reconciled decision number", () => {
    expect(loadEvidenceTierContract(PRODUCTION_CONTRACT).decisionNumber).toBe(55);
  });
});

describe("bounds and scope", () => {
  it("acknowledges the 64 MiB reader cap and real-scale corpora", () => {
    const raw = YAML.parse(fs.readFileSync(PRODUCTION_CONTRACT, "utf8")) as Record<string, unknown>;
    const bounds = raw.bounds as Record<string, unknown>;
    expect(bounds.reader_byte_cap).toBe(64 * 1024 * 1024);
    expect(String(bounds.real_scale_acknowledgement)).toContain("500 MB");
  });

  it("declares glossary implementation and profile levels out of scope", () => {
    const raw = YAML.parse(fs.readFileSync(PRODUCTION_CONTRACT, "utf8")) as Record<string, unknown>;
    const out = (raw.scope as Record<string, unknown>).out_of_scope as string[];
    expect(out).toEqual(expect.arrayContaining(["Glossary implementation.", "Profile level selection."]));
  });

  it("ties the contract to the current corpus adapter version", () => {
    const raw = YAML.parse(fs.readFileSync(PRODUCTION_CONTRACT, "utf8")) as Record<string, unknown>;
    const required = (raw.tiers as Record<string, unknown>).full_evidence as Record<string, unknown>;
    const stored = (required.stored_fields as Record<string, unknown>).required as string[];
    expect(stored).toContain("adapter_version");
    expect(ADAPTER_VERSION).toBe("agentera-v3-corpus-3");
  });
});
