import YAML from "yaml";

function healthIdentityNumber(value: unknown): number | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mapping = value as Record<string, unknown>;
    const number = mapping.number;
    if (Number.isSafeInteger(number) && Number(number) > 0) return Number(number);
    return healthIdentityNumber(mapping.summary);
  }
  if (typeof value !== "string") return null;
  const match = /^Audit\s+([1-9][0-9]*)\b/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

export function repairHealthDuplicates(doc: Record<string, unknown>, number: number, keep: "first" | "last"): { candidate: Record<string, unknown>; removed: number } {
  const candidate = structuredClone(doc);
  let removed = 0;
  for (const key of ["audits", "archive"]) {
    const values = Array.isArray(candidate[key]) ? candidate[key] : [];
    const matches = values.flatMap((value, index) => (healthIdentityNumber(value) === number ? [index] : []));
    if (matches.length < 2) continue;
    const retained = keep === "last" ? matches.at(-1) : matches[0];
    candidate[key] = values.filter((_, index) => !matches.includes(index) || index === retained);
    removed += matches.length - 1;
  }
  return { candidate, removed };
}

export function repairHealthProjectionBytes(bytes: string, number: number, keep: "first" | "last"): { bytes: string; removed: number } {
  const document = YAML.parseDocument(bytes);
  const removals: Array<[number, number]> = [];
  let removed = 0;
  for (const key of ["audits", "archive"]) {
    const sequence = document.get(key, true) as { items?: unknown[]; range?: number[] } | null;
    const items = sequence?.items ?? [];
    const sequenceEnd = sequence?.range?.[1];
    const matches = items.flatMap((item, index) => {
      const value = typeof (item as { toJSON?: () => unknown })?.toJSON === "function" ? (item as { toJSON: () => unknown }).toJSON() : item;
      return healthIdentityNumber(value) === number ? [index] : [];
    });
    if (matches.length < 2) continue;
    const retained = keep === "last" ? matches.at(-1) : matches[0];
    for (const index of matches) {
      if (index === retained) continue;
      const range = (items[index] as { range?: number[] })?.range;
      if (!range || range.length < 2) throw new Error(`health ${key} row ${index} has no stable YAML range`);
      const lineStart = bytes.lastIndexOf("\n", range[0] - 1) + 1;
      const nextRange = (items[index + 1] as { range?: number[] })?.range;
      const rawEnd = nextRange?.[0] ?? sequenceEnd ?? bytes.length;
      const lineEnd = nextRange
        ? bytes.lastIndexOf("\n", rawEnd - 1) + 1
        : (() => {
            const newline = bytes.indexOf("\n", Math.max(range[1], rawEnd));
            return newline < 0 ? bytes.length : newline + 1;
          })();
      removals.push([lineStart, Math.max(lineStart, lineEnd)]);
      removed += 1;
    }
  }
  for (const [start, end] of removals.sort((left, right) => right[0] - left[0])) {
    bytes = bytes.slice(0, start) + bytes.slice(end);
  }
  return { bytes, removed };
}
