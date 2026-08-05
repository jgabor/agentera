import { CANONICAL_DEVELOPMENT_CLI } from "../core/developmentChannel.js";

export const PRE_CUTOVER_CLI = CANONICAL_DEVELOPMENT_CLI;

export function assertPreCutoverCommand(command: string): string {
  if (!command.startsWith(`${PRE_CUTOVER_CLI} `) || command.includes("agentera@latest")) {
    throw new Error(`pre-cutover v3 command must use ${PRE_CUTOVER_CLI}: ${command}`);
  }
  return command;
}

export function preCutoverCommand(argumentsText: string): string {
  if (!argumentsText.trim() || /(?:^|\s)(?:npx|agentera(?:@\S+)?)(?:\s|$)/.test(argumentsText)) {
    throw new Error(`pre-cutover command arguments must not select an executable or channel: ${argumentsText}`);
  }
  return assertPreCutoverCommand(`${PRE_CUTOVER_CLI} ${argumentsText}`);
}

export function preCutoverCommandFromBare(command: string): string {
  if (!command.startsWith("agentera ")) {
    throw new Error(`expected a bare Agentera command before pre-cutover channel binding: ${command}`);
  }
  return preCutoverCommand(command.slice("agentera ".length));
}

const BARE_V3_COMMAND = /(?<![\w@-])agentera (?=(?:prime|doctor|upgrade|route|state|schema|check|report)\b)/g;

/** Bind every executable Agentera command in a pre-cutover instruction body. */
export function preCutoverInstructionBody(body: string): string {
  if (/\bagentera@latest\b/.test(body) || /\bnpx\s+(?:-y\s+)?agentera\s/.test(body)) {
    throw new Error(`pre-cutover instruction body selects a bare or stable Agentera executable`);
  }
  const bound = body.replace(BARE_V3_COMMAND, `${PRE_CUTOVER_CLI} `);
  if (BARE_V3_COMMAND.test(bound)) {
    throw new Error(`pre-cutover instruction body retains a bare Agentera command`);
  }
  return bound;
}
