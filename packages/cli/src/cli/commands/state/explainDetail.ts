import { createHash } from "node:crypto";
import { emitInvalidInput } from "../../errors.js";
import { guidanceDetail, GuidanceInputError, guidanceQuote } from "../../guidanceDetail.js";
import { buildExplain, buildExplainAll } from "../../../state/write/explain.js";
import { isWritableArtifact, verbsForArtifact } from "../../../state/write/operations.js";
import { currentOperationDetail } from "../../../state/write/operationDetail.js";

export function isStateExplainDetail(argv: string[]): boolean {
  return argv[0] === "state" && argv[2] === "explain" && argv.slice(3).some((arg) => ["--section", "--limit", "--cursor"].includes(arg.split("=")[0]));
}

/** Static operation knowledge, not an entity read or a mutation preview. */
export function runStateExplainDetail(artifact: string, argv: string[], io: { out?: (text: string) => void; err?: (text: string) => void }): number {
  let command = `npx -y agentera@next state ${guidanceQuote(artifact)} explain`;
  try {
    if (!isWritableArtifact(artifact)) throw new GuidanceInputError("Unknown typed writer family.");
    const args: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
      const [flag, ...inline] = argv[i].split("=");
      const key = flag.slice(2);
      if (!flag.startsWith("--") || !["verb", "all", "section", "limit", "cursor", "format"].includes(key)) throw new GuidanceInputError("Unrecognized static operation argument; operational inputs and consent flags are not accepted.");
      if (key in args) throw new GuidanceInputError("Repeated static operation selector.");
      if (key === "all") {
        if (inline.length) throw new GuidanceInputError("--all does not accept a value.");
        args.all = true;
      } else {
        const value = inline.length ? inline.join("=") : argv[++i];
        if (!value || value.startsWith("--")) throw new GuidanceInputError(`Missing value for ${flag}.`);
        args[key] = value;
      }
    }
    if (args.all && args.verb) throw new GuidanceInputError("--all and --verb are mutually exclusive.");
    if (args.format !== undefined && args.format !== "json") throw new GuidanceInputError("Static operation detail supports JSON only.", ["json"]);
    const verbs = verbsForArtifact(artifact).filter((verb) => verb !== "explain");
    if (args.verb && !verbs.includes(String(args.verb) as (typeof verbs)[number])) throw new GuidanceInputError("Unknown writer operation.", verbs);
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    if ((args.limit !== undefined && !/^\d+$/.test(String(args.limit))) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GuidanceInputError("--limit must be an integer from 1 to 100.");
    const verb = String(args.verb ?? verbs[0]);
    command += args.all ? " --all" : ` --verb ${guidanceQuote(verb)}`;
    const explanation = args.all ? buildExplainAll(artifact, "/", true) : buildExplain(artifact, "/", verb, true);
    const content = args.all ? Object.fromEntries((explanation.operations as Record<string, unknown>[]).map((operation) => [String(operation.requested_verb), currentOperationDetail(artifact, String(operation.requested_verb), operation)])) : currentOperationDetail(artifact, verb, explanation);
    const result = guidanceDetail({
      command: `state ${artifact} explain`,
      baseCommand: command,
      selection: { artifact, ...(args.all ? { all: true } : { verb }) },
      sections: [
        {
          name: "detail",
          content,
          authority: "typed writer operation contract",
          classification: "current_operation",
        },
      ],
      section: args.section as string | undefined,
      limit,
      cursor: args.cursor as string | undefined,
      authorityDigest: createHash("sha256")
        .update(JSON.stringify([explanation, content]))
        .digest("hex"),
      qualifications: {
        static: true,
        requires_project: false,
        effects: "None. Discovery does not grant project access, writer ownership, or consent. Read every indicated part before acting.",
      },
    });
    (io.out ?? ((text) => process.stdout.write(text)))(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    const invalid = error instanceof GuidanceInputError;
    emitInvalidInput(io, {
      format: "json",
      body: {
        class: invalid ? "invalid_request" : "unsupported_target",
        message: invalid ? error.message : `Operation authority unavailable: ${(error as Error).message}`,
        ...(invalid && error.validValues.length ? { valid_values: error.validValues } : {}),
        syntax: `${command} --section detail [--limit N] [--cursor TOKEN]`,
        example: `${command} --section detail`,
        recovery: invalid ? "Use an advertised operation and restart its detail query; no state was changed." : "Restore the selected runtime authority and retry; no state was changed.",
      },
    });
    return invalid ? 64 : 1;
  }
}
