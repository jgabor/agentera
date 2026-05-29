import { PRIME_BLOB } from "../prime-blob.js";

/**
 * Phase 0 spike: implements `agentera prime --guidance`, which prints the static
 * priming guide. Full orientation/dashboard/context behavior lands in Phase 7.
 */
export function cmdPrime(args: string[]): number {
  if (args.includes("--guidance")) {
    process.stdout.write(PRIME_BLOB);
    return 0;
  }
  // Phase 0: only --guidance is wired. Other prime modes come in Phase 7.
  process.stderr.write(
    "agentera prime: only `--guidance` is implemented in this build stage.\n",
  );
  return 1;
}
