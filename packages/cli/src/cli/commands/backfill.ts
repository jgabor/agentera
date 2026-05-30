import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../../core/paths.js";
import { computeBackfill, rewriteCycleCommits } from "../../state/progressCommit.js";
import { discoverSchemasDir, loadSchemas } from "../appContext.js";
import { emitStructured } from "../structured.js";

/** Port of scripts/agentera `cmd_backfill` and its `_backfill_*` helpers. */

export interface BackfillArgs {
  project?: string | null;
  mode?: string;
  commit?: string | null;
  cycle?: number | null;
  format?: string;
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function backfillProgressPath(project: string): string {
  const schemas = loadSchemas(discoverSchemasDir());
  const info = schemas.progress;
  const rel = info && info.path ? String(info.path) : ".agentera/progress.yaml";
  return path.isAbsolute(rel) ? rel : path.join(project, rel);
}

function changesToObject(changes: Array<[number, string]>): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [n, v] of changes) obj[String(n)] = v;
  return obj;
}

function emitBackfill(payload: Record<string, any>, format: string, out: (t: string) => void): void {
  if (format === "json") {
    emitStructured(payload, "json", out);
    return;
  }
  out(`status=${payload.status} | mode=${payload.mode ?? "None"} | path=${payload.path}\n`);
  if (payload.message) out(`${payload.message}\n`);
  for (const op of payload.operations ?? []) {
    out(`- cycle=${op.cycle} | commit=${pyStr(op.commit)} | state=${op.state} | action=${op.action}\n`);
  }
  const changes = (payload.changes ?? {}) as Record<string, string>;
  const keys = Object.keys(changes);
  if (keys.length > 0) {
    const sorted = keys.sort((a, b) => Number(b) - Number(a));
    out("changes=" + sorted.map((n) => `${n}->${changes[n]}`).join(", ") + "\n");
  }
}

export function cmdBackfill(
  args: BackfillArgs,
  io: { out?: (t: string) => void; err?: (t: string) => void } = {},
): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const project = resolvePath(args.project ?? process.cwd());
  const mode = args.mode ?? "check";
  const p = backfillProgressPath(project);
  const payload: Record<string, any> = {
    command: "backfill",
    status: "ok",
    project,
    mode,
    path: p,
    operations: [],
    changes: {},
  };

  if (!fs.existsSync(p)) {
    payload.status = "noop";
    payload.message = `progress artifact not found at ${p}`;
    emitBackfill(payload, args.format ?? "text", out);
    return 0;
  }

  const text = fs.readFileSync(p, "utf8");
  const result = computeBackfill(text, {
    mode,
    targetCommit: args.commit ?? null,
    targetCycle: args.cycle ?? null,
    cwd: project,
  });
  payload.status = result.status;
  payload.operations = result.operations;
  payload.changes = changesToObject(result.changes);
  if (result.message !== null) payload.message = result.message;

  if (result.status === "fixed") {
    fs.writeFileSync(p, rewriteCycleCommits(text, new Map(result.changes)), "utf8");
  }

  emitBackfill(payload, args.format ?? "text", out);
  return result.exitCode;
}
