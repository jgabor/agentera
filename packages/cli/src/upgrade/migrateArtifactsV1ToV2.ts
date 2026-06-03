import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import type { MigrationPhaseItem, MigrationPhase, MigrationPhaseSummary, MigrationStatus } from "./migrateArtifactsV2ToV3.js";

function emptySummary(): MigrationPhaseSummary {
  return { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0, skipped: 0 };
}

function summarizePhase(
  name: MigrationPhase["name"],
  items: MigrationPhaseItem[],
  message = "",
): MigrationPhase {
  const summary = emptySummary();
  for (const item of items) {
    summary[item.status] += 1;
  }
  let status: MigrationStatus;
  if (summary.blocked > 0) {
    status = "blocked";
  } else if (summary.failed > 0) {
    status = "failed";
  } else if (summary.pending > 0) {
    status = "pending";
  } else if (summary.applied > 0) {
    status = "applied";
  } else if (summary.skipped > 0 && summary.noop === 0 && summary.applied === 0) {
    status = "skipped";
  } else {
    status = "noop";
  }
  return { name, status, summary, items, message };
}

const AGENTERA_ARTIFACTS = [
  "PROGRESS.md",
  "DECISIONS.md",
  "HEALTH.md",
  "PLAN.md",
  "DOCS.md",
] as const;

const ROOT_ARTIFACTS = ["VISION.md"] as const;

type Parser = (text: string) => Record<string, unknown>;

function stripMdExtension(name: string): string {
  return name.replace(/\.md$/i, "").toLowerCase();
}

function extractBoldField(text: string, label: string): string {
  const pattern = new RegExp(`\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*:\\s*(.+?)(?=\\n\\*\\*|\\n\\n|\\n#|$)`, "s");
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function extractBoldFieldMultiline(text: string, label: string): string {
  const pattern = new RegExp(`\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*:\\s*(.+?)(?=\\n\\*\\*|\\n###|\\n##\\s|$)`, "s");
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function extractSection(text: string, heading: string): string {
  const pattern = new RegExp(`##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n(.*?)(?=\\n##\\s|$)`, "s");
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function parseContextEnvelope(contextText: string): Record<string, string> {
  const result: Record<string, string> = {
    intent: "",
    constraints: "",
    unknowns: "",
    scope: "",
  };
  if (!contextText) {
    return result;
  }
  for (const key of Object.keys(result)) {
    const dotted = new RegExp(`${key}\\s*\\(([^)]*)\\)\\s*·\\s*([^·]+?)(?:\\s*·|$)`, "i");
    const m1 = contextText.match(dotted);
    if (m1) {
      result[key] = `(${m1[1]}) ${m1[2].trim()}`;
      continue;
    }
    const plain = new RegExp(`${key}:\\s*([^·]+?)(?:\\s*·|$)`, "i");
    const m2 = contextText.match(plain);
    if (m2) {
      result[key] = m2[1].trim();
    }
  }
  return result;
}

function parseProgress(text: string): Record<string, unknown> {
  const warnings: string[] = [];
  const cycles: Record<string, unknown>[] = [];
  const archive: string[] = [];
  const cyclePattern = /(?:^[■□]\s+)?##\s+Cycle\s+(\d+)\s*·\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*·\s*(.+)/gm;
  const sections = text.split(/(?=^[■□]?\s*##\s+(?:Cycle\s+\d+|Archived\s+Cycles))/m);
  for (const section of sections) {
    const trimmed = section.trim();
    cyclePattern.lastIndex = 0;
    const m = cyclePattern.exec(trimmed);
    if (!m) {
      continue;
    }
    const typePrefixRaw = m[3].trim();
    const typeMatch = typePrefixRaw.match(/^(feat|fix|docs|refactor|chore|test)/);
    const commitType = typeMatch ? typeMatch[1] : "chore";
    const phase = extractBoldField(section, "Phase");
    const contextRaw = extractBoldFieldMultiline(section, "Context");
    cycles.push({
      number: Number(m[1]),
      timestamp: m[2],
      type: commitType,
      phase: phase ? phase.toLowerCase() : "build",
      what: extractBoldFieldMultiline(section, "What"),
      inspiration: extractBoldField(section, "Inspiration"),
      discovered: extractBoldField(section, "Discovered"),
      verified: extractBoldField(section, "Verified"),
      next: extractBoldField(section, "Next"),
      context: parseContextEnvelope(contextRaw),
    });
  }
  const archiveMatch = text.match(/##\s+Archived\s+Cycles\s*\n((?:- .+\n?)*)/);
  if (archiveMatch) {
    for (const line of archiveMatch[1].trim().split(/\r?\n/)) {
      const stripped = line.trim();
      if (stripped.startsWith("- ")) {
        archive.push(stripped.slice(2).trim());
      }
    }
  }
  return { cycles, archive, warnings };
}

function parseDecisions(text: string): Record<string, unknown> {
  const warnings: string[] = [];
  const decisions: Record<string, unknown>[] = [];
  const archive: string[] = [];
  const decisionPattern = /^##\s+Decision\s+(\d+)\s*·\s*(\d{4}-\d{2}-\d{2})/m;
  const sections = text.split(/(?=^##\s+(?:Decision\s+\d+|Archived\s+Decisions))/m);
  for (const section of sections) {
    const m = section.trim().match(decisionPattern);
    if (!m) {
      continue;
    }
    const number = Number(m[1]);
    const choice = extractBoldFieldMultiline(section, "Choice");
    const alternatives: Record<string, string>[] = [];
    const altBlock = section.match(/\*\*Alternatives\*\*:\s*\n(.*?)(?=\n\*\*Choice\*\*|\n\*\*Reasoning\*\*|$)/s);
    if (altBlock) {
      for (const line of altBlock[1].split(/\r?\n/)) {
        let trimmed = line.trim();
        if (!trimmed.startsWith("- ") && !trimmed.startsWith("[")) {
          continue;
        }
        if (trimmed.startsWith("- ")) {
          trimmed = trimmed.slice(2).trim();
        }
        if (!trimmed) {
          continue;
        }
        const bracket = trimmed.match(/\[([^\]]+)\]\s*,?\s*(chosen|rejected)?\s*:?\s*(.*)/);
        if (bracket?.[2]) {
          alternatives.push({ name: bracket[1], status: bracket[2], description: bracket[3].trim() });
        } else if (bracket) {
          alternatives.push({ name: bracket[1], status: "rejected", description: bracket[3].trim() });
        } else {
          const plain = trimmed.match(/([^-:\[\]]+?):\s*(.*)/);
          if (plain) {
            alternatives.push({ name: plain[1].trim(), status: "rejected", description: plain[2].trim() });
          } else {
            alternatives.push({ name: trimmed.slice(0, 60), status: "rejected", description: trimmed });
          }
        }
      }
      const choiceText = choice.toLowerCase();
      for (const alt of alternatives) {
        if (alt.status === "rejected") {
          const altKey = alt.name.toLowerCase().split(",")[0].split(":")[0].trim();
          if (altKey && choiceText.includes(altKey)) {
            alt.status = "chosen";
          }
        }
      }
    }
    if (alternatives.length === 0) {
      warnings.push(`Decision ${number}: no alternatives found`);
    } else if (!alternatives.some((a) => a.status === "chosen")) {
      warnings.push(`Decision ${number}: could not determine chosen alternative from choice text`);
    }
    const confidence = extractBoldField(section, "Confidence");
    decisions.push({
      number,
      date: m[2],
      question: extractBoldFieldMultiline(section, "Question"),
      context: extractBoldFieldMultiline(section, "Context"),
      alternatives,
      choice,
      reasoning: extractBoldFieldMultiline(section, "Reasoning"),
      confidence: ["firm", "provisional", "exploratory"].includes(confidence) ? confidence : "provisional",
      feeds_into: extractBoldField(section, "Feeds into"),
    });
  }
  const archiveMatch = text.match(/##\s+Archived\s+Decisions\s*\n((?:- .+\n?)*)/);
  if (archiveMatch) {
    for (const line of archiveMatch[1].trim().split(/\r?\n/)) {
      const stripped = line.trim();
      if (stripped.startsWith("- ")) {
        archive.push(stripped.slice(2).trim());
      }
    }
  }
  return { decisions, archive, warnings };
}

function parseFindingsSummary(raw: string): Record<string, number> {
  const result = { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 };
  if (!raw) {
    return result;
  }
  for (const key of ["critical", "warning", "info"] as const) {
    const m = raw.match(new RegExp(`(\\d+)\\s+${key}`, "i"));
    if (m) {
      result[key] = Number(m[1]);
    }
  }
  const filtered = raw.match(/(\d+)\s+filtered/i);
  if (filtered) {
    result.filtered_by_confidence = Number(filtered[1]);
  }
  return result;
}

function parseGrades(raw: string): Record<string, string> {
  const grades: Record<string, string> = {};
  if (!raw) {
    return grades;
  }
  for (const m of raw.matchAll(/([\w\s]+?)\s*\[([A-F])\]/g)) {
    const name = m[1].trim();
    if (name) {
      grades[name] = m[2];
    }
  }
  return grades;
}

function parseHealth(text: string): Record<string, unknown> {
  const warnings: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const archive: string[] = [];
  const auditPattern = /^##\s+Audit\s+(\d+)\s*·\s*(\d{4}-\d{2}-\d{2})/m;
  const sections = text.split(/(?=^##\s+(?:Audit\s+\d+|Archived\s+Audits))/m);
  for (const section of sections) {
    const m = section.trim().match(auditPattern);
    if (!m) {
      continue;
    }
    const dimensionsRaw = extractBoldField(section, "Dimensions assessed");
    audits.push({
      number: Number(m[1]),
      date: m[2],
      dimensions: dimensionsRaw ? dimensionsRaw.split(",").map((d) => d.trim()).filter(Boolean) : [],
      findings_summary: parseFindingsSummary(extractBoldField(section, "Findings")),
      trajectory: extractBoldField(section, "Overall trajectory"),
      grades: parseGrades(extractBoldField(section, "Grades")),
      dimension_details: [],
      trends: {},
      patterns: [],
    });
  }
  const archiveMatch = text.match(/##\s+Archived\s+Audits\s*\n((?:### .+\n?(?:.*\n?)*)*)/);
  if (archiveMatch) {
    for (const line of archiveMatch[1].trim().split(/\r?\n/)) {
      const stripped = line.trim();
      if (stripped.startsWith("### ")) {
        archive.push(stripped.slice(4).trim());
      }
    }
  }
  return { audits, archive, warnings };
}

function parsePlan(text: string): Record<string, unknown> {
  const warnings: string[] = [];
  const header: Record<string, unknown> = {};
  const levelMatch = text.match(/Level:\s*(light|full)/);
  header.level = levelMatch ? levelMatch[1] : "full";
  const createdMatch = text.match(/Created:\s*(\d{4}-\d{2}-\d{2})/);
  header.created = createdMatch ? createdMatch[1] : "";
  const statusMatch = text.match(/Status:\s*(active|completed)/);
  header.status = statusMatch ? statusMatch[1] : "active";
  const reviewedMatch = text.match(/Reviewed:\s*(\d{4}-\d{2}-\d{2})/);
  header.reviewed = reviewedMatch ? reviewedMatch[1] : "";
  const criticMatch = text.match(/Critic issues:\s*(.+?)\s*\|/);
  header.critic_issues = criticMatch ? criticMatch[1].trim() : "";
  const revisedMatch = text.match(/Revised:\s*(.+?)\s*\*?\s*$/m);
  header.revised = revisedMatch ? revisedMatch[1].trim() : "";
  const titleMatch = text.match(/^#\s+Plan:\s*(.+)$/m);
  header.title = titleMatch ? titleMatch[1].trim() : "";

  const scope: Record<string, string[]> = { included: [], excluded: [], deferred: [] };
  const scopeMatch = text.match(/##\s+Scope(.*?)(?=\n##\s)/s);
  if (scopeMatch) {
    const scopeText = scopeMatch[1];
    const included = scopeText.match(/\*\*In\*\*:\s*(.+?)(?=\n\*\*Out|\n\*\*Deferred|$)/s);
    if (included) {
      scope.included = included[1]
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^\*/, "").trim())
        .filter((l) => l && !l.startsWith("#"));
    }
  }

  const tasks: Record<string, unknown>[] = [];
  const taskPattern = /###\s+Task\s+([\w]+):\s*(.+)$/gm;
  const taskSections = [...text.matchAll(taskPattern)];
  for (let i = 0; i < taskSections.length; i++) {
    const tm = taskSections[i];
    const taskNumMatch = tm[1].match(/(\d+)/);
    const taskNum = taskNumMatch ? Number(taskNumMatch[1]) : 0;
    const start = (tm.index ?? 0) + tm[0].length;
    const end = i + 1 < taskSections.length ? (taskSections[i + 1].index ?? text.length) : text.length;
    const taskText = text.slice(start, end);
    const dependsRaw = extractBoldField(taskText, "Depends on");
    let dependsOn = dependsRaw ? dependsRaw.split(",").map((d) => d.trim()).filter(Boolean) : [];
    if (dependsRaw.toLowerCase() === "none") {
      dependsOn = [];
    }
    const statusRaw = extractBoldField(taskText, "Status");
    let statusVal = "pending";
    if (statusRaw.includes("complete")) {
      statusVal = "complete";
    } else if (statusRaw.includes("in_progress")) {
      statusVal = "in_progress";
    }
    const acceptance: string[] = [];
    const accMatch = taskText.match(/\*\*Acceptance\*\*:\s*\n((?:▸ .+\n?)+)/);
    if (accMatch) {
      for (const line of accMatch[1].trim().split(/\r?\n/)) {
        const stripped = line.trim();
        if (stripped.startsWith("▸ ")) {
          acceptance.push(stripped.slice(2).trim());
        }
      }
    }
    tasks.push({
      number: taskNum,
      name: tm[2].trim(),
      depends_on: dependsOn,
      status: statusVal,
      acceptance,
    });
  }

  const surprisesMatch = text.match(/##\s+Surprises\s*\n(.*?)(?:$)/s);
  return {
    header,
    what: extractSection(text, "What"),
    why: extractSection(text, "Why"),
    constraints: extractSection(text, "Constraints"),
    scope,
    design: extractSection(text, "Design"),
    tasks,
    overall_acceptance: extractSection(text, "Overall Acceptance"),
    surprises: surprisesMatch ? surprisesMatch[1].trim() : "",
    warnings,
  };
}

function parseDocs(text: string): Record<string, unknown> {
  const warnings: string[] = [];
  let lastAudit = "";
  const laMatch = text.match(/Last audit:\s*(\d{4}-\d{2}-\d{2})\s*\(([^)]+)\)/);
  if (laMatch) {
    lastAudit = `${laMatch[1]} (${laMatch[2]})`;
  }
  let docRoot = ".";
  const drMatch = text.match(/doc_root:\s*(.+)/);
  if (drMatch) {
    docRoot = drMatch[1].trim();
  }
  let style = "technical, concise";
  const stMatch = text.match(/style:\s*(.+)/);
  if (stMatch) {
    style = stMatch[1].trim();
  }
  return {
    last_audit: lastAudit,
    conventions: {
      doc_root: docRoot,
      style,
      auto_gen: ["none"],
      version_files: [] as string[],
      semver_policy: {} as Record<string, string>,
    },
    mapping: [] as Record<string, unknown>[],
    index: [] as Record<string, unknown>[],
    coverage: {} as Record<string, string>,
    audit_log: [] as Record<string, unknown>[],
    warnings,
  };
}

function parseVision(text: string): Record<string, unknown> {
  const warnings: string[] = [];
  let projectName = "";
  const nameMatch = text.match(/^#\s+(.+)$/m);
  if (nameMatch) {
    projectName = nameMatch[1].trim();
  }
  return {
    project_name: projectName,
    north_star: extractSection(text, "North Star"),
    personas: [] as Record<string, string>[],
    principles: [] as Record<string, string>[],
    direction: extractSection(text, "Direction"),
    identity: {} as Record<string, string>,
    tension: extractSection(text, "The Tension"),
    warnings,
  };
}

const PARSERS: Record<string, Parser> = {
  "PROGRESS.md": parseProgress,
  "DECISIONS.md": parseDecisions,
  "HEALTH.md": parseHealth,
  "PLAN.md": parsePlan,
  "DOCS.md": parseDocs,
  "VISION.md": parseVision,
};

function buildYaml(data: Record<string, unknown>): string {
  return YAML.stringify(data, { lineWidth: 120 });
}

export function getV1OutputPath(artifactName: string, projectDir: string): string {
  const yamlName = `${stripMdExtension(artifactName)}.yaml`;
  if (artifactName === "VISION.md") {
    return path.join(projectDir, ".agentera", "vision.yaml");
  }
  return path.join(projectDir, ".agentera", yamlName);
}

function backupPath(project: string, source: string): string {
  const backupRoot = path.join(project, ".agentera", "backup-v1");
  const rel = path.relative(project, source);
  const relParts = rel.split(path.sep);
  if (relParts.length <= 2 && (relParts[0] === "." || relParts[0] === ".agentera")) {
    return path.join(backupRoot, path.basename(source));
  }
  return path.join(backupRoot, rel);
}

function collectV1ArtifactSources(project: string): string[] {
  const root = resolvePath(project);
  const files: string[] = [];
  for (const name of AGENTERA_ARTIFACTS) {
    const p = path.join(root, ".agentera", name);
    if (isFile(p)) {
      files.push(p);
    }
  }
  for (const name of ROOT_ARTIFACTS) {
    const p = path.join(root, name);
    if (isFile(p)) {
      files.push(p);
    }
  }
  return files;
}

function relativeToProject(project: string, filePath: string): string {
  return path.relative(project, filePath);
}

export function planV1ArtifactsPhase(project: string, force = false): MigrationPhase {
  const root = resolvePath(project);
  if (!pathExists(root) || !fs.statSync(root).isDirectory()) {
    return summarizePhase("artifacts", [
      {
        status: "blocked",
        action: "validate",
        message: `project is not a directory: ${root}`,
      },
    ]);
  }

  const items: MigrationPhaseItem[] = [];
  for (const sourcePath of collectV1ArtifactSources(root)) {
    const name = path.basename(sourcePath);
    const parser = PARSERS[name];
    if (!parser) {
      items.push({
        status: "blocked",
        action: "migrate",
        source: relativeToProject(root, sourcePath),
        message: "no parser for v1 artifact",
      });
      continue;
    }
    const outputPath = getV1OutputPath(name, root);
    const backup = backupPath(root, sourcePath);
    let status: MigrationPhaseItem["status"] = "pending";
    let message = "will migrate v1 Markdown artifact to v2 YAML and archive source";
    if (isFile(outputPath)) {
      status = "noop";
      message = "v2 YAML artifact already exists";
    } else if (isFile(backup)) {
      try {
        const sameBackup = fs.readFileSync(backup).equals(fs.readFileSync(sourcePath));
        if (!sameBackup && !force) {
          status = "blocked";
          message = `backup already exists with different content: ${relativeToProject(root, backup)}`;
        }
      } catch (exc) {
        status = "blocked";
        message = `cannot compare existing backup: ${(exc as Error).message}`;
      }
    }
    if (status === "pending") {
      try {
        const text = fs.readFileSync(sourcePath, "utf8");
        const data = parser(text);
        const clean = { ...data };
        delete clean.warnings;
        buildYaml(clean);
      } catch (exc) {
        status = "blocked";
        message = `migration parser failed: ${(exc as Error).message}`;
      }
    }
    items.push({
      status,
      action: "migrate",
      source: relativeToProject(root, sourcePath),
      target: relativeToProject(root, outputPath),
      message,
    });
  }

  return summarizePhase(
    "artifacts",
    items,
    items.length === 0 ? "no v1 project artifacts found" : "",
  );
}

export function applyV1ArtifactsPhase(phase: MigrationPhase, project: string, force = false): void {
  const root = resolvePath(project);
  for (const item of phase.items) {
    if (item.status !== "pending" || !item.source || !item.target) {
      continue;
    }
    const sourcePath = path.join(root, item.source);
    const targetPath = path.join(root, item.target);
    const backup = backupPath(root, sourcePath);
    const parser = PARSERS[path.basename(sourcePath)];
    if (!parser) {
      item.status = "failed";
      item.message = "no parser for v1 artifact";
      continue;
    }
    try {
      if (isFile(backup) && !fs.readFileSync(backup).equals(fs.readFileSync(sourcePath)) && !force) {
        item.status = "blocked";
        item.message = `backup already exists with different content: ${relativeToProject(root, backup)}`;
        continue;
      }
      const data = parser(fs.readFileSync(sourcePath, "utf8"));
      delete data.warnings;
      const yamlContent = buildYaml(data);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (force || !isFile(backup)) {
        fs.copyFileSync(sourcePath, backup);
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, yamlContent, "utf8");
      fs.unlinkSync(sourcePath);
      item.status = "applied";
      item.message = "migrated and archived source";
    } catch (exc) {
      item.status = "failed";
      item.message = `migration failed: ${(exc as Error).message}`;
    }
  }
  const updated = summarizePhase("artifacts", phase.items, phase.message);
  phase.status = updated.status;
  phase.summary = updated.summary;
}
