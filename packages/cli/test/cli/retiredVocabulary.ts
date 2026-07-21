import crypto from "node:crypto";

export const RETIRED = /\b(?:stable_id|artifact_id|entry_number|task_number|experiment_number|plan_id|objective_id)\b|--(?:number|plan|task)(?=$|[\s=])|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:plan|task|objective|experiment|progress|decision|health):(?:[a-z]{10}|\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b|\b[a-z]{10}\/experiment:\d+\b/g;

export interface Finding { surface: string; pointer: string; match: string; excerpt: string; contextHash: string }
export interface Exception { surface: string; pointer: string; match: string; contextHash: string; reason: string }

function pointerEscape(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function hash(value: string | Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export function semanticFindings(surface: string, value: unknown, pointer = "", parent: unknown = null): Finding[] {
  const findings: Finding[] = [];
  if (Array.isArray(value)) value.forEach((child, index) => findings.push(...semanticFindings(surface, child, `${pointer}/${index}`, value)));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPointer = `${pointer}/${pointerEscape(key)}`;
      const contextHash = hash(JSON.stringify(canonical({ value: key, parent: value })));
      for (const match of key.matchAll(RETIRED)) findings.push({ surface, pointer: childPointer, match: match[0], excerpt: key, contextHash });
      findings.push(...semanticFindings(surface, child, childPointer, value));
    }
  } else if (typeof value === "string") {
    const contextHash = hash(JSON.stringify(canonical({ value, parent })));
    for (const match of value.matchAll(RETIRED)) findings.push({ surface, pointer: pointer || "/", match: match[0], excerpt: value, contextHash });
  }
  return findings;
}

function identity(item: Pick<Finding | Exception, "surface" | "pointer" | "match">): string {
  return JSON.stringify([item.surface, item.pointer, item.match]);
}

export function reconcile(findings: Finding[], exceptions: Exception[]): string[] {
  const errors: string[] = [];
  const findingGroups = Map.groupBy(findings, identity);
  const exceptionGroups = Map.groupBy(exceptions, identity);
  for (const [key, group] of findingGroups) if (group.length !== 1) errors.push(`duplicate finding ${key} x${group.length}`);
  for (const [key, group] of exceptionGroups) if (group.length !== 1) errors.push(`duplicate exception ${key} x${group.length}`);
  for (const finding of findings) {
    const candidates = exceptionGroups.get(identity(finding)) ?? [];
    if (candidates.length !== 1 || candidates[0].contextHash !== finding.contextHash) errors.push(`prohibited finding ${identity(finding)} context=${finding.contextHash}`);
  }
  for (const exception of exceptions) {
    const candidates = findingGroups.get(identity(exception)) ?? [];
    if (candidates.length !== 1 || candidates[0].contextHash !== exception.contextHash) errors.push(`unconsumed exception ${identity(exception)} context=${exception.contextHash}`);
  }
  return errors;
}
