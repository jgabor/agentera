import { profileSignalsStatus } from "../../analytics/profileSignals.js";
import type { Io } from "../dispatch/shared.js";
import { emitInvalidInput } from "../errors.js";
import { acquireProfile } from "../profileAcquisition.js";
import { emitStructured } from "../structured.js";

export const PROFILE_INPUTS_CONTRACT = {
  schemaVersion: "agentera.profileInputs.v1",
  syntax: "npx -y agentera@next report profile-inputs",
  scope: "Explicit Profile generation metadata read. Does not acquire history, emit profile/glossary content, grant consent or write files. Normal Prime privacy is unchanged.",
  output: "profile.path is the configured generation destination; profile.validity and profile.freshness describe its existing bytes. bounded_signals supplies state, tiers_dir, signal_path, counts, sufficiency and recovery from the existing bounded-tier reader. Availability is not permission or evidence adequacy.",
};

export function runProfileInputsCommand(argv: string[], io: Io): number {
  if (argv.length && !(argv.length === 1 && argv[0] === "--format=json") && !(argv.length === 2 && argv[0] === "--format" && argv[1] === "json"))
    return emitInvalidInput(io, {
      format: "json",
      body: {
        class: "unrecognized_argument",
        message: "profile-inputs accepts only --format json",
        recovery: PROFILE_INPUTS_CONTRACT.syntax,
      },
    });
  const acquired = acquireProfile();
  emitStructured(
    {
      schemaVersion: PROFILE_INPUTS_CONTRACT.schemaVersion,
      command: "report profile-inputs",
      status: "ok",
      profile: {
        path: acquired.profilePath,
        validity: acquired.validity,
        freshness: acquired.freshness,
      },
      bounded_signals: profileSignalsStatus(),
      privacy: { local_history_read: false, profile_content_emitted: false, writes: false },
    },
    "json",
    io.out ?? ((text) => process.stdout.write(text)),
  );
  return 0;
}
