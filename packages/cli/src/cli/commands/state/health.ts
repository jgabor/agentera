/**
 * `state health` query (HEALTH.md / health.yaml audits).
 *
 * Surfaces the latest health audit by `number`, optionally filtered
 * by dimension (a grade key or a dimensions_detail.name substring).
 */

import {
  asList,
  emitStateStructured,
  extractEntries,
  loadArtifact,
  missingSchemaError,
  sourceMetadata,
  structuredState,
} from "../../stateQuery.js";
import { SchemaInfo, artifactPath } from "../../appContext.js";
import { out, err, StateArgs, Io } from "./shared.js";

type Dict = Record<string, any>;

export function healthAuditNumber(entry: Dict): number | null {
  const number = entry.number;
  if (typeof number === "number" && Number.isInteger(number)) return number;
  if (typeof number === "string" && /^\d+$/.test(number)) return parseInt(number, 10);
  return null;
}

export function latestHealthAudit(entries: Dict[]): Dict | null {
  if (entries.length === 0) return null;
  let best: Dict | null = null;
  let bestNumber = -1;
  for (const entry of entries) {
    const number = healthAuditNumber(entry);
    if (number === null) continue;
    if (number > bestNumber) {
      bestNumber = number;
      best = entry;
    }
  }
  return best !== null ? best : entries[entries.length - 1];
}

export function queryHealth(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.health;
  if (!info) {
    e(missingSchemaError("health") + "\n");
    return 1;
  }
  const p = artifactPath(info, "health");
  const data = loadArtifact(p);
  const entries = extractEntries(data);
  const dimension = args.dimension ?? null;
  let latest = latestHealthAudit(entries);
  let latestEntries = latest ? [latest] : [];
  if (dimension && latestEntries.length > 0) {
    latest = latestEntries[0];
    const dimLower = dimension.toLowerCase();
    let matched = false;
    const grades = latest.grades;
    if (grades && typeof grades === "object" && !Array.isArray(grades)) {
      matched = Object.keys(grades).some((gk) => String(gk).toLowerCase().includes(dimLower));
    }
    const details = latest.dimensions_detail;
    if (Array.isArray(details)) {
      matched =
        matched ||
        details.some((d) => d && typeof d === "object" && String(d.name ?? "").toLowerCase().includes(dimLower));
    }
    if (!matched) latestEntries = [];
  }

  const format = args.format ?? "text";
  if (format !== "text") {
    return emitStateStructured(
      "health",
      structuredState("health", latestEntries, sourceMetadata("health", p), {
        filters: { dimension },
        summary: { latest_only: true },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  if (entries.length === 0) return 0;
  latest = latestHealthAudit(entries);
  if (!latest) return 0;
  if (dimension) {
    const dimLower = dimension.toLowerCase();
    const grades = (latest.grades ?? {}) as Dict;
    let matched = false;
    for (const [gk, gv] of Object.entries(grades)) {
      if (String(gk).toLowerCase().includes(dimLower)) {
        o(`${gk}: ${gv}\n`);
        matched = true;
      }
    }
    const details = asList(latest.dimensions_detail);
    for (const d of details) {
      const dn = String(d.name ?? "");
      if (dn.toLowerCase().includes(dimLower)) {
        const summary = d.summary ?? "";
        if (summary) o(`  ${summary}\n`);
        for (const f of asList(d.findings)) {
          o(`  [${f.severity ?? ""}] ${f.heading ?? ""}\n`);
        }
        matched = true;
      }
    }
    if (!matched) return 0;
  } else {
    const num = latest.number ?? "?";
    const traj = latest.trajectory ?? "";
    o(`Audit ${num}: ${traj}\n`);
    const grades = (latest.grades ?? {}) as Dict;
    for (const [gk, gv] of Object.entries(grades)) {
      o(`  ${gk}: ${gv}\n`);
    }
  }
  return 0;
}
