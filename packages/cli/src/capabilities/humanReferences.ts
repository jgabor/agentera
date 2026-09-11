import { truncateCodePoints } from "../core/text.js";

/** Human-only projection of protocol.yaml#HUMAN_REFERENCES; parity is contract-tested. */
export const HUMAN_REFERENCE_LABELS = {
  decision: "⛋ Decision",
  plan: "≡ Plan",
  task: "□ Task",
  todo: "→ TODO",
} as const;

export function humanReference(family: keyof typeof HUMAN_REFERENCE_LABELS, content: unknown, id: unknown, state: unknown, { prefix = "", maxCodePoints = 110 } = {}): string {
  const text = typeof content === "string" && content.trim() ? content.trim() : "description unavailable";
  const identity = typeof id === "string" && id ? id : "ID unavailable";
  const status = typeof state === "string" && state ? state.replaceAll("_", " ") : "status/confidence unavailable";
  const suffix = ` · ${HUMAN_REFERENCE_LABELS[family]} ${identity} · ${status}`;
  // Bound only the description, reserving identity/meaning and any attention
  // prefix. Actions also survive the text presenter's existing 110-point bound.
  const description = truncateCodePoints(text, Math.max(0, Math.min(160, maxCodePoints - Array.from(prefix + suffix).length)), "…");
  return `${prefix}${description}${suffix}`;
}

export const HUMAN_REFERENCE_INSTRUCTIONS = `## Human references

Use source titles/summaries; no title required. Missing descriptions/status/confidence: unavailable. ${Object.values(HUMAN_REFERENCE_LABELS).join(", ")} + status/confidence words. Exact IDs on rows/targets/duplicates, optional in prose. Expand/omit human codes; machine values unchanged. Glyph loss loses no meaning; other families: text only, other glyph meanings unchanged.`;

export function withHumanReferences(body: string): string {
  // Drop redundant prose-only primitive citations, not selectors or code examples.
  // Their adjacent words already carry the meaning (e.g. provisional (DL2)).
  const codes = "(?:CS|SF|SI|SM|DL|EX|VT|SG|PH)\\d+(?:(?:-|/|, )(?:CS|SF|SI|SM|DL|EX|VT|SG|PH)\\d+)*";
  const renderProse = (text: string): string =>
    text
      .split(/(`[^`\n]*`)/g)
      .map((part) =>
        part.startsWith("`")
          ? part
          : part
              .replace(new RegExp(`\\s+\\((?:protocol(?: refs?)?: )?${codes}\\)`, "g"), "")
              .replace(new RegExp(`\\((?:protocol(?: refs?)?: )?${codes}, `, "g"), "(")
              .replace(new RegExp(`, protocol(?: refs?)?: ${codes}(?=\\))`, "g"), "")
              .replace("protocol SF1-SF3", "finding severity (critical, warning, info)")
              .replace("protocol refs: SF1-SF3 for finding severity", "critical, warning, info")
              .replace("to CS4 or below", "to weak evidence (30-49) or below"),
      )
      .join("");
  const prose = body
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (!part.startsWith("```")) return renderProse(part);
      if (/^```(?:text|markdown|md)\n/.test(part)) {
        const start = part.indexOf("\n") + 1;
        return part.slice(0, start) + renderProse(part.slice(start, -3)) + "```";
      }
      return part;
    })
    .join("");
  return prose.startsWith("# ") ? prose.replace(/^(#[^\n]*\n)/, `$1\n${HUMAN_REFERENCE_INSTRUCTIONS}\n`) : `${HUMAN_REFERENCE_INSTRUCTIONS}\n\n${prose}`;
}
