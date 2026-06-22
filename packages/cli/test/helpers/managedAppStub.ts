import fs from "node:fs";
import path from "node:path";

import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

export const MANAGED_APP_SCRIPT_PATH = path.join("app", "scripts", "agentera");

export const PYTHON_SHEBANG = "#!/usr/bin/env python3";
export const NODE_SHEBANG = "#!/usr/bin/env node";
export const UV_SCRIPT_SHEBANG = "#!/usr/bin/env -S uv run --script";

const PYTHON_STUB_BODY = "sub.add_parser('hej')\n";
const NODE_STUB_BODY = "void 0;\n";

export type ScriptRuntime = "python" | "node";

export function scriptShebang(runtime: ScriptRuntime): string {
  return runtime === "python" ? PYTHON_SHEBANG : NODE_SHEBANG;
}

export function scriptBody(runtime: ScriptRuntime): string {
  return runtime === "python" ? PYTHON_STUB_BODY : NODE_STUB_BODY;
}

export function managedAppScriptContent(runtime: ScriptRuntime): string {
  return `${scriptShebang(runtime)}\n${scriptBody(runtime)}`;
}

export function platformDefaultAppHome(home: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "agentera");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "agentera");
  }
  return path.join(home, ".local", "share", "agentera");
}

export interface ManagedAppStubOptions {
  marker?: string | null;
  runtime?: ScriptRuntime;
  scriptContent?: string;
}

export function writeManagedAppStub(appHome: string, opts: ManagedAppStubOptions = {}): void {
  const app = path.join(appHome, "app");
  const runtime = opts.runtime ?? "python";
  const scriptContent = opts.scriptContent ?? managedAppScriptContent(runtime);
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), scriptContent);
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  const marker = opts.marker === undefined ? null : opts.marker;
  if (marker !== null) {
    fs.writeFileSync(
      path.join(app, BUNDLE_MARKER),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
    );
  }
}
