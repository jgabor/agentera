/**
 * Status has one authoritative startup capsule: its instructions and bounded
 * state arrive together from `prime --context status`. Keep the established
 * status vocabulary by adapting the canonical instructions rather than
 * maintaining a second dashboard description.
 */
export function statusStartupInstructions(canonical: string): string {
  const replacements: Array<[string, string]> = [
    [
      "**Holistic Entry Junction. Orient, Route, Activate**\n\nSingle entry point to the agentera suite. Detects fresh vs returning, delivers a situational briefing, routes to the right capability. Same path on first install and the 100th session.",
      "Read-only orientation and capability routing for fresh and returning projects.",
    ],
    ["Glyph: **⌂** (SG1). Status reads suite state through `agentera prime` and writes nothing.", "Glyph: **⌂** (SG1). Status reads its startup capsule through `agentera prime --context status` and writes nothing."],
    ["A bare user message of exactly `/agentera` invokes this capability; it does not fall back to conversational smalltalk.", "A bare `/agentera` invokes Status, not smalltalk."],
    ["Status owns the prime dashboard contract. SKILL.md and other surfaces delegate here.", "Status owns dashboard rendering."],
    [
      "Status MUST source both instructions and bounded state from `agentera prime --context status` and write nothing. Read `capability_context.instructions` in full, render from `capability_context.context.status_context`, and use the one `capability_context.startup` aggregation. Its outcome is `ok`, `degraded`, or `blocked`; `status_context.outcome` is the same value. For deferred detail, run only that availability row's exact `detail_command`. An `ok` startup needs no second prime call. Status MUST NOT raw-read `.agentera/*.yaml`.",
      "Read all `capability_context.instructions`; render `capability_context.context.status_context`. Use the sole `capability_context.startup` aggregation: `ok`, `degraded`, or `blocked` matches `status_context.outcome`. Deferred detail uses only the row's exact `detail_command`; `ok` needs no second prime. Status MUST NOT raw-read `.agentera/*.yaml`.",
    ],
    ["Build the dashboard from `agentera prime` output.", "Build the dashboard from `capability_context.context.status_context` in the status startup response."],
    ["Valid objects: `PLAN Task N: <title>`, `TODO: <item>`, `DECISION N follow-up`, `OBJECTIVE: <metric>`, or `VISION refresh`.", "For entity targets, follow the shared human-reference rules; retain exact IDs. Other objects include `OBJECTIVE: <metric>` and `VISION refresh`."],
    ["Use the `mode` field from `agentera prime` to detect fresh vs returning:", "Use the `mode` field from `capability_context.context.status_context` to detect fresh vs returning:"],
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
