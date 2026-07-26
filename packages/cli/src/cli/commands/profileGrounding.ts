import fs from "node:fs";

import { personalProfileGrounding } from "../../analytics/personalGlossaryProfile.js";
import { personalProfileGroundingContract } from "../../registries/glossaryEntryContract.js";
import { discoverSchemasDir } from "../appContext.js";
import type { Io } from "../dispatch/shared.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { registryArtifactPath } from "../orientation.js";
import { emitStructured } from "../structured.js";

const COMMAND = "agentera report profile-grounding --format json";
const PROFILE_RECOVERY = `Run agentera profile to repair or regenerate PROFILE.md, then retry ${COMMAND}; no profile bytes were changed.`;
const REQUEST_RECOVERY = `Run ${COMMAND}; no profile bytes were changed.`;
const INVALID_PROFILE_MESSAGE = "PROFILE.md cannot be used for grounding because it is malformed, ambiguous, unreadable, or exceeds the supported size limit.";

function invalid(io: Io, body: InvalidInputErrorBody, recovery: string): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery } });
}

function invalidProfile(io: Io): number {
  return invalid(io, {
    class: "invalid_request",
    message: INVALID_PROFILE_MESSAGE,
    valid_values: ["one readable, size-bounded PROFILE.md with no Glossary section or one valid owned personal Glossary section"],
  }, PROFILE_RECOVERY);
}

export function runProfileGroundingCommand(argv: string[], io: Io): number {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split("=", 2);
    if (name !== "--format") {
      return invalid(io, { class: "unrecognized_argument", message: "profile-grounding accepts only --format json", syntax: COMMAND }, REQUEST_RECOVERY);
    }
    const value = inline ?? argv[++index];
    if (value !== "json") {
      return invalid(io, { class: "invalid_choice", message: "profile-grounding requires --format json", valid_values: ["json"] }, REQUEST_RECOVERY);
    }
  }

  const contract = personalProfileGroundingContract();
  let profilePath: string;
  try {
    profilePath = registryArtifactPath("profile", discoverSchemasDir());
  } catch {
    return invalidProfile(io);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(profilePath);
    if (!stat.isFile()) throw new Error("not a regular file");
  } catch {
    emitStructured({
      schemaVersion: contract.schemaVersion,
      command: "report profile-grounding",
      status: "unavailable",
      content: null,
      recovery: "Run agentera profile to generate PROFILE.md, then retry agentera report profile-grounding --format json.",
    }, "json", io.out ?? ((text) => process.stdout.write(text)));
    return 0;
  }
  if (stat.size > contract.maxProfileUtf8Bytes) {
    return invalidProfile(io);
  }

  try {
    const content = personalProfileGrounding(fs.readFileSync(profilePath, "utf8"));
    emitStructured({
      schemaVersion: contract.schemaVersion,
      command: "report profile-grounding",
      status: "ok",
      content,
      content_utf8_bytes: Buffer.byteLength(content),
      excluded: "owned_personal_glossary_section",
    }, "json", io.out ?? ((text) => process.stdout.write(text)));
    return 0;
  } catch {
    return invalidProfile(io);
  }
}
