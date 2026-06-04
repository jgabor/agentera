/**
 * Runtime event parsing for agent artifact writes.
 *
 * Detects which file a runtime wants to write (or which apply_patch
 * headers describe) and packages it as an `ArtifactWrite`. The CLI
 * adapter uses this on the JSON payload that Claude, OpenCode, Codex,
 * and Copilot hand to a PostToolUse hook.
 */

import { isMapping } from "./schema.js";

type Dict = Record<string, any>;

export class ArtifactWrite {
  file_path: string;
  content: string | null;
  constructor(filePath: string, content: string | null = null) {
    this.file_path = filePath;
    this.content = content;
  }
}

export class RuntimeEventParser {
  parseClaude(data: Dict): ArtifactWrite | null {
    const ti = data.tool_input;
    if (!isMapping(ti)) return null;
    const fp = ti.file_path;
    if (fp) return new ArtifactWrite(String(fp), ti.content ?? null);
    return null;
  }

  parseOpencode(data: Dict): ArtifactWrite | null {
    const inp = data.input;
    if (!isMapping(inp)) return null;
    const fp = inp.path;
    if (fp) return new ArtifactWrite(String(fp), inp.content ?? null);
    return null;
  }

  parseCodex(data: Dict): ArtifactWrite | null {
    const ti = data.tool_input;
    if (!isMapping(ti)) return null;
    const fp = ti.path;
    const patchBody = ti.patch || ti.command || "";
    if (fp) return new ArtifactWrite(String(fp));
    if (typeof patchBody === "string") {
      const headers = [...patchBody.matchAll(/^\*\*\*\s+(?:Add File|Update File):\s+(.+?)\s*$/gm)];
      if (headers.length > 0) return new ArtifactWrite(headers[0][1]);
    }
    return null;
  }

  parseCopilot(data: Dict): ArtifactWrite | null {
    const inp = data.input;
    if (!isMapping(inp)) return null;
    const fp = inp.filePath || inp.file_path;
    if (fp) return new ArtifactWrite(String(fp), inp.content ?? null);
    return null;
  }

  parse(data: Dict): ArtifactWrite | null {
    const tn = data.tool_name ?? "";
    if (tn === "apply_patch") {
      const candidate = this.parseCodex(data);
      if (candidate) return candidate;
    }
    if (tn === "Edit" || tn === "Write" || (isMapping(data.tool_input) && "file_path" in data.tool_input)) {
      const candidate = this.parseClaude(data);
      if (candidate) return candidate;
    }
    if (isMapping(data.input)) {
      const inp = data.input;
      if ("filePath" in inp || "file_path" in inp) return this.parseCopilot(data);
      if ("path" in inp) return this.parseOpencode(data);
    }
    return null;
  }
}
