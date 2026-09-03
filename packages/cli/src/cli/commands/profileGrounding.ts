import { personalProfileGroundingContract } from "../../registries/glossaryEntryContract.js";
import type { Io } from "../dispatch/shared.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { acquireProfile } from "../profileAcquisition.js";
import { emitStructured } from "../structured.js";

const COMMAND = "agentera report profile-grounding";
const REQUEST_RECOVERY = `Run ${COMMAND}; no profile bytes were changed.`;
const INVALID_PROFILE_MESSAGE = "PROFILE.md is unavailable for bounded profile grounding.";

function invalid(io: Io, body: InvalidInputErrorBody, recovery: string): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery } });
}

export function runProfileGroundingCommand(argv: string[], io: Io): number {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split("=", 2);
    if (name !== "--format") {
      return invalid(
        io,
        {
          class: "unrecognized_argument",
          message: "profile-grounding accepts only",
          syntax: COMMAND,
        },
        REQUEST_RECOVERY,
      );
    }
    const value = inline ?? argv[++index];
    if (value !== "json") {
      return invalid(io, { class: "invalid_choice", message: "profile-grounding requires", valid_values: ["json"] }, REQUEST_RECOVERY);
    }
  }

  const contract = personalProfileGroundingContract();
  const acquired = acquireProfile();
  const output = io.out ?? ((text: string) => process.stdout.write(text));
  if (acquired.validity.status !== "valid" || acquired.groundingContent === null) {
    emitStructured(
      {
        schemaVersion: contract.schemaVersion,
        command: "report profile-grounding",
        status: acquired.validity.status,
        validity: acquired.validity,
        freshness: acquired.freshness,
        content: null,
        recovery: acquired.validity.recovery,
        error: {
          class: "profile_unavailable",
          message: INVALID_PROFILE_MESSAGE,
          recovery: acquired.validity.recovery,
        },
      },
      "json",
      output,
    );
    return 2;
  }

  emitStructured(
    {
      schemaVersion: contract.schemaVersion,
      command: "report profile-grounding",
      status: "ok",
      validity: acquired.validity,
      freshness: acquired.freshness,
      content: acquired.groundingContent,
      content_utf8_bytes: Buffer.byteLength(acquired.groundingContent),
      excluded: "owned_personal_glossary_section",
      recovery: null,
    },
    "json",
    output,
  );
  return 0;
}
