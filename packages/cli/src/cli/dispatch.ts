import { cmdPrime } from "./commands/prime.js";

/**
 * Top-level command dispatch. Phase 0 wires only `prime`; subsequent phases
 * add the full command surface (state/check/report/hook/etc.) and a proper
 * argparse-shaped parser.
 */
export function main(argv: string[]): number {
  const args = argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "prime":
      return cmdPrime(rest);
    default:
      process.stderr.write(
        `agentera: unknown or not-yet-ported command: ${command ?? "(none)"}\n`,
      );
      return 1;
  }
}
