export const RETIRED_STARTUP_GUIDANCE_PATTERNS = [
  ["fallback_commands", /fallback_commands/],
  ["fallback_command", /fallback_command/],
  ["fallback_only", /fallback_only/],
  ["cli_fallback", /cli_fallback/],
  ["included state families", /included state families/],
  ["included/missing state", /included\/missing state/],
  ["missing_state", /missing_state/],
  ["write_contract", /write_contract/],
  ["writer payload", /writer payload/],
  ["source_contract", /source_contract/],
  ["source contract", /source[- ]contract/i],
  ["startup_contract", /startup_contract/],
  ["complete_for_*", /complete_for_/],
] as const;

export function retiredStartupGuidanceViolations(content: string): string[] {
  return RETIRED_STARTUP_GUIDANCE_PATTERNS
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => name);
}
