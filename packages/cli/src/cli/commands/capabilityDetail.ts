import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { CAPABILITY_INSTRUCTIONS, capabilityInstructionModulePath } from "../../capabilities/index.js";
import { planStartupContract } from "../capabilityContext/contract.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { loadCapabilitySchemaContract } from "../../registries/capabilityContract.js";
import { ARTIFACT_PROTOCOL_PATHS } from "../../registries/artifactProtocolIds.js";
import { workerSections } from "./workerDetail.js";
import { buildProtocolValueLookup, checkNumberedEntries, checkSchemaPrimitiveReferences, checkStableIds, validateProtocolSelf } from "../../validate/capability.js";
import { emitInvalidInput } from "../errors.js";
import { guidanceDetail, GuidanceInputError, guidanceQuote, type GuidanceSection } from "../guidanceDetail.js";

export const CAPABILITY_DETAILS = ["instructions", "artifacts", "validation", "exit", "worker"] as const;
export function isCapabilityDetailQuery(argv: string[]): boolean {
  return argv.some((arg) => ["--detail", "--section", "--limit", "--cursor"].includes(arg.split("=")[0]));
}

/** Static execution semantics only. No app, project, profile or history readers. */
export function runCapabilityDetail(argv: string[], io: { out?: (text: string) => void; err?: (text: string) => void }): number {
  let baseCommand = "npx -y agentera@next prime --help";
  try {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const [flag, ...inline] = argv[i].split("=");
      if (!["--context", "--detail", "--section", "--limit", "--cursor", "--format"].includes(flag)) throw new GuidanceInputError("Static capability detail rejects startup inputs, filters, aliases and operational arguments.");
      if (flag in args) throw new GuidanceInputError("Repeated static capability selector.");
      const value = inline.length ? inline.join("=") : argv[++i];
      if (!value || value.startsWith("--")) throw new GuidanceInputError(`Missing value for ${flag}.`);
      args[flag] = value;
    }
    const capability = args["--context"];
    if (!Object.hasOwn(CAPABILITY_INSTRUCTIONS, capability ?? "")) throw new GuidanceInputError("Select a supported --context for static detail.", Object.keys(CAPABILITY_INSTRUCTIONS));
    baseCommand = `npx -y agentera@next prime --context ${capability} --detail instructions`;
    const detail = args["--detail"];
    if (!(CAPABILITY_DETAILS as readonly string[]).includes(detail)) throw new GuidanceInputError("Select an available --detail.", [...CAPABILITY_DETAILS]);
    baseCommand = `npx -y agentera@next prime --context ${capability} --detail ${detail}`;
    if (args["--format"] !== undefined && args["--format"] !== "json") throw new GuidanceInputError("Static capability detail supports JSON only.", ["json"]);
    const limit = args["--limit"] === undefined ? 20 : Number(args["--limit"]);
    if ((args["--limit"] !== undefined && !/^\d+$/.test(args["--limit"])) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GuidanceInputError("--limit must be an integer from 1 to 100.");
    const root = resolveSourceRoot();
    const hash = createHash("sha256");
    const sections: GuidanceSection[] = [];
    const read = (relative: string) => {
      const text = fs.readFileSync(path.join(root, relative), "utf8");
      hash.update(relative).update(text);
      const doc = YAML.parseDocument(text);
      if (doc.errors.length || doc.warnings.length) throw new Error("Invalid authority YAML.");
      const mapping = doc.toJS() as JsonObject;
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || !Object.keys(mapping).length) throw new Error("Invalid authority mapping.");
      return { doc, mapping };
    };
    const protocolPath = "skills/agentera/protocol.yaml";
    const { mapping: protocol } = read(protocolPath);
    const protocolMeta = protocol.meta as JsonObject | undefined;
    if (protocolMeta?.name !== "protocol" || protocolMeta.version !== "1.0.0") throw new Error("Incompatible protocol metadata.");
    if (validateProtocolSelf(path.join(root, protocolPath)).length) throw new Error("Invalid protocol authority.");
    const contractPath = "skills/agentera/capability_schema_contract.yaml";
    const { mapping: contractMapping } = read(contractPath);
    const contractMeta = contractMapping.meta as JsonObject | undefined;
    if (contractMeta?.name !== "capability_schema_contract" || contractMeta.version !== "1.0.0") throw new Error("Incompatible capability contract metadata.");
    const contract = loadCapabilitySchemaContract(path.join(root, contractPath));
    if (detail === "instructions") {
      const content = CAPABILITY_INSTRUCTIONS[capability];
      if (!content) throw new Error("Missing compiled instructions.");
      hash.update(content);
      sections.push({
        name: "instructions",
        content,
        authority: capabilityInstructionModulePath(capability),
        classification: "compiled_execution_instructions",
      });
      if (capability === "plan") {
        const content = planStartupContract();
        hash.update(JSON.stringify(content));
        sections.push({
          name: "startup_contract",
          content,
          authority: "packages/cli/src/cli/capabilityContext/contract.ts#planStartupContract",
          classification: "governing_execution_contract",
        });
      }
    } else if (detail === "worker") {
      hash.update(CAPABILITY_INSTRUCTIONS[capability]);
      sections.push(...workerSections(capability, root, (relative) => read(relative).mapping));
    } else {
      const relative = `skills/agentera/capabilities/${capability}/schemas/${detail}.yaml`;
      const { doc, mapping } = read(relative);
      const group = detail === "exit" ? "EXIT_CONDITIONS" : detail.toUpperCase();
      if (!mapping[group] || typeof mapping[group] !== "object" || Array.isArray(mapping[group]) || !Object.keys(mapping[group]).length || checkNumberedEntries(mapping, relative, contract).length || checkStableIds(mapping, relative, contract).length) throw new Error("Invalid capability authority.");
      if (checkSchemaPrimitiveReferences(mapping, buildProtocolValueLookup(protocol), contract).length) throw new Error("Invalid capability primitive reference.");
      for (const [name, content] of Object.entries(mapping))
        sections.push({
          name,
          content,
          authority: relative,
          classification: "governing_execution_contract",
        });
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
          name: "source_notes",
          content: notes,
          authority: relative,
          classification: "source_commentary_read_with_authority_qualifications",
        });
      if (detail === "artifacts") {
        sections.push({
          name: "construction",
          content: Object.values(mapping.ARTIFACTS as Record<string, JsonObject>).map((entry) => ({
            artifact: entry.artifact,
            command: Object.hasOwn(ARTIFACT_PROTOCOL_PATHS, String(entry.artifact)) ? `npx -y agentera@next schema --artifact ${entry.artifact}` : `npx -y agentera@next prime --context ${entry.artifact === "profile" ? "profile" : capability} --detail instructions`,
          })),
          authority: relative,
          classification: "related_contract_actions_not_write_permission",
        });
      }
    }
    sections.push({
      name: "protocol",
      content: Object.keys(protocol).map((name) => ({
        name,
        command: `npx -y agentera@next schema --protocol --section ${guidanceQuote(name)}`,
      })),
      authority: protocolPath,
      classification: "required_shared_meanings",
    });
    const payload = guidanceDetail({
      command: "prime",
      baseCommand,
      selection: { context: capability, detail },
      sections,
      section: args["--section"],
      limit,
      cursor: args["--cursor"],
      authorityDigest: hash.digest("hex"),
      qualifications: {
        scope: "Static semantics only, not capability startup, project readiness, execution eligibility or read/write permission. Read all applicable sections and lossless parts before acting. Canonical CLI authorities supersede stale installed copies; source paths are provenance, not required file reads.",
        state_authority: "Typed entity readers/writers govern current state; aggregate paths and shapes in historical prose are migration or explicitly declared atomic-create inputs, not permission for direct entity edits. Singleton ownership and explicit consent remain binding.",
        related_commands: CAPABILITY_DETAILS.filter((value) => value !== detail).map((value) => `npx -y agentera@next prime --context ${capability} --detail ${value}`),
        first_invocation: `npx -y agentera@next prime --context ${capability}`,
        instruction_contract: "npx -y agentera@next schema --capability-contract --section instructions",
        worker: {
          status: "available",
          command: `npx -y agentera@next prime --context ${capability} --detail worker`,
        },
      },
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
        message: input ? error.message : "Selected runtime capability authority is missing, incompatible or corrupt; repair the selected runtime data before retrying.",
        valid_values: input ? error.validValues.slice(0, 20) : [],
        syntax: "agentera prime --context C --detail instructions|artifacts|validation|exit|worker [--section S] [--limit 1..100] [--cursor CURSOR] [--format json]",
        example: baseCommand,
        recovery: input ? (error.recovery ?? baseCommand) : baseCommand,
      },
    });
  }
}
