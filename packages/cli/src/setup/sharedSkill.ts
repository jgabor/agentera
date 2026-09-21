import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { resolveDoctorInstallRoot } from "../upgrade/appModel.js";
import { commandText } from "../upgrade/upgradeCommands.js";
import { observeLifecyclePath, secureLifecycleRemovalAvailable } from "../runtime/lifecyclePublication.js";
import { hostSkillPath, isCompatibleHostSkill, loadHostSkillSource, runHostSkillLifecycle } from "./hostSkillLifecycle.js";

export const CANONICAL_SHARED_SKILL_PATH = "~/.agents/skills/agentera";

export function diagnoseCanonicalSkill(home: string, options: { sourceRoot?: string; appHome?: string; env?: Record<string, string | undefined> } = {}): JsonObject {
  home = path.resolve(home);
  const target = hostSkillPath(home);
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  let shape = "missing";
  let compatibility = "unknown";
  let runtimeHealth = "available";
  let freshness = "unknown";
  let ownership = "not_inspected";
  let message = "canonical shared Agentera bootstrap is missing";
  const details: string[] = [];
  let upgradeOffer: JsonObject | null = null;
  let source: ReturnType<typeof loadHostSkillSource> | undefined;
  try {
    source = loadHostSkillSource(sourceRoot);
  } catch {
    runtimeHealth = "invalid_host_authority";
    details.push("Repair the selected CLI distribution/runtime authority; host installation cannot repair package bytes.");
  }
  try {
    const observed = observeLifecyclePath(target, [path.parse(path.resolve(home)).root]);
    if (observed.unsafeReason) shape = "unsafe_path";
    else if (observed.kind === "symlink") shape = "legacy_symlink";
    else if (observed.kind === "directory") {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const skill = entries.find((entry) => entry.name === "SKILL.md");
      shape = entries.length !== 1 ? "extra_entries" : skill?.isFile() && fs.lstatSync(path.join(target, "SKILL.md")).nlink === 1 ? "one_file" : "invalid_bootstrap";
      if (shape === "one_file") {
        const text = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
        compatibility = isCompatibleHostSkill(text) ? "compatible" : "incompatible";
        freshness = source ? (text === source.content ? "current" : "stale") : "unknown";
      }
    } else if (observed.kind !== "missing") shape = "wrong_type";
    if (source) {
      const [appHome] = resolveDoctorInstallRoot(options.appHome ?? null, {
        home,
        sourceRoot,
        env: options.env,
      });
      const preview = runHostSkillLifecycle({
        home,
        appHome,
        sourceRoot,
        apply: false,
      });
      ownership = preview.status === "non_success" ? "blocked" : shape === "missing" ? "absent" : "owned";
      if (ownership === "blocked") details.push(preview.reason);
      if (shape !== "missing" && preview.status === "pending" && "authorization" in preview && typeof preview.authorization === "string") {
        if (secureLifecycleRemovalAvailable())
          upgradeOffer = {
            question: "Agentera’s installed skill needs an update. Update it now? Your project files will not change.",
            approval: "explicit_yes_only",
            apply_command: commandText(["npx", "-y", "agentera@next", "upgrade", "--shared-skill", "--home", home, "--install-root", appHome, "--yes", "--authorization", preview.authorization]),
          };
        else details.push("Shared-skill updates require Linux safe publication; no update was offered or applied.");
      }
    }
    message = `canonical shared Agentera bootstrap: ${shape}; compatibility: ${compatibility}; freshness: ${freshness}`;
  } catch {
    shape = "unsafe_path";
    message = "canonical shared Agentera bootstrap cannot be safely inspected";
  }
  const healthy = shape === "one_file" && compatibility === "compatible" && freshness === "current" && runtimeHealth === "available" && ownership !== "blocked";
  if (!healthy && !upgradeOffer) details.push("No supported update is offered. Nothing changed; do not broaden approval or move files manually.");
  const previewCommand = commandText(["npx", "-y", "agentera@next", "upgrade", "--shared-skill", "--home", home, ...(options.appHome ? ["--install-root", options.appHome] : []), "--dry-run"]);
  return {
    name: "canonical_skill",
    status: healthy ? "pass" : "warn",
    message,
    source: null,
    path: target,
    gap: healthy ? null : "skill_path_drift",
    shape,
    compatibility,
    freshness,
    ownership,
    runtime_authority: runtimeHealth,
    preview_command: previewCommand,
    details,
    upgrade_offer: healthy ? null : upgradeOffer,
  };
}
