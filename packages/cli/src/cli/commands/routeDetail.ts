import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { loadCapabilitySchemaContract } from "../../registries/capabilityContract.js";
import { phrasesFrom } from "../../registries/hybridRoute.js";
import { buildCapabilityTriggers, loadTriggerModel } from "../../registries/triggerLoader.js";
import { buildProtocolValueLookup, checkNumberedEntries, checkSchemaPrimitiveReferences, checkStableIds, checkTriggerEnrichment, validateProtocolSelf } from "../../validate/capability.js";
import { guidanceDetail, GuidanceInputError, type GuidanceSection } from "../guidanceDetail.js";
import { emitInvalidInput } from "../errors.js";

export const ROUTE_TOPICS = ["overview", "phrases", "triggers", "receipt", "evaluation"] as const;

/** Discovery is not a route request, receipt submission or evaluation run. */
export function runRouteDetail(argv: string[], io: { out?: (text: string) => void; err?: (text: string) => void }): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    (io.out ?? ((text) => process.stdout.write(text)))(
      "usage: npx -y agentera@next route explain [--topic overview|phrases|triggers|receipt|evaluation] [--capability C] [--section S] [--limit N] [--cursor C] [--format json]\n\nRequest-free static routing discovery. Phrases/triggers accept a canonical capability, including status. Follow exact section and continuation commands for complete contracts. JSON pages are at most 32768 UTF-8 bytes; limit defaults to 20 (1..100). Operational inputs are rejected; no request, receipt, host, evaluation or project state is read or executed.\n",
    );
    return 0;
  }
  let baseCommand = "npx -y agentera@next route explain";
  try {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const [flag, ...inline] = argv[i].split("=");
      if (!["--topic", "--capability", "--section", "--limit", "--cursor", "--format"].includes(flag)) throw new GuidanceInputError("Static routing discovery rejects request, receipt, evaluation and operational inputs.");
      if (flag in args) throw new GuidanceInputError("Repeated routing detail selector.");
      const value = inline.length ? inline.join("=") : argv[++i];
      if (!value || value.startsWith("--")) throw new GuidanceInputError(`Missing value for ${flag}.`);
      args[flag] = value;
    }
    const topic = args["--topic"];
    if (topic !== undefined && !(ROUTE_TOPICS as readonly string[]).includes(topic)) throw new GuidanceInputError("Select an available routing topic.", [...ROUTE_TOPICS]);
    if (args["--section"] && !topic) throw new GuidanceInputError("--section requires --topic.", [...ROUTE_TOPICS]);
    if (args["--capability"] && topic !== "phrases" && topic !== "triggers") throw new GuidanceInputError("--capability is supported only for phrases and triggers.", ["phrases", "triggers"]);
    if (args["--format"] !== undefined && args["--format"] !== "json") throw new GuidanceInputError("Static routing discovery supports JSON only.", ["json"]);
    const limit = args["--limit"] === undefined ? 20 : Number(args["--limit"]);
    if ((args["--limit"] !== undefined && !/^\d+$/.test(args["--limit"])) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GuidanceInputError("--limit must be an integer from 1 to 100.");
    const root = resolveSourceRoot();
    const hash = createHash("sha256");
    const sections: GuidanceSection[] = [];
    const read = (relative: string, notesName?: string): JsonObject => {
      const text = fs.readFileSync(path.join(root, relative), "utf8");
      hash.update(relative).update(text);
      const doc = YAML.parseDocument(text);
      if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML authority.");
      const value = doc.toJS();
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error("Invalid authority mapping.");
      if (notesName) {
        const notes: string[] = [];
        YAML.visit(doc, (_key, node) => {
          if (node && typeof node === "object") {
            if ("commentBefore" in node && typeof node.commentBefore === "string") notes.push(node.commentBefore);
            if ("comment" in node && typeof node.comment === "string") notes.push(node.comment);
          }
        });
        if (doc.commentBefore) notes.unshift(doc.commentBefore);
        if (doc.comment) notes.push(doc.comment);
        if (notes.length)
          sections.push({
            name: notesName,
            content: notes,
            authority: relative,
            classification: "source_commentary_read_with_authority_qualifications",
          });
      }
      return value;
    };
    const add = (name: string, content: unknown, authority: string, classification = "governing_routing_contract") => sections.push({ name, content, authority, classification });
    const routePath = "references/cli/hybrid-route-contract.yaml";
    const route = read(routePath, topic ? "contract_notes" : undefined);
    validateRouteDetailAuthority(route);
    if (!topic) {
      for (const name of ROUTE_TOPICS) add(name, { command: `${baseCommand} --topic ${name}` }, routePath, "topic_discovery");
    } else {
      baseCommand += ` --topic ${topic}`;
      const capability = args["--capability"];
      // The complete normative contract is available in overview; every topic
      // also carries it so qualifications never depend on an external file read.
      add("contract", route, routePath);
      if (topic === "overview") {
        const relative = "references/cli/routing-model.md";
        const text = fs.readFileSync(path.join(root, relative), "utf8");
        if (!text.startsWith("# Hybrid routing model")) throw new Error("Invalid routing model.");
        hash.update(relative).update(text);
        add("model", text, relative, "reader_model_normative_contract_governs");
      }
      if (topic === "phrases" || topic === "triggers" || topic === "overview") {
        const contractPath = "skills/agentera/capability_schema_contract.yaml";
        const contractRaw = read(contractPath);
        const meta = contractRaw.meta as JsonObject;
        if (meta?.name !== "capability_schema_contract" || meta.version !== "1.0.0") throw new Error("Incompatible capability contract metadata.");
        const contract = loadCapabilitySchemaContract(path.join(root, contractPath));
        const capabilities = contract.routeAliases.primaryAliases.map((entry) => entry.capability);
        if (capability && !capabilities.includes(capability)) throw new GuidanceInputError("Select a canonical capability.", capabilities);
        if (capability) baseCommand += ` --capability ${capability}`;
        add("aliases", contractRaw.ROUTE_ALIASES, contractPath);
        if (topic === "phrases") {
          const relative = "skills/agentera/route-phrases.yaml";
          const registry = read(relative, "registry_notes");
          if (registry.schema_version !== "agentera.route_phrase_registry.v1" || registry.status !== "active_authority" || !registry.rules || typeof registry.rules !== "object" || Array.isArray(registry.rules) || typeof registry.normalization !== "string") throw new Error("Invalid phrase registry.");
          phrasesFrom(root, contract);
          const entries = registry.phrases as JsonObject[];
          const ids = new Set<string>();
          for (const entry of entries) {
            if (ids.has(String(entry.id)) || !["active", "deprecated"].includes(String(entry.status))) throw new Error("Invalid phrase identity or status.");
            ids.add(String(entry.id));
            if (entry.status === "deprecated" && !entries.some((replacement) => replacement.id === entry.replaced_by && replacement.status === "active")) throw new Error("Invalid deprecated phrase replacement.");
            if (entry.evidence !== undefined && (!Array.isArray(entry.evidence) || entry.evidence.some((value) => typeof value !== "string" || !value))) throw new Error("Invalid phrase provenance.");
          }
          add(
            "registry",
            {
              ...registry,
              phrases: (registry.phrases as JsonObject[]).filter((entry) => !capability || entry.capability === capability),
            },
            relative,
          );
        }
        if (topic === "triggers") {
          // Reuse the active intent loader (including status); never project these
          // discovery-only fields into the operational semantic capsule or hash.
          const model = capability
            ? {
                capabilities: new Map([[capability, buildCapabilityTriggers(capability, contract, root)]]),
              }
            : loadTriggerModel(contract, { sourceRoot: root });
          const protocolPath = "skills/agentera/protocol.yaml";
          const protocol = read(protocolPath);
          if (validateProtocolSelf(path.join(root, protocolPath)).length) throw new Error("Invalid protocol authority.");
          for (const name of capabilities.filter((name) => !capability || name === capability)) {
            const relative = `skills/agentera/capabilities/${name}/schemas/triggers.yaml`;
            const mapping = read(relative, `${name}_notes`);
            for (const entry of Object.values(mapping.TRIGGERS as JsonObject)) {
              const fallback = (entry as JsonObject).fallback;
              if (fallback !== undefined && typeof fallback !== "boolean") throw new Error("Invalid trigger fallback.");
            }
            if (
              !model.capabilities.get(name)?.triggers.length ||
              checkNumberedEntries(mapping, relative, contract).length ||
              checkStableIds(mapping, relative, contract).length ||
              checkTriggerEnrichment(mapping, relative, contract).length ||
              checkSchemaPrimitiveReferences(mapping, buildProtocolValueLookup(protocol), contract).length
            )
              throw new Error("Invalid trigger authority.");
            add(name, mapping, relative, "semantic_intent_not_executable_matchers");
          }
          const relative = "references/cli/trigger-schema-enrichment.md";
          const text = fs.readFileSync(path.join(root, relative), "utf8");
          if (!text.trim()) throw new Error("Missing trigger enrichment guidance.");
          hash.update(relative).update(text);
          add("intent_guidance", text, relative, "semantic_intent_not_executable_matchers");
        }
      }
    }
    const payload = guidanceDetail({
      command: "route explain",
      baseCommand,
      selection: {
        ...(topic ? { topic } : {}),
        ...(args["--capability"] ? { capability: args["--capability"] } : {}),
      },
      sections,
      section: args["--section"],
      limit,
      cursor: args["--cursor"],
      authorityDigest: hash.digest("hex"),
      qualifications: {
        scope: "Static discovery only. No request is manufactured, read, routed or persisted; no host judgment, evaluation, receipt validation or startup is performed. Read all applicable sections and parts before reliance. Source paths are provenance, not required filesystem actions.",
        topics: ROUTE_TOPICS.map((name) => ({
          name,
          command: `npx -y agentera@next route explain --topic ${name}`,
        })),
        authorization: "Use route request with the original transient request; after semantic_required submit a bound receipt through route receipt. Invalid or stale receipts authorize no startup. Static discovery does not grant project, host or consent permissions.",
        recovery: "For stale receipt bindings, rerun route request on the same original input and obtain a new host judgment against the returned capsule; never patch a digest onto an old judgment.",
      },
    });
    if (!topic)
      payload.items = payload.items.map((item) => {
        const entry = item as { name: string; content: unknown };
        return {
          ...entry,
          content: {
            detail_command: `npx -y agentera@next route explain --topic ${entry.name} --limit ${limit}`,
          },
        };
      });
    (io.out ?? ((text) => process.stdout.write(text)))(JSON.stringify(payload) + "\n");
    return 0;
  } catch (error) {
    const input = error instanceof GuidanceInputError;
    return emitInvalidInput(io, {
      format: "json",
      exitCode: input ? 64 : 1,
      body: {
        class: input ? "invalid_choice" : "schema_violation",
        message: input ? error.message : "Selected runtime routing authority is missing, incompatible or corrupt; repair the selected runtime data before retrying.",
        valid_values: input ? error.validValues.slice(0, 20) : [],
        syntax: "agentera route explain [--topic overview|phrases|triggers|receipt|evaluation] [--capability C] [--section S] [--limit 1..100] [--cursor CURSOR] [--format json]",
        example: baseCommand,
        recovery: input ? (error.recovery ?? baseCommand) : baseCommand,
      },
    });
  }
}

/** Validate governing structure, not just the selected leaf's presentation. */
function validateRouteDetailAuthority(route: JsonObject): void {
  if (route.schema_version !== "agentera.hybrid_route_contract.v3" || route.status !== "normative") throw new Error("Incompatible route authority.");
  const mapping = (value: unknown): JsonObject => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error("Invalid route contract mapping.");
    return value as JsonObject;
  };
  for (const name of ["ownership", "protocol", "receipt_semantics", "phrase_matching", "compound_intent", "evaluation"]) mapping(route[name]);
  if (!Array.isArray(route.precedence) || route.precedence.length !== 5) throw new Error("Invalid routing precedence.");
  for (const [i, entry] of route.precedence.entries()) if (mapping(entry).order !== i + 1 || typeof mapping(entry).name !== "string") throw new Error("Invalid routing precedence entry.");
  const protocol = mapping(route.protocol);
  for (const name of ["request", "response", "receipt", "validation_result"]) mapping(protocol[name]);
  if (mapping(protocol.request).version !== "agentera.route_request.v1" || mapping(protocol.response).version !== "agentera.route_response.v1") throw new Error("Incompatible route protocol version.");
  const receipt = mapping(protocol.receipt);
  if (receipt.version !== "agentera.route_receipt.v1") throw new Error("Incompatible receipt version.");
  const cliSeam = mapping(receipt.cli_seam);
  for (const name of ["command", "input", "output"]) if (typeof cliSeam[name] !== "string" || !cliSeam[name].trim()) throw new Error("Invalid receipt CLI seam field.");
  const exitCodes = mapping(cliSeam.exit_codes);
  if (exitCodes.ok !== 0 || exitCodes.invalid_input !== 2 || exitCodes.invalid_receipt !== 64) throw new Error("Incompatible receipt CLI seam exit codes.");
  const authority = mapping(receipt.validation_authority);
  if (authority.name !== "agentera.route_receipt_schema.v1" || authority.dialect !== "json_schema_draft_2020_12") throw new Error("Incompatible receipt schema authority.");
  const host = mapping(authority.host_output_shape);
  const schema = mapping(host.schema);
  if (schema.type !== "object" || schema.additionalProperties !== false || !Array.isArray(schema.required)) throw new Error("Invalid nullable receipt schema.");
  const properties = mapping(schema.properties);
  for (const name of schema.required) if (typeof name !== "string" || !properties[name]) throw new Error("Incomplete nullable receipt schema.");
  // Check structure of both complete executable schemas, including conditional
  // clauses and nested spans. This does not evaluate any receipt or run a host.
  const schemaStructure = (value: unknown): void => {
    const node = mapping(value);
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.some((type) => typeof type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) throw new Error("Invalid receipt schema type.");
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || !node.required.length || node.required.some((key) => typeof key !== "string"))) throw new Error("Invalid receipt required fields.");
    if (node.properties !== undefined) for (const child of Object.values(mapping(node.properties))) schemaStructure(child);
    for (const key of ["allOf", "anyOf", "oneOf"])
      if (node[key] !== undefined) {
        if (!Array.isArray(node[key]) || !node[key].length) throw new Error("Invalid receipt schema clauses.");
        for (const child of node[key]) schemaStructure(child);
      }
    for (const key of ["if", "then", "else", "not", "items"]) if (node[key] !== undefined) schemaStructure(node[key]);
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) throw new Error("Invalid receipt enum.");
    for (const key of ["minLength", "maxLength", "minimum"]) if (node[key] !== undefined && (typeof node[key] !== "number" || !Number.isFinite(node[key]) || node[key] < 0)) throw new Error("Invalid receipt constraint.");
    if (node.pattern !== undefined) {
      if (typeof node.pattern !== "string" || !node.pattern) throw new Error("Invalid receipt pattern.");
      new RegExp(node.pattern, "u");
    }
  };
  schemaStructure(schema);
  schemaStructure(authority.schema);
  const normalization = mapping(authority.host_to_cli_normalization);
  const rules = mapping(mapping(normalization.projection).outcome_rules);
  for (const outcome of ["select", "clarify", "no_match"]) {
    const rule = mapping(rules[outcome]);
    if (!Array.isArray(rule.required_non_null)) throw new Error("Invalid receipt outcome rule.");
    mapping(rule.removable_nulls);
    mapping(mapping(route.receipt_semantics)[outcome]);
  }
  mapping(authority.request_bound_fields);
  const discovery = mapping(mapping(mapping(protocol.response).semantic_required).receipt_contract);
  if (discovery.schema_version !== "agentera.route_receipt_contract.v1") throw new Error("Incompatible receipt discovery version.");
  schemaStructure(discovery.input_schema);
  mapping(discovery.stdin_example);
  mapping(mapping(route.compound_intent).semantic);
  mapping(mapping(route.evaluation).target_gates);
}
