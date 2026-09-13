import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

export const MANAGED_APP_SCRIPT_PATH = path.join("app", "scripts", "agentera");

/** Source invocation owns the app; these tests need only an empty default user-state root. */
export function useSourceAppHome(): void {
  let home: string;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-source-home-"));
    const env = {
      HOME: home,
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      AGENTERA_HOME: undefined,
      AGENTERA_DEFAULT_INSTALL_ROOT: undefined,
      AGENTERA_PROFILE_DIR: undefined,
      OPENCODE_CONFIG_DIR: undefined,
    };
    previous = {};
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.mkdirSync(platformDefaultAppHome(home), { recursive: true });
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
}

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
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }));
  const marker = opts.marker === undefined ? null : opts.marker;
  if (marker !== null) {
    fs.writeFileSync(path.join(app, BUNDLE_MARKER), JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }));
  }
}
