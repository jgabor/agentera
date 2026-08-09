import fs from "node:fs";
import path from "node:path";

import { CANONICAL_DEVELOPMENT_CLI } from "./developmentChannel.js";
import {
  ENTITY_LIST_RUNTIME_FAMILIES,
  type EntityListRuntimeFamilyKey,
} from "../state/entityListRuntimeRegistry.js";
import {
  runtimeOperationSpec,
  runtimeOperationSpecs,
  type RuntimeOperationField,
  type RuntimeOperationProjectionTemplate,
  type RuntimeOperationSpec,
} from "../state/write/runtimeOperations.js";

export const CANONICAL_DEVELOPMENT_INVOCATION = CANONICAL_DEVELOPMENT_CLI;
const LOCAL_RUNTIME_INVOCATION = "agentera";

interface CommandWord {
  value: string;
}

export type DevelopmentInvocationRejection =
  | "invalid_authority"
  | "malformed"
  | "not_exact"
  | "wrong_channel";

export class DevelopmentInvocationError extends Error {
  readonly classification: DevelopmentInvocationRejection;

  constructor(classification: DevelopmentInvocationRejection, reason: string) {
    super(`development invocation rejected [${classification}]: ${reason}`);
    this.name = "DevelopmentInvocationError";
    this.classification = classification;
  }
}

export interface DevelopmentInvocationIdentity {
  owner: string;
  source: string;
}

export interface BoundDevelopmentInvocation {
  owner: string;
  source: string;
  argv: readonly string[];
}

export const DEVELOPMENT_RUNTIME_REQUIRED_FILES = Object.freeze([
  "package.json",
  "README.md",
  "LICENSE",
  "dist/bin/agentera.js",
  "bundle/.agentera-npx-bundle.json",
  "bundle/registry.json",
  "bundle/skills/agentera/SKILL.md",
  "bundle/references/adapters/package-registry.yaml",
] as const);

export const DEVELOPMENT_CHILD_ENV_ALLOWLIST = Object.freeze([
  "AGENTERA_BOOTSTRAP_SOURCE_ROOT",
  "AGENTERA_HOME",
  "AGENTERA_UPDATE_CHANNEL",
  "DO_NOT_TRACK",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const);

export const DEVELOPMENT_CHILD_PATH = process.platform === "win32"
  ? path.dirname(process.execPath)
  : "/usr/bin:/bin";

export type EntityProjectionField = "list" | "get" | "example" | "bareRecovery";

function developmentCommand(argumentsText: string): string {
  return `${CANONICAL_DEVELOPMENT_INVOCATION} ${argumentsText}`;
}

const profileGroundingCommand = developmentCommand("report profile-grounding --format json");
const GLOSSARY_PROJECTIONS = {
  "profile_output.command": developmentCommand("report personal-glossary-publish"),
  "profile_grounding.command": profileGroundingCommand,
  "profile_grounding.repair": `Use the Profile capability to repair or regenerate PROFILE.md, then retry \`${profileGroundingCommand}\`; no profile bytes were changed.`,
  "profile_grounding.absent": `Use the Profile capability to generate PROFILE.md, then retry ${profileGroundingCommand}.`,
  "advice.command": developmentCommand("report glossary-advice --input REQUEST --format json"),
  "candidate_retrieval.command": developmentCommand("report personal-glossary-candidates"),
  "candidate_decision.command": developmentCommand("report personal-glossary-decision"),
  "review_records.command": developmentCommand("report personal-glossary-reviews"),
} as const;

export type GlossaryProjectionOwner = keyof typeof GLOSSARY_PROJECTIONS;

export interface DevelopmentProjectionOwner {
  owner: string;
  family: "mutation" | "retrieval" | "glossary";
  source: string;
  runtime: string;
  consumers: readonly string[];
}

function invalid(reason: string): never {
  throw new Error(`invalid development command projection: ${reason}`);
}

function runtimeValue(source: string): string {
  return source.split(CANONICAL_DEVELOPMENT_INVOCATION).join(LOCAL_RUNTIME_INVOCATION);
}

function assertExact(value: unknown, owner: string, source: string): string {
  if (typeof value !== "string" || value !== source)
    invalid(`'${owner}' does not match its code-owned exact source value`);
  return runtimeValue(source);
}

function commandWords(command: string): CommandWord[] {
  const words: CommandWord[] = [];
  let value = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        started = true;
        continue;
      }
      if (quote === '"' && character === "\\") {
        const escaped = command[++index];
        if (escaped === undefined) invalid("trailing escape");
        if (escaped === "\n" || escaped === "\r") invalid("shell continuation is not allowed");
        value += escaped;
        started = true;
        continue;
      }
      if (quote === '"' && (character === "`" || (character === "$" && command[index + 1] === "(")))
        invalid("command substitution is not allowed");
      value += character;
      started = true;
      continue;
    }
    if (character === "\n" || character === "\r")
      invalid("line separators are allowed only inside one quoted argument");
    if (/\s/u.test(character)) {
      if (started) {
        words.push({ value });
        value = "";
        started = false;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      const escaped = command[++index];
      if (escaped === undefined) invalid("trailing escape");
      if (escaped === "\n" || escaped === "\r") invalid("shell continuation is not allowed");
      value += escaped;
      started = true;
      continue;
    }
    if (";&|<>()`".includes(character) || (character === "$" && command[index + 1] === "("))
      invalid("composition, redirection, substitution, and grouping are not allowed");
    value += character;
    started = true;
  }
  if (quote) invalid("unclosed quote");
  if (started) words.push({ value });
  return words;
}

function parsedDevelopmentWords(command: string, classification: DevelopmentInvocationRejection): string[] {
  try {
    return commandWords(command).map(({ value }) => value);
  } catch (error) {
    throw new DevelopmentInvocationError(
      classification,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function hasDevelopmentPrefix(words: readonly string[]): boolean {
  return words[0] === "npx" && words[1] === "-y" && words[2] === "agentera@next";
}

/**
 * Bind an untrusted command specification to one exact code-owned development
 * command before a caller crosses a process boundary. The returned argv omits
 * npx and the package selector because callers execute a verified local bin.
 */
export function bindDevelopmentInvocation(
  identity: DevelopmentInvocationIdentity,
  candidate: string,
): BoundDevelopmentInvocation {
  if (!/^[a-z0-9][a-z0-9_.:-]*$/u.test(identity.owner)) {
    throw new DevelopmentInvocationError("invalid_authority", "owner is not a canonical identity");
  }
  const authorityWords = parsedDevelopmentWords(identity.source, "invalid_authority");
  if (!hasDevelopmentPrefix(authorityWords) || authorityWords.length === 3) {
    throw new DevelopmentInvocationError(
      "invalid_authority",
      `authority must be one complete ${CANONICAL_DEVELOPMENT_INVOCATION} command`,
    );
  }
  const candidateWords = parsedDevelopmentWords(candidate, "malformed");
  if (!hasDevelopmentPrefix(candidateWords)) {
    throw new DevelopmentInvocationError(
      "wrong_channel",
      `command must begin with the exact ${CANONICAL_DEVELOPMENT_INVOCATION} argv`,
    );
  }
  if (candidate !== identity.source) {
    throw new DevelopmentInvocationError("not_exact", `command does not match code-owned identity '${identity.owner}'`);
  }
  return Object.freeze({
    owner: identity.owner,
    source: identity.source,
    argv: Object.freeze(candidateWords.slice(3)),
  });
}

/** Fail closed before process start when a constructed runtime is incomplete. */
export function assertDevelopmentRuntimeSurface(root: string): string {
  for (const relative of DEVELOPMENT_RUNTIME_REQUIRED_FILES) {
    const target = path.join(root, relative);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      throw new DevelopmentInvocationError("invalid_authority", `runtime is missing required file '${relative}'`);
    }
    if (!stat.isFile()) {
      throw new DevelopmentInvocationError("invalid_authority", `runtime required file '${relative}' is not a regular file`);
    }
  }
  let manifest: { bin?: { agentera?: unknown }; files?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as typeof manifest;
  } catch {
    throw new DevelopmentInvocationError("invalid_authority", "package manifest is not valid JSON");
  }
  if (manifest.bin?.agentera !== "dist/bin/agentera.js") {
    throw new DevelopmentInvocationError("invalid_authority", "package bin declaration is not canonical");
  }
  const files = manifest.files;
  if (!Array.isArray(files) || !["dist", "bundle"].every((entry) => files.includes(entry))) {
    throw new DevelopmentInvocationError("invalid_authority", "package files declaration omits dist or bundle");
  }
  const bin = path.join(root, "dist/bin/agentera.js");
  if ((fs.statSync(bin).mode & 0o111) === 0) {
    throw new DevelopmentInvocationError("invalid_authority", "package bin is not executable");
  }
  return bin;
}

/** Keep only reviewed process inputs; PATH is always code-owned. */
export function scrubDevelopmentChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  explicit: Partial<Record<(typeof DEVELOPMENT_CHILD_ENV_ALLOWLIST)[number], string>>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of DEVELOPMENT_CHILD_ENV_ALLOWLIST) {
    if (key === "PATH") continue;
    const value = explicit[key] ?? inherited[key];
    if (value !== undefined) result[key] = value;
  }
  result.PATH = DEVELOPMENT_CHILD_PATH;
  return result;
}

function fieldValueIssue(field: RuntimeOperationField, value: string): string | undefined {
  if (field.validValues && !field.validValues.includes(value)) return "invalid value domain";
  if (field.kind === "boolean" && value !== "true" && value !== "false") return "invalid boolean";
  if (field.kind === "integer" && !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) return "invalid integer";
  if (field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "invalid date";
  if (field.kind === "datetime" && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(value)) return "invalid datetime";
  return undefined;
}

function validateOperationExample(spec: RuntimeOperationSpec, template: RuntimeOperationProjectionTemplate): void {
  if (template.runtime !== runtimeValue(template.source)) invalid(`${spec.artifact}.${spec.verb} has a non-canonical runtime example`);
  if (!template.source.startsWith(`${CANONICAL_DEVELOPMENT_INVOCATION} `)) invalid(`${spec.artifact}.${spec.verb} example has no canonical prefix`);
  const words = commandWords(template.source).map(({ value }) => value);
  const prefix = ["npx", "-y", "agentera@next", "state", spec.artifact, spec.verb];
  if (!prefix.every((word, index) => words[index] === word)) invalid(`${spec.artifact}.${spec.verb} example has the wrong operation family`);

  const fields = new Map(spec.fields.map((field) => [field.flag, field]));
  const seen = new Map<string, number>();
  let input = false;
  let format = false;
  for (let index = prefix.length; index < words.length;) {
    const flag = words[index++];
    if (!flag.startsWith("--") || flag === "--") invalid(`${spec.artifact}.${spec.verb} example has an extra positional argument`);
    const count = (seen.get(flag) ?? 0) + 1;
    seen.set(flag, count);
    if (flag === "--dry-run" || flag === "--force") {
      if (count > 1) invalid(`${spec.artifact}.${spec.verb} example repeats ${flag}`);
      if (flag === "--force" && !spec.allowForce) invalid(`${spec.artifact}.${spec.verb} example uses unauthorized --force`);
      continue;
    }
    const bareBoolean = fields.get(flag);
    if (bareBoolean?.kind === "boolean" && (words[index] === undefined || words[index]!.startsWith("--"))) {
      if (!bareBoolean.repeatable && count > 1) invalid(`${spec.artifact}.${spec.verb} example repeats ${flag}`);
      continue;
    }
    const argument = words[index++];
    if (argument === undefined || argument.startsWith("--")) invalid(`${spec.artifact}.${spec.verb} ${flag} needs one non-option value`);
    if (flag === "--format") {
      if (count > 1 || !spec.projection.formatValues.includes(argument as "text" | "json")) invalid(`${spec.artifact}.${spec.verb} example has an invalid format`);
      format = true;
      continue;
    }
    if (flag === "--input") {
      if (count > 1 || spec.inputMode !== "structured") invalid(`${spec.artifact}.${spec.verb} example has an unauthorized input`);
      input = true;
      continue;
    }
    const field = fields.get(flag);
    if (!field) invalid(`${spec.artifact}.${spec.verb} example has unauthorized flag ${flag}`);
    if (!field.repeatable && count > 1) invalid(`${spec.artifact}.${spec.verb} example repeats ${flag}`);
    const issue = fieldValueIssue(field, argument);
    if (issue) invalid(`${spec.artifact}.${spec.verb} example has ${issue} for ${flag}`);
  }
  if (!format) invalid(`${spec.artifact}.${spec.verb} example omits --format`);
  if (spec.inputMode === "structured" && !spec.inputOptional && !input) invalid(`${spec.artifact}.${spec.verb} example omits --input`);
  for (const field of spec.fields) {
    if (field.required && !seen.has(field.flag)) invalid(`${spec.artifact}.${spec.verb} example omits ${field.flag}`);
  }
}

const validatedOperations = new Set<string>();

function exactOperation(artifact: string, verb: string): RuntimeOperationSpec {
  const spec = runtimeOperationSpec(artifact, verb);
  if (!spec) invalid(`operation '${artifact}.${verb}' is not code-owned`);
  const key = `${artifact}.${verb}`;
  if (!validatedOperations.has(key)) {
    if (spec.projection.recovery.runtime !== runtimeValue(spec.projection.recovery.source))
      invalid(`${key} has a non-canonical runtime recovery`);
    if (spec.projection.examples.length === 0) invalid(`${key} has no code-owned example`);
    for (const example of spec.projection.examples) validateOperationExample(spec, example);
    validatedOperations.add(key);
  }
  return spec;
}

export function projectRuntimeOperationRecovery(value: unknown, artifact: string, verb: string): string {
  const spec = exactOperation(artifact, verb);
  return assertExact(value, `mutation.${artifact}.${verb}.recovery`, spec.projection.recovery.source);
}

export function projectRuntimeOperationExamples(value: unknown, artifact: string, verb: string): string[] {
  const spec = exactOperation(artifact, verb);
  if (!Array.isArray(value) || value.length !== spec.projection.examples.length)
    invalid(`'mutation.${artifact}.${verb}.examples' does not match its code-owned exact source list`);
  return spec.projection.examples.map((template, index) =>
    assertExact(value[index], `mutation.${artifact}.${verb}.examples[${index}]`, template.source));
}

export function projectEntityDevelopmentValue(
  value: unknown,
  familyKey: EntityListRuntimeFamilyKey,
  field: EntityProjectionField,
): string {
  const family = ENTITY_LIST_RUNTIME_FAMILIES.find(({ key }) => key === familyKey);
  const source = family?.projection[field];
  if (!family || typeof source !== "string") invalid(`retrieval.${familyKey}.${field} is not a code-owned projection`);
  return assertExact(value, `retrieval.${familyKey}.${field}`, source);
}

export function projectGlossaryDevelopmentValue(value: unknown, owner: GlossaryProjectionOwner): string {
  return assertExact(value, `glossary.${owner}`, GLOSSARY_PROJECTIONS[owner]);
}

export function developmentProjectionOwners(): DevelopmentProjectionOwner[] {
  const owners: DevelopmentProjectionOwner[] = [];
  for (const spec of runtimeOperationSpecs()) {
    exactOperation(spec.artifact, spec.verb);
    owners.push({
      owner: `mutation.${spec.artifact}.${spec.verb}.recovery`,
      family: "mutation",
      ...spec.projection.recovery,
      consumers: ["schema", "help", "explain"],
    });
    spec.projection.examples.forEach((example, index) => owners.push({
      owner: `mutation.${spec.artifact}.${spec.verb}.examples[${index}]`,
      family: "mutation",
      ...example,
      consumers: ["schema", "help", "explain", "parity"],
    }));
  }
  for (const family of ENTITY_LIST_RUNTIME_FAMILIES) {
    for (const field of ["list", "get", "example", "bareRecovery"] as const) {
      const source = family.projection[field];
      if (typeof source !== "string") continue;
      owners.push({
        owner: `retrieval.${family.key}.${field}`,
        family: "retrieval",
        source,
        runtime: runtimeValue(source),
        consumers: ["schema", "help", "runtime_failure"],
      });
    }
  }
  for (const [owner, source] of Object.entries(GLOSSARY_PROJECTIONS)) {
    owners.push({
      owner: `glossary.${owner}`,
      family: "glossary",
      source,
      runtime: runtimeValue(source),
      consumers: ["schema", "help", "runtime_contract"],
    });
  }
  if (new Set(owners.map(({ owner }) => owner)).size !== owners.length)
    invalid("code-owned projection owner identities are not unique");
  return owners;
}
