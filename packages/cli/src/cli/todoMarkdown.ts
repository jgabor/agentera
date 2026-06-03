/**
 * Markdown TODO list-item parsing for GitHub checkboxes and Agentera type tags.
 */

export type TodoMarkdownItemStatus = "open" | "resolved";

export type ParsedTodoMarkdownItem = {
  status: TodoMarkdownItemStatus;
  description: string;
};

const TODO_LIST_ITEM_RE = /^- \[([^\]]+)\]\s+(.*)/;

/** GitHub task-list checkbox tokens (inner bracket content). */
function isGithubCheckboxOpen(token: string): boolean {
  return token === " ";
}

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
  if (isGithubCheckboxResolved(token)) {
    return { status: "resolved", description: rest };
  }
  if (isGithubCheckboxOpen(token)) {
    return { status: "open", description: rest };
  }
  return { status: "open", description: rest };
}

export function isResolvedTodoMarkdownStatus(status: string): boolean {
  return status === "resolved";
}
