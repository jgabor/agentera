export const PRE_CUTOVER_CLI = "npx -y agentera@next";

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
