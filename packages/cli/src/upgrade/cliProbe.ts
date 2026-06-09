/**
 * In-process CLI probe for doctor status. Confirms the TS dispatcher exposes
 * expected state commands without spawning a subprocess.
 */

export interface ProbeResult {
  ok: boolean;
  command?: string[] | null;
  returnCode?: number | null;
  stdoutTail?: string[];
  stderrTail?: string[];
  missingCommands?: string[];
  message?: string;
}

export type ProbeRunner = (args: {
  bundleRoot: string;
  appHome: string;
  project: string;
  expectedCommands: readonly string[];
}) => ProbeResult;

import { DISPATCHER_COMMANDS } from "../cli/dispatch/commands.js";

/** Default probe: confirm the TS CLI exposes the expected state commands. */
export const inProcessProbe: ProbeRunner = ({ expectedCommands }) => {
  const missing = expectedCommands.filter((name) => !DISPATCHER_COMMANDS.has(name));
  const command = ["npx", "-y", "agentera", "--help"];
  return {
    ok: missing.length === 0,
    command,
    returnCode: 0,
    stdoutTail: [],
    stderrTail: [],
    missingCommands: missing,
    message:
      missing.length === 0
        ? "CLI exposes expected state commands"
        : "CLI is missing expected state commands",
  };
};
