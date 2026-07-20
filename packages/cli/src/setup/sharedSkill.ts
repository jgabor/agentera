import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { pathExists } from "../core/paths.js";
import { declaresAgenteraSkill } from "../core/skillIdentity.js";

export const CANONICAL_SHARED_SKILL_PATH = "~/.agents/skills/agentera";

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export function diagnoseCanonicalSkill(home: string): JsonObject {
  const target = path.join(home, CANONICAL_SHARED_SKILL_PATH.slice(2));
  const skillFile = path.join(target, "SKILL.md");
  if (
    fs.existsSync(skillFile) &&
    declaresAgenteraSkill(fs.readFileSync(skillFile, "utf8").slice(0, 64 * 1024))
  ) {
    return {
      name: "canonical_skill",
      status: "pass",
      message: "canonical shared Agentera skill resolves to SKILL.md",
      source: null,
      path: target,
      gap: null,
      details: [],
    };
  }
  const details = [
    `action: install or repair the shared Agentera skill at \`${CANONICAL_SHARED_SKILL_PATH}\``,
    "action: use the Agentera CLI directly; runtime-native installation is retired",
  ];
  if (pathExists(target) || isSymlink(target)) {
    details.unshift("existing target preserved; review and repair the shared-skill path manually");
  }
  return {
    name: "canonical_skill",
    status: "warn",
    message: "canonical shared Agentera skill is missing or invalid",
    source: null,
    path: target,
    gap: "skill_path_drift",
    details,
  };
}
