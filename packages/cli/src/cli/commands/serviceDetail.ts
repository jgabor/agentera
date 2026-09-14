import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { withReadOnlyYamlMappingCache } from "../../core/yaml.js";
import { guidanceDetail, guidanceQuote, GuidanceInputError, type GuidanceSection } from "../guidanceDetail.js";
import { emitInvalidInput } from "../errors.js";
import { reportDetailSections } from "./reportDetail.js";
import { checkDetailSections } from "./checkDetail.js";
import { recoveryDetailSections } from "./recoveryDetail.js";

import type { ServiceOwner } from "./serviceDetailQuery.js";

/** Only owner-selected shipped authorities can be read; callers cannot supply paths. */
export class ServiceAuthority {
  readonly root = resolveSourceRoot();
  readonly sections: GuidanceSection[] = [];
  private readonly hash = createHash("sha256");
  bind(relative: string): string {
    const text = fs.readFileSync(path.join(this.root, relative), "utf8");
    this.hash.update(relative).update(text);
    return text;
  }
  add(name: string, content: unknown, authority: string, classification = "governing_contract") {
    this.hash.update(JSON.stringify([name, content, authority]));
    this.sections.push({ name, content, authority, classification });
  }
  yaml(relative: string, name: string, validate: (value: Record<string, unknown>, absolute: string) => void) {
    const absolute = path.join(this.root, relative);
    const text = fs.readFileSync(absolute, "utf8");
    const doc = YAML.parseDocument(text);
    const value = doc.toJS();
    if (doc.errors.length || doc.warnings.length || !value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error("Invalid runtime authority.");
    validate(value, absolute);
    this.hash.update(relative).update(text);
    this.add(name, value, relative);
    const comments: string[] = [];
    YAML.visit(doc, (_key, node) => {
      if (node && typeof node === "object") {
        if ("commentBefore" in node && typeof node.commentBefore === "string") comments.push(node.commentBefore);
        if ("comment" in node && typeof node.comment === "string") comments.push(node.comment);
      }
    });
    if (doc.commentBefore) comments.unshift(doc.commentBefore);
    if (doc.comment) comments.push(doc.comment);
    if (comments.length) this.add(`${name}_notes`, comments, relative, "source_commentary_read_with_authority");
    return value;
  }
  digest() {
    return this.hash.digest("hex");
  }
}
export function requireValid(errors: readonly string[]) {
  if (errors.length) throw new Error("Invalid selected runtime governance.");
}
export function operationIndex(authority: ServiceAuthority, base: string, operations: readonly string[]) {
  authority.add(
    "operations",
    operations.map((operation) => ({
      operation,
      command: `${base} --operation ${guidanceQuote(operation)}`,
    })),
    "CLI operation dispatch",
    "operation_navigation",
  );
}

export function runServiceDetail(owner: ServiceOwner, argv: string[], io: { out?: (text: string) => void; err?: (text: string) => void }): number {
  // Validators share immutable mappings within this request. The next command
  // must read its selected authorities again, including after a failed request.
  return withReadOnlyYamlMappingCache(() => runServiceDetailRequest(owner, argv, io));
}

function runServiceDetailRequest(owner: ServiceOwner, argv: string[], io: { out?: (text: string) => void; err?: (text: string) => void }): number {
  let base = `npx -y agentera@next ${owner} ${owner === "report" || owner === "check" ? "explain" : "--explain"}`;
  const syntax = `${base}${owner === "doctor" || owner === "app-home" ? "" : " [--operation OP]"}${owner === "check" ? " [--target T]" : ""} [--section S] [--limit 1..100] [--cursor C] [--format json]`;
  if (argv.includes("--help") || argv.includes("-h")) {
    (io.out ?? ((text) => process.stdout.write(text)))(`${syntax}\nStatic guidance only: no project, profile, history, host or registry mutation; no checks are executed. Follow sections and continuation commands before acting.\n`);
    return 0;
  }
  try {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const [flag, ...inline] = argv[i].split("=");
      if (!["--operation", "--target", "--section", "--limit", "--cursor", "--format"].includes(flag)) throw new GuidanceInputError("Static explanation rejects operational inputs and approval flags.");
      if (flag in args) throw new GuidanceInputError("Repeated detail selector.");
      const value = inline.length ? inline.join("=") : argv[++i];
      if (!value || value.startsWith("--")) throw new GuidanceInputError(`Missing value for ${flag}.`);
      args[flag] = value;
    }
    if (args["--format"] && args["--format"] !== "json") throw new GuidanceInputError("Static explanation supports JSON only.", ["json"]);
    const limit = args["--limit"] === undefined ? 20 : Number(args["--limit"]);
    if ((args["--limit"] !== undefined && !/^\d+$/.test(args["--limit"])) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GuidanceInputError("--limit must be an integer from 1 to 100.");
    const operation = args["--operation"],
      target = args["--target"];
    if (target !== undefined && (owner !== "check" || !operation)) throw new GuidanceInputError("--target requires a check operation that advertises targets.");
    if (["doctor", "app-home"].includes(owner) && operation !== undefined) throw new GuidanceInputError("This diagnostic has no operation selector.");
    if (args["--section"] && !operation && !["doctor", "app-home"].includes(owner) && args["--section"] !== "operations") throw new GuidanceInputError("Select an operation before its semantic section.");
    const authority = new ServiceAuthority();
    if (owner === "report") reportDetailSections(authority, base, operation);
    else if (owner === "check") checkDetailSections(authority, base, operation, target);
    else recoveryDetailSections(authority, base, owner, operation);
    if (operation) base += ` --operation ${guidanceQuote(operation)}`;
    if (target) base += ` --target ${guidanceQuote(target)}`;
    const payload = guidanceDetail({
      command: `${owner} explain`,
      baseCommand: base,
      selection: { owner, ...(operation ? { operation } : {}), ...(target ? { target } : {}) },
      sections: authority.sections,
      section: args["--section"],
      limit,
      cursor: args["--cursor"],
      authorityDigest: authority.digest(),
      qualifications: {
        static: true,
        requires_project: false,
        effects: "none",
        privacy: "No project, profile, history, review store or host configuration is opened. Authority attribution is provenance, not an instruction to read an installed file.",
        completeness: "Read all applicable sections and continuation parts before effects; discovery is not consent or readiness.",
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
        message: input ? error.message : "Selected runtime authority is missing, incompatible or corrupt; repair the selected runtime data and retry. No state was changed.",
        valid_values: input ? error.validValues.slice(0, 20) : [],
        syntax,
        example: base,
        recovery: base,
      },
    });
  }
}
