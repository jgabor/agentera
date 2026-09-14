import { createHash } from "node:crypto";

export const GUIDANCE_MAX_BYTES = 32_768;
export interface GuidanceSection {
  name: string;
  content: unknown;
  authority: string;
  classification: string;
}
export class GuidanceInputError extends Error {
  constructor(
    message: string,
    public validValues: string[] = [],
    public recovery?: string,
  ) {
    super(message);
  }
}
export function guidanceQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) + "\n");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Pure pagination for static semantic contracts; never resolves paths or state. */
export function guidanceDetail(options: { command?: string; baseCommand: string; selection: Record<string, string | boolean>; sections: GuidanceSection[]; section?: string; limit: number; cursor?: string; authorityDigest: string; qualifications?: unknown }) {
  const { baseCommand, sections, limit } = options;
  const commandFor = (name: string) => `${baseCommand} --section ${guidanceQuote(name)} --limit ${limit}`;
  const childSections = (node: GuidanceSection): GuidanceSection[] => {
    if (node.content === null || typeof node.content !== "object") return [];
    return Object.entries(node.content).map(([key, content]) => ({
      ...node,
      name: `${node.name}.${encodeURIComponent(key).replaceAll(".", "%2E")}`,
      content,
    }));
  };
  let selected: GuidanceSection | undefined;
  if (options.section !== undefined) {
    const parts = options.section.split(".");
    selected = sections.find((s) => s.name === parts[0]);
    for (let i = 1; selected && i < parts.length; i++) selected = childSections(selected).find((s) => s.name === parts.slice(0, i + 1).join("."));
    if (!selected)
      throw new GuidanceInputError(
        "Unknown semantic section; restart the selected index for exact section commands.",
        sections.map((s) => s.name),
      );
  }
  const indexItem = (s: GuidanceSection) => ({
    name: s.name,
    authority: s.authority,
    classification: s.classification,
    content: {
      kind: Array.isArray(s.content) ? "array" : typeof s.content,
      detail_command: commandFor(s.name),
    },
  });
  let mode = "index";
  let items: unknown[] = sections.map(indexItem);
  if (selected) {
    mode = "detail";
    items = [selected];
    if (bytes(selected) > 16_384) {
      const children = childSections(selected);
      if (children.length) {
        mode = "index";
        items = children.map(indexItem);
      } else if (typeof selected.content === "string") {
        // Split by Unicode code points; JSON escaping is included in the bound.
        const parts: string[] = [];
        let part = "";
        let partBytes = 3; // JSON quotes plus trailing newline.
        for (const char of selected.content) {
          const charBytes = bytes(char) - 3;
          if (partBytes + charBytes > 8_192) {
            parts.push(part);
            part = "";
            partBytes = 3;
          }
          part += char;
          partBytes += charBytes;
        }
        if (part) parts.push(part);
        items = parts.map((content, i) => ({
          ...selected,
          content,
          part: i + 1,
          parts: parts.length,
        }));
      }
    }
  }
  const selection = {
    ...options.selection,
    ...(options.section !== undefined ? { section: options.section } : {}),
  };
  const binding = digest([options.authorityDigest, selection, limit, items]);
  const query = options.section === undefined ? `${baseCommand} --limit ${limit}` : commandFor(options.section);
  let start = 0;
  if (options.cursor !== undefined) {
    const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(Buffer.from(options.cursor, "base64url").toString());
    if (!match || match[1] !== binding || Buffer.from(match[0]).toString("base64url") !== options.cursor) throw new GuidanceInputError("Invalid or stale cursor; restart this selection.", [], query);
    start = Number(match[2]);
    if (!Number.isSafeInteger(start) || start < 1 || start >= items.length) throw new GuidanceInputError("Invalid cursor offset; restart this selection.", [], query);
  }
  const page = (end: number) => ({
    schemaVersion: "agentera.guidanceDetail.v1",
    command: options.command ?? "schema",
    status: "ok",
    selection,
    ...(options.qualifications ? { qualifications: options.qualifications } : {}),
    items: items.slice(start, end),
    completeness: {
      mode,
      total: items.length,
      returned: end - start,
      omitted: items.length - (end - start),
      offset: start,
      complete: mode === "detail" && start === 0 && end === items.length,
    },
    next_command: end < items.length ? `${query} --cursor ${guidanceQuote(Buffer.from(`${binding}:${end}`).toString("base64url"))}` : null,
  });
  let end = Math.min(items.length, start + limit);
  while (end > start && bytes(page(end)) > GUIDANCE_MAX_BYTES) end--;
  if (end === start && items.length) throw new Error("Static authority item cannot fit the bounded detail envelope.");
  return page(end);
}
