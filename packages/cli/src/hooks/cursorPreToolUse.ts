import { HookCliAdapter } from "./validateArtifact.js";
import { pyJsonInline } from "../core/pyjson.js";

/**
 * Cursor preToolUse hook: block invalid reconstructable Write/Edit candidates.
 * Faithful TS port of hooks/cursor_pre_tool_use.py.
 */

export function runCursorPreToolUse(
  rawStdin: string,
  opts: { out?: (text: string) => void; defaultCwd?: string | null } = {},
): number {
  const out = opts.out ?? ((text: string) => process.stdout.write(text + "\n"));
  const adapter = new HookCliAdapter();
  const [rc, violations] = adapter.run(rawStdin, opts.defaultCwd ?? null);
  if (rc === 2) {
    const reason = violations.length > 0 ? violations.join("; ") : "artifact validation failed";
    out(pyJsonInline({ permission: "deny", user_message: reason, agent_message: reason }));
    return 0;
  }
  out(pyJsonInline({ permission: "allow" }));
  return 0;
}
