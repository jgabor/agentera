export const RETIRED = /\b(?:stable_id|artifact_id|entry_number|task_number|experiment_number|plan_id|objective_id)\b|--(?:number|task)(?=$|[\s=])|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:plan|task|objective|experiment|progress|decision|health):(?:[a-z]{10}|\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b|\b[a-z]{10}\/experiment:\d+\b/g;

function pointerEscape(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function semanticFindings(surface: string, value: unknown, pointer = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => semanticFindings(surface, child, `${pointer}/${index}`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const childPointer = `${pointer}/${pointerEscape(key)}`;
      return [
        ...Array.from(key.matchAll(RETIRED), (match) => `${surface}${childPointer}: ${match[0]}`),
        ...semanticFindings(surface, child, childPointer),
      ];
    });
  }
  return typeof value === "string"
    ? Array.from(value.matchAll(RETIRED), (match) => `${surface}${pointer || "/"}: ${match[0]}`)
    : [];
}
