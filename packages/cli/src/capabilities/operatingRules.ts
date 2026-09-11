/** Served projection of protocol.yaml#OPERATING_RULES; parity is contract-tested. */
export const OPERATING_INSTRUCTIONS = `## Execution rules

- Reuse passing evidence when task/scope, inputs, environment and coverage match. Recheck gaps, invalidation or mandatory gates; missing, stale or unrelated evidence never proves PASS.
- Test consequential unknowns narrowly before substantial dependent work.
- Add mechanisms only for concrete needs. Stop at accepted scope, even if blocked; new work/plans need authorization.

Project/host/trust gates, typed writers and explicit permissions remain binding. Guidance requires loading; not host enforcement.`;

export function withOperatingRules(body: string): string {
  return body.startsWith("# ") ? body.replace(/^(#[^\n]*\n)/, `$1\n${OPERATING_INSTRUCTIONS}\n`) : `${OPERATING_INSTRUCTIONS}\n\n${body}`;
}
