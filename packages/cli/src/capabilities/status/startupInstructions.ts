/**
 * Status has one authoritative startup capsule: its instructions and bounded
 * state arrive together from `prime --context status`. Keep the established
 * status vocabulary by adapting the canonical instructions rather than
 * maintaining a second dashboard description.
 */
export function statusStartupInstructions(canonical: string): string {
  const replacements: Array<[string, string]> = [
    [
      "Glyph: **⌂** (SG1). Status reads suite state through `agentera prime` and writes nothing.",
      "Glyph: **⌂** (SG1). Status reads its startup capsule through `agentera prime --context status --format json` and writes nothing.",
    ],
    [
      "Status MUST source state from `agentera prime --format json` and write nothing. The `source_contract.capability_startup` field declares whether prime is complete for capability startup; when complete, status MUST NOT run separate artifact queries or raw `.agentera/*.yaml` reads. If prime fails or reports incomplete state, fall back to commands listed in `source_contract.cli_fallback` as a last resort.",
      "Status MUST source both instructions and bounded state from `agentera prime --context status --format json` and write nothing. Read `capability_context.instructions` in full, render from `capability_context.context.status_context`, and use the one `capability_context.startup` aggregation. Its outcome is `ok`, `degraded`, or `blocked`; `status_context.outcome` is the same value. For deferred detail, run only that availability row's exact `detail_command`. An `ok` startup needs no second prime or fallback call. Status MUST NOT raw-read `.agentera/*.yaml`.",
    ],
    [
      "Build the dashboard from `agentera prime --format json` output.",
      "Build the dashboard from `capability_context.context.status_context` in the status startup response.",
    ],
    [
      "Use the `mode` field from `agentera prime` to detect fresh vs returning:",
      "Use the `mode` field from `capability_context.context.status_context` to detect fresh vs returning:",
    ],
    [
      "- todo open items → select the highest-severity open item, then route by shape: narrow one-cycle todo items suggest ⧉ build; contract-shaped, multi-surface, dependency-heavy, migration, schema, metadata, validation, or acceptance-risky todo items suggest ≡ plan first. Prefer items that unlock product evidence or future plans.",
      "- TODO open items → use the `next_action` selected from complete typed readiness state. Recommend only an actionable item ordered by severity and declared `queue_rank`; preserve its TODO ID, declared reason, derived phase, and exact retrieval. Keep needs-triage visible without displacing actionable work. When none is actionable, abstain and show the supplied recovery. Never infer destination or order from description prose.",
    ],
  ];

  let adapted = canonical;
  for (const [from, to] of replacements) {
    if (!adapted.includes(from)) {
      throw new Error(`status startup instructions no longer contain the expected vocabulary: ${from.slice(0, 48)}`);
    }
    adapted = adapted.replace(from, to);
  }
  return adapted;
}
