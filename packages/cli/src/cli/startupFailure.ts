import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expanduser } from "../core/paths.js";
import { BOOTSTRAP_SOURCE_ROOT_ENV, BootstrapSourceMissingError, bootstrapSourceMissing, NPX_BUNDLE_SENTINEL, resolveSourceRoot } from "../core/sourceRoot.js";
import type { SuiteVersionFailureReason } from "../upgrade/appModel.js";

/**
 * Typed failure for a CLI that cannot start or cannot trust its own bundled
 * authority. The executable entry point uses it before dispatch exists, so this
 * module must stay free of authority loads at import time.
 */

export const STARTUP_FAILURE_SCHEMA = "agentera.startupFailure.v1";
export const STARTUP_FAILURE_EXIT_CODE = 1;

export type RuntimeAuthorityFaultReason = "missing" | "unreadable" | "malformed" | "invalid";

export type StartupFailure = { classification: "runtime_authority_unavailable"; reason: RuntimeAuthorityFaultReason } | { classification: "bootstrap_source_missing"; reason: "missing"; root: string; missing: string[] } | { classification: "version_authority_invalid"; reason: SuiteVersionFailureReason };

export interface StartupFailureEnvelope {
  schemaVersion: typeof STARTUP_FAILURE_SCHEMA;
  status: "fail";
  command: string | null;
  classification: StartupFailure["classification"];
  reason: StartupFailure["reason"];
  message: string;
  recovery: string;
  state_changed: false;
}

type Env = Record<string, string | undefined>;

function runtimeAuthorityFaultReason(error: unknown): RuntimeAuthorityFaultReason {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "missing";
  if (typeof code === "string" && ["EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP"].includes(code)) return "unreadable";
  if ((error as { name?: unknown } | null)?.name === "YAMLParseError" || error instanceof SyntaxError) return "malformed";
  return "invalid";
}

/**
 * The bootstrap source the runtime would use, when it lacks required entries.
 * An incomplete packaged bundle makes source-root resolution fall through to
 * an unrelated root, so the sibling bundle is checked before the resolved root.
 */
export function bootstrapSourceFailure(env: Env = process.env): BootstrapSourceMissingError | null {
  const configured = env[BOOTSTRAP_SOURCE_ROOT_ENV];
  const candidates: string[] = [];
  if (configured) candidates.push(path.resolve(expanduser(configured)));
  else {
    const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bundle");
    if (fs.existsSync(path.join(bundled, NPX_BUNDLE_SENTINEL))) candidates.push(bundled);
    candidates.push(resolveSourceRoot(env));
  }
  for (const root of candidates) {
    const missing = bootstrapSourceMissing(root);
    if (missing.length > 0) return new BootstrapSourceMissingError(root, missing);
  }
  return null;
}

/** Classify a fault raised while loading the CLI's own modules and authorities. */
export function classifyStartupError(error: unknown, env: Env = process.env): StartupFailure {
  const source = error instanceof BootstrapSourceMissingError ? error : bootstrapSourceFailure(env);
  if (source) return { classification: "bootstrap_source_missing", reason: "missing", root: source.root, missing: source.missing };
  return { classification: "runtime_authority_unavailable", reason: runtimeAuthorityFaultReason(error) };
}

export function startupFailureEnvelope(failure: StartupFailure, command: string | null, env: Env = process.env): StartupFailureEnvelope {
  let message: string;
  if (failure.classification === "bootstrap_source_missing") {
    message = `The Agentera bootstrap source ${failure.root} is missing ${failure.missing.join(", ")}.`;
  } else if (failure.classification === "version_authority_invalid") {
    message = `The Agentera CLI cannot read its own version (${failure.reason}).`;
  } else {
    message = `A bundled Agentera runtime authority is ${failure.reason}, so the CLI could not start.`;
  }
  const recovery = env[BOOTSTRAP_SOURCE_ROOT_ENV] ? `Point ${BOOTSTRAP_SOURCE_ROOT_ENV} at a complete Agentera bundle or unset it, then retry; no state was changed.` : "Restore or reinstall the Agentera CLI package so its bundled files are intact, then retry; no state was changed.";
  return {
    schemaVersion: STARTUP_FAILURE_SCHEMA,
    status: "fail",
    command,
    classification: failure.classification,
    reason: failure.reason,
    message,
    recovery,
    state_changed: false,
  };
}

/** Write one JSON startup failure to stdout; operational output is JSON only. */
export function emitStartupFailure(io: { out?: (text: string) => void }, failure: StartupFailure, command: string | null, env: Env = process.env): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  out(JSON.stringify(startupFailureEnvelope(failure, command, env)) + "\n");
  return STARTUP_FAILURE_EXIT_CODE;
}
