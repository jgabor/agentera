import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import ts from "@typescript/typescript6";

import { scanBootstrapAuthority, type BootstrapAuthorityDiagnostic, type ScalarClassificationDeclaration } from "./invocationSpanPolicy.js";

export { discoverInvocationSpans, DESCRIPTIVE_GRAMMAR_PRODUCTION_COUNT, NEGATION_GRAMMAR_PRODUCTION_COUNT, normalizedScalarSha256, scanBootstrapAuthority, STABLE_COMMANDS } from "./invocationSpanPolicy.js";
export type { BootstrapAuthorityDiagnostic, BootstrapAuthorityLocation, InvocationSpan, ScalarClassificationCategory, ScalarClassificationDeclaration, ScalarClassificationKind } from "./invocationSpanPolicy.js";

export const RETIRED_STARTUP_GUIDANCE_PATTERNS = [
  ["fallback_commands", /fallback_commands/],
  ["fallback_command", /fallback_command/],
  ["fallback_only", /fallback_only/],
  ["cli_fallback", /cli_fallback/],
  ["included state families", /included state families/],
  ["included/missing state", /included\/missing state/],
  ["missing_state", /missing_state/],
  ["write_contract", /write_contract/],
  ["writer payload", /writer payload/],
  ["source_contract", /source_contract/],
  ["source contract", /source[- ]contract/i],
  ["startup_contract", /startup_contract/],
  ["complete_for_*", /complete_for_/],
] as const;

export function retiredStartupGuidanceViolations(content: string): string[] {
  return RETIRED_STARTUP_GUIDANCE_PATTERNS.filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
}

export interface BootstrapAuthorityInventoryRecord {
  path: string;
  surface: "source" | "bundle" | "generated" | "emitted";
  classification: "parsed_and_scanned" | "reason_classified";
  reason: string;
  emitted_classification?: "producer" | "non_producer";
  generated_declaration?: {
    id: string;
    path: string;
    format: string;
    classification: string;
    reason: string;
  };
}

export interface BootstrapAuthorityInventory {
  records: BootstrapAuthorityInventoryRecord[];
  diagnostics: BootstrapAuthorityDiagnostic[];
  scalarDeclarations: string[];
}

const INSTRUCTIONAL_EXTENSIONS = new Set([".md", ".json", ".yaml", ".yml"]);

export function preCutoverBootstrapAuthorityDiagnostics(relativePath: string, content: string): BootstrapAuthorityDiagnostic[] {
  return scanBootstrapAuthority(relativePath, content).diagnostics;
}

/** Compatibility projection for complete machine-emitted text guidance. */
export function preCutoverBootstrapGuidanceViolations(content: string): string[] {
  return [...new Set(scanBootstrapAuthority("<emitted>.md", content).diagnostics.map(({ violation }) => violation))];
}

/** Compatibility projection for one registry-owned source. */
export function preCutoverBootstrapAuthorityViolations(relativePath: string, content: string): string[] {
  return [...new Set(preCutoverBootstrapAuthorityDiagnostics(relativePath, content).map(({ violation }) => violation))];
}

function collectFiles(root: string, relativePath: string, files: Set<string>, diagnostics: BootstrapAuthorityDiagnostic[]): void {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) {
    diagnostics.push({
      path: relativePath,
      location: { structured_path: "$" },
      candidate: null,
      violation: "inventory_omission",
      correction: "Restore the registry-owned surface or update the registry and its inspectable classification together.",
    });
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) collectFiles(root, path.join(relativePath, entry), files, diagnostics);
  } else if (stat.isFile()) files.add(relativePath.split(path.sep).join("/"));
}

function registryRecord(root: string, packaged: boolean, override: string | undefined): Record<string, any> {
  const registryPath = path.join(root, packaged ? "bundle/references/adapters/package-registry.yaml" : "references/adapters/package-registry.yaml");
  const registry = YAML.parse(override ?? fs.readFileSync(registryPath, "utf8")) as Record<string, any>;
  const record = (registry.records as Array<Record<string, any>>)?.find((entry) => entry.identity?.id === "agentera");
  if (!record) throw new Error("package registry omits agentera bundle authority");
  return record;
}

function scalarDeclarations(record: Record<string, any>, diagnostics: BootstrapAuthorityDiagnostic[]): ScalarClassificationDeclaration[] {
  const declarations: ScalarClassificationDeclaration[] = [];
  const seen = new Set<string>();
  const reasons = new Set<string>();
  for (const entry of record.bootstrap_command_authority?.scalar_classifications ?? []) {
    const declaration = {
      path: String(entry.path ?? ""),
      region: String(entry.region ?? ""),
      category: String(entry.category ?? ""),
      classification: String(entry.classification ?? ""),
      normalized_sha256: String(entry.normalized_sha256 ?? ""),
      reason: String(entry.reason ?? ""),
    } as ScalarClassificationDeclaration;
    const key = `${declaration.path}\u0000${declaration.region}`;
    if (seen.has(key))
      diagnostics.push({
        path: declaration.path,
        location: { structured_path: declaration.region || "$" },
        candidate: null,
        violation: "scalar_classification_duplicate",
        correction: "Keep one exact classification for each path and scalar region.",
      });
    seen.add(key);
    if (declaration.reason && reasons.has(declaration.reason))
      diagnostics.push({
        path: declaration.path,
        location: { structured_path: declaration.region || "$" },
        candidate: null,
        violation: "scalar_classification_reason_duplicate",
        correction: "Give every exact scalar classification a unique scalar-specific reason.",
      });
    if (declaration.reason) reasons.add(declaration.reason);
    if (!declaration.path || !declaration.region || !["identity_only", "argument_bearing", "other_vocabulary"].includes(declaration.category) || !["bounded_descriptive", "exact_exemption"].includes(declaration.classification) || !/^[a-f0-9]{64}$/u.test(declaration.normalized_sha256)) {
      diagnostics.push({
        path: declaration.path || "references/adapters/package-registry.yaml",
        location: { structured_path: declaration.region || "$" },
        candidate: null,
        violation: "scalar_classification_malformed",
        correction: "Supply exact path, region, category, classification, normalized SHA-256, and non-empty reason fields.",
      });
    }
    declarations.push(declaration);
  }
  return declarations;
}

function discoverEmittedProducerPaths(root: string): {
  paths: Set<string>;
  diagnostics: BootstrapAuthorityDiagnostic[];
} {
  const sourceRoot = path.join(root, "packages/cli/src");
  const files: string[] = [];
  const diagnostics: BootstrapAuthorityDiagnostic[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
    }
  };
  walk(sourceRoot);
  if (files.length > 4096)
    diagnostics.push({
      path: "packages/cli/src",
      location: { structured_path: "$" },
      candidate: null,
      violation: "constructor_closure_file_limit",
      correction: "Reduce the constructor source closure below 4096 TypeScript modules or replace the bounded policy deliberately.",
    });
  const sources = new Map(files.map((file) => [file, ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)]));
  const constructorPath = path.join(sourceRoot, "cli/preCutoverCommand.ts");
  const resolveModule = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from), specifier);
    const matches = [...new Set([base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")])].filter((candidate) => sources.has(candidate));
    if (matches.length > 1) {
      diagnostics.push({
        path: path.relative(root, from).split(path.sep).join("/"),
        location: { structured_path: "$" },
        candidate: null,
        violation: "constructor_closure_ambiguous_import",
        correction: `Make ${specifier} resolve to one TypeScript module.`,
      });
    }
    return matches[0] ?? null;
  };

  const reverse = new Map<string, Set<string>>();
  let edgeCount = 0;
  for (const [file, source] of sources) {
    if (source.parseDiagnostics.length > 0)
      diagnostics.push({
        path: path.relative(root, file).split(path.sep).join("/"),
        location: { structured_path: "$" },
        candidate: null,
        violation: "constructor_module_parse_error",
        correction: `Correct the TypeScript syntax before constructor-closure validation: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, " ")}`,
      });
    const visitDynamic = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        diagnostics.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          location: { structured_path: "$" },
          candidate: null,
          violation: "constructor_closure_dynamic_consumer",
          correction: "Replace dynamic module consumption with a static import or re-export so constructor closure is inspectable.",
        });
      }
      ts.forEachChild(node, visitDynamic);
    };
    visitDynamic(source);
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveModule(file, statement.moduleSpecifier.text);
      if (!target) continue;
      const consumers = reverse.get(target) ?? new Set<string>();
      consumers.add(file);
      reverse.set(target, consumers);
      edgeCount += 1;
    }
  }
  if (edgeCount > 20_000)
    diagnostics.push({
      path: "packages/cli/src",
      location: { structured_path: "$" },
      candidate: null,
      violation: "constructor_closure_edge_limit",
      correction: "Reduce the static TypeScript import graph below 20000 edges or replace the bounded policy deliberately.",
    });

  const closure = new Set([constructorPath]);
  const pending = [constructorPath];
  while (pending.length > 0 && closure.size <= files.length + 1) {
    for (const consumer of reverse.get(pending.shift()!) ?? []) {
      if (closure.has(consumer)) continue;
      closure.add(consumer);
      pending.push(consumer);
    }
  }
  if (pending.length > 0)
    diagnostics.push({
      path: "packages/cli/src",
      location: { structured_path: "$" },
      candidate: null,
      violation: "constructor_closure_cycle_limit",
      correction: "Correct the constructor import graph so bounded closure reaches a fixed point.",
    });
  closure.delete(constructorPath);
  return {
    paths: new Set([...closure].map((file) => path.relative(root, file).split(path.sep).join("/"))),
    diagnostics,
  };
}

export function registryBootstrapAuthorityInventory(root: string, packaged = false, overrides: ReadonlyMap<string, string> = new Map()): BootstrapAuthorityInventory {
  const diagnostics: BootstrapAuthorityDiagnostic[] = [];
  const records: BootstrapAuthorityInventoryRecord[] = [];
  const registryAuthorityPath = "references/adapters/package-registry.yaml";
  const record = registryRecord(root, packaged, packaged ? undefined : overrides.get(registryAuthorityPath));
  const declarations = scalarDeclarations(record, diagnostics);
  const requireDeclarations = declarations.length > 0;
  const usedDeclarations = new Set<string>();
  const prefix = packaged ? "bundle/" : "";
  const files = new Set<string>();
  for (const entry of [...record.bundle_surfaces.directories, ...record.bundle_surfaces.files]) {
    collectFiles(root, `${prefix}${String(entry.path)}`, files, diagnostics);
  }
  for (const inventoryPath of [...files].sort()) {
    const authorityPath = packaged ? inventoryPath.slice("bundle/".length) : inventoryPath;
    const extension = path.extname(authorityPath).toLowerCase();
    if (INSTRUCTIONAL_EXTENSIONS.has(extension) || path.basename(authorityPath) === "LICENSE") {
      records.push({
        path: inventoryPath,
        surface: packaged ? "bundle" : "source",
        classification: "parsed_and_scanned",
        reason: `${extension.slice(1)} parser and invocation-span scanner`,
      });
      const content = overrides.get(authorityPath) ?? fs.readFileSync(path.join(root, inventoryPath), "utf8");
      const scan = scanBootstrapAuthority(authorityPath, content, declarations, requireDeclarations);
      diagnostics.push(...scan.diagnostics.map((item) => ({ ...item, path: inventoryPath })));
      for (const key of scan.usedDeclarations) usedDeclarations.add(key);
    } else {
      records.push({
        path: inventoryPath,
        surface: packaged ? "bundle" : "source",
        classification: "reason_classified",
        reason: "",
      });
      diagnostics.push({
        path: inventoryPath,
        location: { structured_path: "$" },
        candidate: null,
        violation: "inventory_unclassified",
        correction: "Add a non-empty path-specific exemption reason or a parse-aware scanner classification.",
      });
    }
  }
  const authorityPaths = new Set([...files].map((inventoryPath) => (packaged ? inventoryPath.slice("bundle/".length) : inventoryPath)));
  for (const declaration of declarations) {
    const key = `${declaration.path}\u0000${declaration.region}`;
    if (!authorityPaths.has(declaration.path))
      diagnostics.push({
        path: declaration.path,
        location: { structured_path: declaration.region },
        candidate: null,
        violation: "scalar_classification_path_missing",
        correction: "Remove the stale classification or restore its exact registry-owned path.",
      });
    else if (!usedDeclarations.has(key))
      diagnostics.push({
        path: declaration.path,
        location: { structured_path: declaration.region },
        candidate: null,
        violation: "scalar_classification_unused",
        correction: "Remove the stale classification or restore the exact reviewed scalar region.",
      });
  }

  for (const generated of record.bundle_surfaces.generated_files ?? []) {
    const generatedPath = String(generated.path);
    const declaration = {
      id: String(generated.id ?? ""),
      path: generatedPath,
      format: String(generated.format ?? ""),
      classification: String(generated.classification ?? ""),
      reason: String(generated.command_authority_reason ?? ""),
    };
    if (!packaged) {
      records.push({
        path: generatedPath,
        surface: "generated",
        classification: "reason_classified",
        reason: declaration.reason,
        generated_declaration: declaration,
      });
      if (!generated.command_authority_reason)
        diagnostics.push({
          path: generatedPath,
          location: { structured_path: "$" },
          candidate: null,
          violation: "generated_unclassified",
          correction: "Declare why the generated source is not scanned until package construction.",
        });
      continue;
    }
    const packagedPath = `bundle/${generatedPath}`;
    collectFiles(root, packagedPath, new Set(), diagnostics);
    records.push({
      path: packagedPath,
      surface: "generated",
      classification: "reason_classified",
      reason: declaration.reason,
      generated_declaration: declaration,
    });
    if (fs.existsSync(path.join(root, packagedPath))) {
      const scan = scanBootstrapAuthority(packagedPath, fs.readFileSync(path.join(root, packagedPath), "utf8"));
      diagnostics.push(...scan.diagnostics);
    }
  }

  const producerEntries = record.bootstrap_command_authority?.emitted_producers ?? [];
  const nonProducerEntries = record.bootstrap_command_authority?.constructor_non_producers ?? [];
  for (const producer of producerEntries)
    records.push({
      path: String(producer.path),
      surface: "emitted",
      classification: "reason_classified",
      reason: String(producer.reason ?? ""),
      emitted_classification: "producer",
    });
  for (const nonProducer of nonProducerEntries)
    records.push({
      path: String(nonProducer.path),
      surface: "emitted",
      classification: "reason_classified",
      reason: String(nonProducer.reason ?? ""),
      emitted_classification: "non_producer",
    });
  const sourceRoot = path.join(root, "packages/cli/src");
  if (!packaged && fs.existsSync(sourceRoot)) {
    const closure = discoverEmittedProducerPaths(root);
    diagnostics.push(...closure.diagnostics);
    const discovered = closure.paths;
    const declared = new Set<string>([...producerEntries, ...nonProducerEntries].map((entry: any) => String(entry.path)));
    for (const omitted of [...discovered].filter((entry) => !declared.has(entry)).sort())
      diagnostics.push({
        path: omitted,
        location: { structured_path: "$" },
        candidate: null,
        violation: "emitted_producer_omitted",
        correction: "Classify this producer in package-registry.yaml and add an output check or inspectable constructor reason.",
      });
    for (const stale of [...declared].filter((entry) => !discovered.has(entry)).sort())
      diagnostics.push({
        path: stale,
        location: { structured_path: "$" },
        candidate: null,
        violation: "emitted_producer_missing",
        correction: "Remove the stale producer classification or restore its guarded producer.",
      });
  }
  for (const producer of producerEntries) {
    if (!producer.reason)
      diagnostics.push({
        path: String(producer.path),
        location: { structured_path: "$" },
        candidate: null,
        violation: "emitted_producer_unclassified",
        correction: "Add a non-empty inspectable classification reason.",
      });
  }
  for (const nonProducer of nonProducerEntries) {
    if (!nonProducer.reason)
      diagnostics.push({
        path: String(nonProducer.path),
        location: { structured_path: "$" },
        candidate: null,
        violation: "constructor_non_producer_unclassified",
        correction: "Add a non-empty inspectable non-producer reason.",
      });
    if (producerEntries.some((producer: any) => String(producer.path) === String(nonProducer.path)))
      diagnostics.push({
        path: String(nonProducer.path),
        location: { structured_path: "$" },
        candidate: null,
        violation: "constructor_module_duplicate_classification",
        correction: "Classify each constructor-closure module exactly once.",
      });
  }
  return {
    records,
    diagnostics,
    scalarDeclarations: declarations.map((entry) => JSON.stringify(entry)).sort(),
  };
}

function normalizedInventoryRecord(record: BootstrapAuthorityInventoryRecord): string {
  if (record.surface === "generated" && record.generated_declaration) {
    return JSON.stringify({ kind: "generated", ...record.generated_declaration });
  }
  const kind = record.surface === "source" || record.surface === "bundle" ? "bundle" : record.surface;
  const logicalPath = record.surface === "bundle" || (record.surface === "generated" && record.path.startsWith("bundle/")) ? record.path.slice("bundle/".length) : record.path;
  return JSON.stringify({
    kind,
    path: logicalPath,
    classification: record.emitted_classification ?? record.classification,
    reason: record.reason,
  });
}

export function registryBootstrapAuthorityParity(
  sourceRoot: string,
  packageRoot: string,
): {
  source: string[];
  package: string[];
  diagnostics: BootstrapAuthorityDiagnostic[];
} {
  const sourceInventory = registryBootstrapAuthorityInventory(sourceRoot);
  const packageInventory = registryBootstrapAuthorityInventory(packageRoot, true);
  const source = [...new Set(sourceInventory.records.map(normalizedInventoryRecord))].sort();
  const packaged = [...new Set(packageInventory.records.map(normalizedInventoryRecord))].sort();
  const diagnostics = [...sourceInventory.diagnostics, ...packageInventory.diagnostics];
  if (JSON.stringify(sourceInventory.scalarDeclarations) !== JSON.stringify(packageInventory.scalarDeclarations))
    diagnostics.push({
      path: "references/adapters/package-registry.yaml",
      location: {
        structured_path: '$["records"][0]["bootstrap_command_authority"]["scalar_classifications"]',
      },
      candidate: null,
      violation: "package_inventory_extra_or_mismatched",
      correction: "Restore exact source/package scalar-classification parity.",
    });
  for (const missing of source.filter((entry) => !packaged.includes(entry)))
    diagnostics.push({
      path: JSON.parse(missing).path,
      location: { structured_path: "$" },
      candidate: null,
      violation: "package_inventory_missing",
      correction: `Restore the extracted-package record exactly: ${missing}`,
    });
  for (const extra of packaged.filter((entry) => !source.includes(entry)))
    diagnostics.push({
      path: JSON.parse(extra).path,
      location: { structured_path: "$" },
      candidate: null,
      violation: "package_inventory_extra_or_mismatched",
      correction: `Remove or correctly classify the unmatched extracted-package record: ${extra}`,
    });
  return { source, package: packaged, diagnostics };
}

export function registryBundledAuthorityPaths(root: string): string[] {
  return registryBootstrapAuthorityInventory(root)
    .records.filter(({ surface }) => surface === "source")
    .map(({ path: sourcePath }) => sourcePath)
    .sort();
}

export function registryBundledAuthorityViolations(root: string, overrides: ReadonlyMap<string, string> = new Map()): string[] {
  return registryBootstrapAuthorityInventory(root, false, overrides).diagnostics.map(({ path: sourcePath, violation }) => `${sourcePath}: ${violation}`);
}
