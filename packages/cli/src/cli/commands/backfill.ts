import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import {
  StateRetrievalFailure,
  type StateFailureBody,
} from "../../state/directRetrieval.js";
import { numberedArchiveArtifacts } from "../../state/archiveDiscovery.js";
import { stateGitBackfillContract } from "../../state/gitBackfillAuthority.js";
import {
  applyGitBackfill,
  inspectGitBackfill,
  previewGitBackfill,
  type GitBackfillArgs,
  type GitBackfillResponse,
} from "../../state/gitBackfill.js";
import { renderGitBackfillText } from "../../state/gitBackfillOutput.js";
import { applyProjectionRecovery, previewProjectionRecovery } from "../../state/projectionRecovery.js";

const BACKFILL_SYNTAX =
  "agentera state backfill [--recover-projections] [--project PATH] [--artifact ARTIFACT] [--number N] [--commit HASH] [--path PATH] [--limit N] [--dry-run|--apply --force] --format {text,json,yaml}";
const BACKFILL_DRY_RUN_EXAMPLE =
  "agentera state backfill --project PATH --artifact progress --number 1 --dry-run --format json";
const BACKFILL_APPLY_EXAMPLE =
  "agentera state backfill --project PATH --artifact progress --number 1 --apply --force --format json";

export function requestedBackfillFormat(argv: string[]): "text" | "json" | "yaml" {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--format") {
      const value = argv[index + 1];
      if (value === "json" || value === "yaml") return value;
    }
    if (argv[index].startsWith("--format=")) {
      const value = argv[index].slice("--format=".length);
      if (value === "json" || value === "yaml") return value;
    }
  }
  return "text";
}

function failure(
  message: string,
  format: "text" | "json",
  syntax = BACKFILL_SYNTAX,
  validValues?: string[],
  example = BACKFILL_DRY_RUN_EXAMPLE,
): { format: "text" | "json"; body: InvalidInputErrorBody } {
  return {
    format,
    body: {
      class: "invalid_request",
      message,
      syntax,
      example,
      ...(validValues ? { valid_values: validValues } : {}),
    },
  };
}

function authorityFailure(error: unknown): StateRetrievalFailure {
  const body: StateFailureBody = {
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "unsupported_state",
      message: `Git backfill authority could not be loaded: ${(error as Error).message}`,
      syntax: BACKFILL_SYNTAX,
      example: BACKFILL_DRY_RUN_EXAMPLE,
      recovery: "Repair references/artifacts/state-storage-authority.yaml and retry; no state was changed.",
      details: { authority: "references/artifacts/state-storage-authority.yaml" },
    },
  };
  return new StateRetrievalFailure(body, 1);
}

function emitAuthorityFailure(failure: StateRetrievalFailure, format: "text" | "json" | "yaml", io: Io): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  const err = io.err ?? ((text: string) => process.stderr.write(text));
  if (format === "json" || format === "yaml") emitStructured(failure.body, format, out);
  else err(`Error: ${failure.body.error.message}\nSyntax: ${failure.body.error.syntax}\nRecovery: ${failure.body.error.recovery}\n`);
  return failure.exitCode;
}

export function parseBackfillArgs(argv: string[]): GitBackfillArgs | { error: string } {
  const args: GitBackfillArgs = { project: null, artifact: null, format: "text" };
  const valueFlags = ["--project", "--artifact", "--number", "--limit", "--commit", "--path", "--format"];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const flag = valueFlags.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
    if (flag) {
      const inline = token.startsWith(`${flag}=`);
      const parsed = inline ? token.slice(flag.length + 1) : argv[++index];
      if (parsed === undefined || parsed === "") return { error: `argument ${flag}: expected a value` };
      if (flag === "--project") args.project = parsed;
      else if (flag === "--artifact") args.artifact = parsed;
      else if (flag === "--commit") args.commit = parsed;
      else if (flag === "--path") args.path = parsed;
      else if (flag === "--format") {
        if (parsed !== "text" && parsed !== "json" && parsed !== "yaml") {
          return { error: `argument --format: invalid choice: '${parsed}'` };
        }
        args.format = parsed;
      } else {
        if (!/^[1-9][0-9]*$/.test(parsed)) return { error: `argument ${flag}: invalid int value: '${parsed}'` };
        const number = Number(parsed);
        if (!Number.isSafeInteger(number)) return { error: `argument ${flag}: invalid int value: '${parsed}'` };
        if (flag === "--number") args.number = number;
        else args.limit = number;
      }
    } else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--apply") args.apply = true;
    else if (token === "--force") args.force = true;
    else if (token === "--recover-projections") args.recoverProjections = true;
    else return { error: `unrecognized arguments: ${token}` };
    }
  return args;
}

function validateBackfillArgs(args: GitBackfillArgs, sourceRoot: string): string | null {
  const contract = stateGitBackfillContract(sourceRoot);
  const artifacts = numberedArchiveArtifacts(sourceRoot);
  if (args.recoverProjections) {
    if (args.artifact || args.number !== undefined || args.commit || args.path || args.limit !== undefined) return "--recover-projections is a whole-batch operation and cannot be combined with entry selectors";
    if (args.apply && !args.force) return "--apply requires explicit --force intent";
    if (args.force && !args.apply) return "--force requires --apply";
    if (args.apply && !args.project) return "--apply requires explicit --project PATH";
    if (args.apply && args.dryRun) return "--apply and --dry-run are mutually exclusive";
    return null;
  }
  if (args.artifact && !artifacts.includes(args.artifact)) {
    return `unsupported artifact '${args.artifact}'`;
  }
  if (args.number !== undefined && !args.artifact) return "argument --number requires --artifact";
  if (args.commit && (!args.artifact || args.number === undefined)) {
    return "argument --commit requires --artifact and --number";
  }
  if (args.path && (!args.artifact || args.number === undefined)) {
    return "argument --path requires --artifact and --number";
  }
  if (args.limit !== undefined && (args.limit < 1 || args.limit > contract.maximumLimit)) {
    return `argument --limit must be between 1 and ${contract.maximumLimit}`;
  }
  if (args.apply && args.dryRun) return "--apply and --dry-run are mutually exclusive";
  if (args.apply && !args.force) return "--apply requires explicit --force intent";
  if (args.force && !args.apply) return "--force requires --apply";
  if (args.apply && contract.applyRequires.includes("--project PATH") && !args.project) {
    return "--apply requires explicit --project PATH";
  }
  if (args.apply && (!args.artifact || args.number === undefined)) {
    return "--apply requires exactly one --artifact and --number selector";
  }
  return null;
}

export function runBackfill(argv: string[], io: Io, sourceRootOverride?: string): number {
  const format = requestedBackfillFormat(argv);
  const sourceRoot = sourceRootOverride ?? resolveSourceRoot();
  let contract: ReturnType<typeof stateGitBackfillContract>;
  try {
    contract = stateGitBackfillContract(sourceRoot);
  } catch (error) {
    return emitAuthorityFailure(authorityFailure(error), format, io);
  }
  const parsed = parseBackfillArgs(argv);
  if ("error" in parsed) {
    const invalid = failure(parsed.error, format === "yaml" ? "text" : format, contract.command);
    return emitInvalidInput(io, invalid);
  }
  let validation: string | null;
  try {
    validation = validateBackfillArgs(parsed, sourceRoot);
  } catch (error) {
    return emitAuthorityFailure(authorityFailure(error), format, io);
  }
  if (validation) {
    const invalid = failure(
      validation,
      format === "yaml" ? "text" : format,
      contract.command,
      numberedArchiveArtifacts(sourceRoot),
      parsed.apply ? BACKFILL_APPLY_EXAMPLE : undefined,
    );
    return emitInvalidInput(io, invalid);
  }
  const mode = parsed.apply ? "apply" : parsed.dryRun ? "preview" : "inventory";
  if (parsed.recoverProjections) {
    try {
      const project = resolvePath(parsed.project ?? process.cwd());
      const response = parsed.apply ? applyProjectionRecovery(project, sourceRoot) : previewProjectionRecovery(project, sourceRoot);
      const out = io.out ?? ((text: string) => process.stdout.write(text));
      if (format === "json" || format === "yaml") emitStructured(response, format, out);
      else out(`${response.status}: selected=${response.counts.selected} ready=${response.counts.ready} refused=${response.counts.refused} applied=${response.counts.applied}\n`);
      return response.status === "blocked" ? 1 : 0;
    } catch (error) {
      return emitInvalidInput(io, failure((error as Error).message, format === "yaml" ? "text" : format));
    }
  }
  let response: GitBackfillResponse;
  try {
    const project = resolvePath(parsed.project ?? process.cwd());
    const options = { sourceRoot };
    if (mode === "apply") response = applyGitBackfill(project, parsed, options);
    else if (mode === "preview") response = previewGitBackfill(project, parsed, options);
    else response = inspectGitBackfill(project, parsed, options);
  } catch (error) {
    if (error instanceof StateRetrievalFailure) return emitAuthorityFailure(error, format, io);
    const invalid = failure(
      (error as Error).message,
      format === "yaml" ? "text" : format,
      contract.command,
      undefined,
      parsed.apply ? BACKFILL_APPLY_EXAMPLE : undefined,
    );
    return emitInvalidInput(io, invalid);
  }
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "json" || format === "yaml") emitStructured(response, format, out);
  else renderGitBackfillText(response, out);
  return mode === "apply" && response.status !== "complete" ? 1 : 0;
}
