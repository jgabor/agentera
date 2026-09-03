/**
 * Markdown TODO list-item parsing for GitHub checkboxes and Agentera type tags.
 */

export type TodoMarkdownItemStatus = "open" | "resolved";

export type ParsedTodoMarkdownItem = {
  status: TodoMarkdownItemStatus;
  description: string;
  title?: string;
  kind?: string;
  target_version?: string | null;
  id?: string;
  public_description?: string;
};

const TODO_LIST_ITEM_RE = /^- \[([^\]]+)\]\s+(.*)/;
const TODO_TYPE_TAG_RE = /^\[([a-z][a-z0-9_-]*)(?::([^\]\s]+))?\]\s+(.*)$/;
const TODO_LEGACY_ID_RE = /^(?:(\[[a-z][a-z0-9_-]*(?::[^\]\s]+)?\]\s+))?`([a-z]{10})`\s+(.*)$/;
const TODO_ID_TAG_RE = /^\[id:([a-z]{10})\]\s+(.*)$/;

function isGithubCheckboxResolved(token: string): boolean {
  return token.toLowerCase() === "x";
}

/**
 * Classify a trimmed markdown TODO bullet line.
 * Returns null when the line is not a `- […] …` list item.
 */
export function parseTodoMarkdownListItem(line: string): ParsedTodoMarkdownItem | null {
  const m = TODO_LIST_ITEM_RE.exec(line);
  if (!m) return null;
  const token = m[1];
  const rest = m[2].trim();
  const explicitId = TODO_ID_TAG_RE.exec(rest);
  const legacyId = explicitId ? null : TODO_LEGACY_ID_RE.exec(rest);
  const id = explicitId?.[1] ?? legacyId?.[2];
  const publicRest = explicitId?.[2]?.trim() ?? (legacyId ? `${legacyId[1] ?? ""}${legacyId[3]}`.trim() : rest);
  const typed = TODO_TYPE_TAG_RE.exec(publicRest) ?? TODO_TYPE_TAG_RE.exec(`[${token}] ${publicRest}`);
  const status = isGithubCheckboxResolved(token) ? "resolved" : "open";
  return {
    status,
    description: rest,
    ...(typed ? { kind: typed[1], target_version: typed[2] ?? null, title: typed[3].trim() } : { title: publicRest }),
    ...(id ? { id } : {}),
    ...(publicRest !== rest ? { public_description: publicRest } : {}),
  };
}

export function isResolvedTodoMarkdownStatus(status: string): boolean {
  return status === "resolved";
}

export function renderTodoPublicRecord(record: Record<string, unknown>): string {
  if (typeof record.title === "string" && record.title.trim()) {
    const kind = typeof record.kind === "string" && record.kind.trim() ? record.kind : "task";
    const target = typeof record.target_version === "string" && record.target_version.trim() ? `:${record.target_version}` : "";
    return `[${kind}${target}] ${record.title.trim()}`;
  }
  return String(record.description ?? "");
}
