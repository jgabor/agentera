import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
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
  sourceRoot: string,
  format: "text" | "json",
  validValues?: string[],
): { format: "text" | "json"; body: InvalidInputErrorBody } {
  const contract = stateGitBackfillContract(sourceRoot);
  return {
    format,
    body: {
      class: "invalid_request",
      message,
      syntax: contract.command,
      example: "agentera state backfill --artifact progress --number 1 --dry-run --format json",
      ...(validValues ? { valid_values: validValues } : {}),
    },
  };
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
    else return { error: `unrecognized arguments: ${token}` };
    }
  return args;
}

function validateBackfillArgs(args: GitBackfillArgs, sourceRoot: string): string | null {
  const contract = stateGitBackfillContract(sourceRoot);
  const artifacts = numberedArchiveArtifacts(sourceRoot);
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
  if (args.apply && (!args.artifact || args.number === undefined)) {
    return "--apply requires exactly one --artifact and --number selector";
  }
  return null;
}

export function runBackfill(argv: string[], io: Io): number {
  const format = requestedBackfillFormat(argv);
  const sourceRoot = resolveSourceRoot();
  const parsed = parseBackfillArgs(argv);
  if ("error" in parsed) {
    const invalid = failure(parsed.error, sourceRoot, format === "yaml" ? "text" : format);
    return emitInvalidInput(io, invalid);
  }
  const validation = validateBackfillArgs(parsed, sourceRoot);
  if (validation) {
    const invalid = failure(validation, sourceRoot, format === "yaml" ? "text" : format, numberedArchiveArtifacts(sourceRoot));
    return emitInvalidInput(io, invalid);
  }
  const mode = parsed.apply ? "apply" : parsed.dryRun ? "preview" : "inventory";
  let response: GitBackfillResponse;
  try {
    const project = resolvePath(parsed.project ?? process.cwd());
    const options = { sourceRoot };
    if (mode === "apply") response = applyGitBackfill(project, parsed, options);
    else if (mode === "preview") response = previewGitBackfill(project, parsed, options);
    else response = inspectGitBackfill(project, parsed, options);
  } catch (error) {
    const invalid = failure((error as Error).message, sourceRoot, format === "yaml" ? "text" : format);
    return emitInvalidInput(io, invalid);
  }
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "json" || format === "yaml") emitStructured(response, format, out);
  else renderGitBackfillText(response, out);
  return mode === "apply" && response.status !== "complete" ? 1 : 0;
}
