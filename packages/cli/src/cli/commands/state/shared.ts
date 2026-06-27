/**
 * Shared types and helpers for the per-state-family query modules.
 *
 * The state command family is split into one module per state
 * artifact (plan, progress, health, docs, objective, experiments,
 * todo, decisions). They all share the StateArgs/Io shape and the
 * stdout/stderr write helpers.
 */

import type { JsonObject } from "../../../core/jsonValue.js";

// thin canonical passthrough: consumers still import Dict from state/shared,
// but the single source of truth is core/jsonValue. Full re-export removal
// is tracked as a later task.
export type Dict = JsonObject;

export type Io = { out?: (t: string) => void; err?: (t: string) => void };

export interface StateArgs {
  command: string;
  topic?: string | null;
  status?: string | null;
  dimension?: string | null;
  severity?: string | null;
  limit?: number | null;
  format?: string;
  fields?: string | null;
}

export function out(io: Io): (t: string) => void {
  return io.out ?? ((t: string) => process.stdout.write(t));
}

export function err(io: Io): (t: string) => void {
  return io.err ?? ((t: string) => process.stderr.write(t));
}
