import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadReadOnlyYamlAuthorityFile, withReadOnlyYamlMappingCache } from "../../core/yaml.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { ARTIFACT_PROTOCOL_PATHS } from "../../registries/artifactProtocolIds.js";
import { validateContractBootstrap } from "../../registries/capabilityContract.js";
import { validateProtocolSelf } from "../../validate/capability.js";
import { validateGlossaryEntryContract } from "../../registries/glossaryEntryContract.js";
import { validateEvidenceTierContract } from "../../registries/evidenceTierContract.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { emitInvalidInput } from "../errors.js";
import { guidanceDetail, GuidanceInputError, guidanceQuote, type GuidanceSection } from "../guidanceDetail.js";

const PREFIX = "npx -y agentera@next schema";
export function isSchemaDetailQuery(argv: string[]): boolean {
  return argv.some((arg) => ["--artifact", "--protocol", "--capability-contract", "--section", "--limit", "--cursor"].includes(arg.split("=")[0]));
}
export const schemaDetailDiscovery = () => ({
  artifacts: Object.keys(ARTIFACT_PROTOCOL_PATHS).map((artifact) => ({
    artifact,
    command: `${PREFIX} --artifact ${artifact}`,
  })),
  protocol: `${PREFIX} --protocol`,
  capability_contract: `${PREFIX} --capability-contract`,
  static: true,
  requires_project: false,
  format: "json",
  max_utf8_bytes: 32_768,
  limit: { default: 20, min: 1, max: 100 },
});

/** Selected static branch: only shipped contract data, never app/home/project readers. */
export function runSchemaDetail(argv: string[], io: { out?: (text: string) => void; err?: (text: string) => void }): number {
  return withReadOnlyYamlMappingCache(() => runSchemaDetailRequest(argv, io));
}

function runSchemaDetailRequest(argv: string[], io: { out?: (text: string) => void; err?: (text: string) => void }): number {
  let baseCommand = PREFIX;
  try {
    const args: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
      const [flag, ...inline] = argv[i].split("=");
      const key = flag.slice(2);
      if (!["artifact", "protocol", "capability-contract", "section", "limit", "cursor", "format"].includes(key) || !flag.startsWith("--")) throw new GuidanceInputError("Unrecognized static schema argument.");
      if (key in args) throw new GuidanceInputError("Repeated static schema selector.");
      if (key === "protocol" || key === "capability-contract") {
        if (inline.length) throw new GuidanceInputError("Boolean selectors do not accept a value.");
        args[key] = true;
      } else {
        const value = inline.length ? inline.join("=") : argv[++i];
        if (!value || value.startsWith("--")) throw new GuidanceInputError(`Missing value for ${flag}.`);
        args[key] = value;
      }
    }
    const owners = ["artifact", "protocol", "capability-contract"].filter((key) => key in args);
    if (owners.length !== 1) throw new GuidanceInputError("Select exactly one of --artifact, --protocol, --capability-contract.", ["--artifact", "--protocol", "--capability-contract"]);
    const owner = owners[0];
    if (owner === "artifact" && !Object.hasOwn(ARTIFACT_PROTOCOL_PATHS, String(args.artifact))) throw new GuidanceInputError("Unknown artifact; use an advertised artifact identity, not a path.", Object.keys(ARTIFACT_PROTOCOL_PATHS));
    baseCommand = `${PREFIX} --${owner}${owner === "artifact" ? ` ${guidanceQuote(String(args.artifact))}` : ""}`;
    if (args.format !== undefined && args.format !== "json") throw new GuidanceInputError("Static schema detail supports JSON only.", ["json"]);
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    if ((args.limit !== undefined && !/^[0-9]+$/.test(String(args.limit))) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GuidanceInputError("--limit must be an integer from 1 to 100.");
    const root = resolveSourceRoot();
    const sections: GuidanceSection[] = [];
    const qualifications: Record<string, unknown> = {
      scope: "Static contract knowledge is not project readiness or write authorization. Read governing qualifications and all indicated sections/parts before acting; provenance paths are not filesystem instructions.",
      related_commands: [`${PREFIX} --protocol`, `${PREFIX} --capability-contract`, PREFIX],
    };
    const hash = createHash("sha256");
    const add = (relative: string, namespace?: string) => {
      if (!relative.endsWith(".yaml")) {
        const text = fs.readFileSync(path.join(root, relative), "utf8");
        hash.update(relative).update(text);
        sections.push({
          name: namespace!,
          content: text,
          authority: relative,
          classification: "authoring_guidance",
        });
        return;
      }
      const { text, value: content, comments: authorityComments } = loadReadOnlyYamlAuthorityFile(path.join(root, relative));
      hash.update(relative).update(text);
      const mapping = content as JsonObject;
      if (!namespace) {
        const meta = mapping.meta as JsonObject | undefined;
        const expected = owner === "artifact" ? args.artifact : owner === "protocol" ? "protocol" : "capability_schema_contract";
        if (meta?.name !== expected || meta.version !== "1.0.0") throw new Error("Incompatible selected authority metadata.");
        if (Object.keys(mapping).filter((key) => key !== "meta").length < 2) throw new Error("Incomplete selected authority.");
        qualifications.source_meta = meta;
        if (mapping.ENTITY_AUTHORITY) qualifications.entity_authority = mapping.ENTITY_AUTHORITY;
        if (owner === "capability-contract" && validateContractBootstrap(mapping, "selected authority").length) throw new Error("Invalid capability contract.");
      }
      const comments: Array<{ section: string | null; placement: string; text: string }> = [];
      if (namespace === "storage") {
        qualifications.storage_authority = mapping.authority;
        qualifications.storage_command = `${baseCommand} --section storage`;
        const grammar = mapping.mutation_grammar as JsonObject;
        if (!Array.isArray(grammar?.operations)) throw new Error("Invalid storage mutation grammar.");
        const operations = (grammar.operations as JsonObject[]).filter((operation) => operation.artifact === args.artifact);
        const explain = operations.length ? `npx -y agentera@next state ${args.artifact} explain` : null;
        sections.push({
          name: "writing",
          authority: `${relative}#mutation_grammar`,
          classification: "current_writer_discovery",
          content: {
            explain_command: explain,
            explain_by_verb: Object.fromEntries(operations.map((operation) => [String(operation.verb), `${explain} --verb ${operation.verb}`])),
            note: "No typed writer is implied when explain_command is null; follow the artifact's capability ownership. These commands explain operations, not grant execution permission.",
          },
        });
        qualifications.writing_command = `${baseCommand} --section writing`;
      }
      for (const comment of authorityComments) {
        const keys = comment.path.map((key) => encodeURIComponent(key).replaceAll(".", "%2E"));
        if (namespace) keys.unshift(namespace);
        comments.push({ section: keys.join(".") || null, placement: comment.placement, text: comment.text });
      }
      if (namespace)
        sections.push({
          name: namespace,
          content,
          authority: relative,
          classification: "governing_reference",
        });
      else
        for (const [name, value] of Object.entries(mapping))
          sections.push({
            name,
            content: value,
            authority: relative,
            classification: name === "meta" ? "metadata_with_authority_qualifications" : "governing_contract",
          });
      if (comments.length)
        sections.push({
          name: namespace ? `${namespace}_notes` : "source_notes",
          content: comments,
          authority: relative,
          classification: "source_commentary_read_with_authority_qualifications",
        });
    };
    if (owner === "artifact") {
      add(`skills/agentera/schemas/artifacts/${args.artifact}.yaml`);
      add("references/artifacts/state-storage-authority.yaml", "storage");
      add("references/artifacts/artifact-registry-interface-model.yaml", "registry");
      add("references/artifacts/verbosity-budget-authority.yaml", "budgets");
      if (args.artifact === "glossary") {
        if (validateGlossaryEntryContract(path.join(root, "references/artifacts/glossary-entry-contract.yaml")).length || validateEvidenceTierContract(path.join(root, "references/analysis/evidence-tier-authority.yaml")).length || validateProtocolSelf(path.join(root, "skills/agentera/protocol.yaml")).length)
          throw new Error("Invalid glossary governance.");
        add("references/artifacts/glossary-entry-contract.yaml", "entry");
        add("references/analysis/evidence-tier-authority.yaml", "evidence");
        qualifications.construction_commands = ["npx -y agentera@next schema --protocol --section CONFIDENCE_SCALE", "npx -y agentera@next prime --context profile --detail instructions", "npx -y agentera@next report explain", "npx -y agentera@next state glossary explain --verb publish"];
      }
    } else if (owner === "protocol") {
      if (validateProtocolSelf(path.join(root, "skills/agentera/protocol.yaml")).length) throw new Error("Invalid protocol.");
      add("skills/agentera/protocol.yaml");
    } else {
      add("skills/agentera/capability_schema_contract.yaml");
      add("references/cli/capability-instruction-contract.yaml", "instructions");
      add("references/cli/hybrid-route-contract.yaml", "routing");
      add("references/cli/routing-model.md", "routing_meanings");
      add("references/cli/trigger-schema-enrichment.md", "trigger_authoring");
      add("references/cli/vocabulary.md", "vocabulary");
      add("references/cli/vocabulary-index.yaml", "vocabulary_index");
      add("references/cli/app-lifecycle-vocabulary.yaml", "lifecycle_vocabulary");
      add("references/cli/update-channels.yaml", "channels");
    }
    if (sections.some((section) => section.name === "source_notes")) qualifications.source_notes_command = `${baseCommand} --section source_notes`;
    const payload = guidanceDetail({
      qualifications,
      baseCommand,
      selection: { [owner]: args[owner] },
      sections,
      section: args.section as string | undefined,
      limit,
      cursor: args.cursor as string | undefined,
      authorityDigest: hash.digest("hex"),
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
        message: input ? error.message : "Selected runtime contract is missing, incompatible or corrupt; repair the selected runtime data before retrying.",
        valid_values: input ? error.validValues.slice(0, 20) : [],
        syntax: "agentera schema (--artifact A | --protocol | --capability-contract) [--section S] [--limit 1..100] [--cursor CURSOR] [--format json]",
        example: `${PREFIX} --protocol`,
        recovery: input ? (error.recovery ?? baseCommand) : baseCommand,
      },
    });
  }
}
