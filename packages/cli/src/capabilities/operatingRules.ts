/** Served projection of protocol.yaml#OPERATING_RULES; parity is contract-tested. */
export const OPERATING_INSTRUCTIONS = `## Execution rules

- Reuse PASS only for matching scope, inputs, environment and coverage; check gaps, invalidation and mandatory gates.
- Probe consequential unknowns narrowly before dependent work.
- Add mechanisms only for concrete needs. Stop at accepted scope, even if blocked. New work/plans need authorization.
- Carry explicit save-and-execute plan approval through unchanged handoff; planning-only approval, silence or material changes do not authorize execution. Git, global installation and history permissions remain separate.
- Check relevant artifact coherence before firm closure; surface conflicts, gaps and deliberate exceptions. Follow protocol OPERATING_RULES detail.

Project/host/trust gates, typed writers and explicit permissions remain binding. Guidance requires loading; not host enforcement.`;

export function withOperatingRules(body: string): string {
  return body.startsWith("# ") ? body.replace(/^(#[^\n]*\n)/, `$1\n${OPERATING_INSTRUCTIONS}\n`) : `${OPERATING_INSTRUCTIONS}\n\n${body}`;
}
