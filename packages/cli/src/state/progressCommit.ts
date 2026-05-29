import { ancestorState } from "../core/git.js";
import { loadYamlMapping } from "../core/yaml.js";

/**
 * Shared progress-commit and git-ancestry logic. Faithful TS port of
 * `scripts/progress_commit.py`.
 */

export const COMMIT_HASH_RE = /^[0-9a-fA-F]{7,40}$/;

/**
 * Leading verifiable git hash in a cycle `commit` value, else `null`. `pending`,
 * `N/A …` and non-hash free text are exempt; non-string values return `null`.
 */
export function commitToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  const token = text.split(/\s+/)[0];
  const low = token.toLowerCase();
  if (low === "pending" || low.startsWith("n/a")) {
    return null;
  }
  return COMMIT_HASH_RE.test(token) ? token : null;
}

type ChangeMap = Map<number, string> | Record<number, string>;

function changeHas(changes: ChangeMap, key: number): boolean {
  return changes instanceof Map ? changes.has(key) : Object.prototype.hasOwnProperty.call(changes, key);
}

function changeGet(changes: ChangeMap, key: number): string {
  return changes instanceof Map ? (changes.get(key) as string) : (changes as Record<number, string>)[key];
}

function changeSize(changes: ChangeMap): number {
  return changes instanceof Map ? changes.size : Object.keys(changes).length;
}

function splitKeepEnds(text: string): string[] {
  const matches = text.match(/[^\n]*\n|[^\n]+/g);
  return matches ?? [];
}

/**
 * Replace the `commit:` field of specific cycles, preserving the rest. `changes`
 * maps cycle number to the new `commit` value. Multi-line commit scalars are
 * replaced wholesale, dropping their continuation lines.
 */
export function rewriteCycleCommits(text: string, changes: ChangeMap): string {
  if (changeSize(changes) === 0) {
    return text;
  }
  const numberRe = /^-\s+number:\s*(\d+)\s*$/;
  const listItemRe = /^-\s/;
  const commitRe = /^(\s+)commit:\s*.*$/;
  const topKeyRe = /^[A-Za-z_]/;
  const lines = splitKeepEnds(text);
  const out: string[] = [];
  let inCycles = false;
  let current: number | null = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    const body = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (topKeyRe.test(body)) {
      inCycles = body.startsWith("cycles:");
      current = null;
      out.push(line);
      i += 1;
      continue;
    }
    if (inCycles) {
      const numberMatch = numberRe.exec(body);
      if (numberMatch) {
        current = parseInt(numberMatch[1], 10);
        out.push(line);
        i += 1;
        continue;
      }
      if (listItemRe.test(body)) {
        current = null;
        out.push(line);
        i += 1;
        continue;
      }
      const commitMatch = commitRe.exec(body);
      if (commitMatch && current !== null && changeHas(changes, current)) {
        const indent = commitMatch[1];
        const keyIndent = indent.length;
        const newline = line.endsWith("\n") ? "\n" : "";
        out.push(`${indent}commit: ${changeGet(changes, current)}${newline}`);
        i += 1;
        while (i < total) {
          const cont = lines[i].endsWith("\n") ? lines[i].slice(0, -1) : lines[i];
          if (!cont.trim()) {
            break;
          }
          const leading = (cont.match(/^ */)?.[0].length) ?? 0;
          if (leading > keyIndent && !listItemRe.test(cont)) {
            i += 1;
            continue;
          }
          break;
        }
        current = null;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join("");
}

export interface BackfillOperation {
  cycle: number;
  commit: unknown;
  state: string;
  action: string;
}

export interface BackfillResult {
  status: string;
  exitCode: number;
  operations: BackfillOperation[];
  /** Descending-by-cycle ordered list of cycle->value rewrites. */
  changes: Array<[number, string]>;
  message: string | null;
}

export interface BackfillOptions {
  mode?: string;
  targetCommit?: string | null;
  targetCycle?: number | null;
  cwd?: string;
}

/**
 * Classify progress cycle commits and decide the backfill outcome. Pure with
 * respect to the artifact: parses `text` and inspects git ancestry but never
 * reads or writes the progress file.
 */
export function computeBackfill(text: string, options: BackfillOptions = {}): BackfillResult {
  const mode = options.mode ?? "check";
  const targetCommit = options.targetCommit ?? null;
  let targetCycle = options.targetCycle ?? null;
  const cwd = options.cwd ?? ".";

  let data: Record<string, unknown>;
  try {
    data = loadYamlMapping(text);
  } catch (exc) {
    return {
      status: "error",
      exitCode: 2,
      operations: [],
      changes: [],
      message: `cannot parse progress artifact: ${(exc as Error).message}`,
    };
  }
  const cyclesRaw = data && typeof data === "object" ? (data as Record<string, unknown>).cycles : null;
  if (!Array.isArray(cyclesRaw)) {
    return {
      status: "noop",
      exitCode: 0,
      operations: [],
      changes: [],
      message: "progress artifact has no cycles list",
    };
  }

  if (ancestorState("HEAD", cwd) === "unavailable") {
    return {
      status: "noop",
      exitCode: 0,
      operations: [],
      changes: [],
      message: "git HEAD unavailable; cannot verify commit ancestry",
    };
  }

  const fullCycles: Array<[number, unknown]> = [];
  for (const c of cyclesRaw) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const num = (c as Record<string, unknown>).number;
      if (typeof num === "number" && Number.isInteger(num)) {
        fullCycles.push([num, (c as Record<string, unknown>).commit]);
      }
    }
  }

  let targetToken: string | null = null;
  if (targetCommit) {
    const trimmed = targetCommit.trim();
    targetToken = trimmed ? trimmed.split(/\s+/)[0] : "";
    const state = targetToken ? ancestorState(targetToken, cwd) : "unknown";
    if (state !== "ancestor") {
      return {
        status: "error",
        exitCode: 2,
        operations: [],
        changes: [],
        message:
          `refusing to backfill commit '${targetCommit}': it is ${state} relative to HEAD. ` +
          "Backfill only a commit already in HEAD's history; commit the product change first, " +
          "then backfill from a later commit (never amend to backfill).",
      };
    }
    const known = new Set(fullCycles.map(([n]) => n));
    if (targetCycle !== null && !known.has(targetCycle)) {
      return {
        status: "error",
        exitCode: 2,
        operations: [],
        changes: [],
        message: `cycle ${targetCycle} not found in progress cycles`,
      };
    }
    if (targetCycle === null) {
      targetCycle =
        fullCycles.find(([, cv]) => {
          const tok = commitToken(cv);
          return tok === null || ancestorState(tok ?? "", cwd) === "stale";
        })?.[0] ?? null;
    }
    if (targetCycle === null) {
      return {
        status: "noop",
        exitCode: 0,
        operations: [],
        changes: [],
        message: "no pending or stale cycle to backfill; pass --cycle N to target one",
      };
    }
  }

  const changes = new Map<number, string>();
  const operations: BackfillOperation[] = [];
  for (const [number, commitValue] of fullCycles) {
    if (number === targetCycle && targetToken) {
      let action = "set-commit";
      let state = "ancestor";
      if (commitToken(commitValue) === targetToken) {
        action = "none";
        state = "ancestor";
      } else {
        changes.set(number, targetToken);
      }
      operations.push({ cycle: number, commit: targetToken, state, action });
      continue;
    }
    const token = commitToken(commitValue);
    if (token === null) {
      operations.push({ cycle: number, commit: commitValue, state: "exempt", action: "none" });
      continue;
    }
    const state = ancestorState(token, cwd);
    if (state === "stale") {
      changes.set(number, "pending");
      operations.push({ cycle: number, commit: token, state: "stale", action: "reset-to-pending" });
    } else {
      operations.push({ cycle: number, commit: token, state, action: "none" });
    }
  }

  const sortedChanges: Array<[number, string]> = [...changes.entries()].sort((a, b) => b[0] - a[0]);
  if (changes.size === 0) {
    return { status: "clean", exitCode: 0, operations, changes: sortedChanges, message: null };
  }
  if (mode === "fix") {
    return { status: "fixed", exitCode: 0, operations, changes: sortedChanges, message: null };
  }
  return { status: "action-needed", exitCode: 1, operations, changes: sortedChanges, message: null };
}

/**
 * Flag progress cycle `commit` hashes that are not ancestors of HEAD. Faithful
 * port of progress_commit.validate_progress_commits.
 */
export function validateProgressCommits(content: string, cwd: string = "."): string[] {
  let data: Record<string, unknown>;
  try {
    data = loadYamlMapping(content);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }
  const cycles = (data as Record<string, unknown>).cycles;
  if (!Array.isArray(cycles)) {
    return [];
  }
  if (ancestorState("HEAD", cwd) === "unavailable") {
    return [];
  }
  const violations: string[] = [];
  for (const entry of cycles) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const raw = (entry as Record<string, unknown>).commit;
    if (typeof raw !== "string") {
      continue;
    }
    const token = commitToken(raw);
    if (token === null) {
      continue;
    }
    if (ancestorState(token, cwd) === "stale") {
      const number = (entry as Record<string, unknown>).number ?? "?";
      violations.push(
        `progress: cycle ${number} commit '${token}' is not an ancestor of HEAD ` +
          "(stale or self-referential); set it to `pending` or run " +
          "`agentera check backfill --mode fix`, then forward-fill the product commit " +
          "(never amend to backfill)",
      );
    }
  }
  return violations;
}
