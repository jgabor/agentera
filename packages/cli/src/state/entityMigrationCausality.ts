export interface CausalRelationship {
  field: string;
  target_source_identity: string | null;
  status: "resolved" | "unresolved";
}

export interface CausalMigrationEntry {
  source_identity: string;
  source_paths: string[];
  classification: string;
  proposed_target: unknown | null;
  target_sha256: string | null;
  relationships: CausalRelationship[];
  recovery: string;
}

export interface CausalBlockers {
  rootReasons: Map<string, string>;
  rootsFor: (sourceIdentity: string) => string[];
}

/**
 * Source validation identifies root corruption. Relationship validation then
 * reports its downstream effects without relabelling valid source records as
 * corrupt. A deterministic member roots an otherwise-valid cycle because the
 * cycle itself is malformed source state and has no recovery interpretation.
 */
export function applyCausalBlockers(entries: CausalMigrationEntry[], recoveryFor: (sourcePath: string) => string, rootReasons = new Map<string, string>()): CausalBlockers {
  const byIdentity = new Map(entries.map((entry) => [entry.source_identity, entry]));
  for (const entry of entries) {
    const unresolved = entry.relationships.find((relationship) => relationship.status === "unresolved");
    if (unresolved) {
      const target = unresolved.target_source_identity ?? "missing structured reference";
      rootReasons.set(entry.source_identity, `source relationship '${unresolved.field}' references unresolved target '${target}'`);
      entry.classification = "corrupt";
      entry.proposed_target = null;
      entry.target_sha256 = null;
      entry.recovery = `Repair relationship '${unresolved.field}' on '${entry.source_identity}' to reference an inventoried source identity instead of '${target}', then run ${recoveryFor(entry.source_paths[0] ?? "migration source")}`;
    }
    if (["duplicate", "conflict", "corrupt", "unsupported"].includes(entry.classification) && !rootReasons.has(entry.source_identity)) rootReasons.set(entry.source_identity, `${entry.classification} source requires explicit recovery`);
  }

  const adjacency = new Map(entries.map((entry) => [entry.source_identity, entry.relationships
    .filter((relationship) => relationship.status === "resolved" && relationship.target_source_identity && byIdentity.has(relationship.target_source_identity))
    .map((relationship) => relationship.target_source_identity as string)
    .sort()]));
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let nextIndex = 0;
  const visit = (sourceIdentity: string): void => {
    index.set(sourceIdentity, nextIndex);
    lowlink.set(sourceIdentity, nextIndex++);
    stack.push(sourceIdentity);
    onStack.add(sourceIdentity);
    for (const target of adjacency.get(sourceIdentity) ?? []) {
      if (!index.has(target)) {
        visit(target);
        lowlink.set(sourceIdentity, Math.min(lowlink.get(sourceIdentity)!, lowlink.get(target)!));
      } else if (onStack.has(target)) lowlink.set(sourceIdentity, Math.min(lowlink.get(sourceIdentity)!, index.get(target)!));
    }
    if (lowlink.get(sourceIdentity) !== index.get(sourceIdentity)) return;
    const component: string[] = [];
    while (true) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === sourceIdentity) break;
    }
    const cyclic = component.length > 1 || (adjacency.get(sourceIdentity) ?? []).includes(sourceIdentity);
    if (cyclic && !component.some((member) => rootReasons.has(member))) {
      const root = component.sort()[0]!;
      const entry = byIdentity.get(root)!;
      rootReasons.set(root, `source relationship graph contains a cycle rooted at '${root}'`);
      entry.classification = "corrupt";
      entry.proposed_target = null;
      entry.target_sha256 = null;
      entry.recovery = `Break the relationship cycle containing '${root}', then run ${recoveryFor(entry.source_paths[0] ?? "migration source")}`;
    }
  };
  for (const sourceIdentity of [...byIdentity.keys()].sort()) if (!index.has(sourceIdentity)) visit(sourceIdentity);

  const roots = new Set(rootReasons.keys());
  const memo = new Map<string, string[]>();
  const resolving = new Set<string>();
  const resolveRoots = (sourceIdentity: string): string[] => {
    if (roots.has(sourceIdentity)) return [sourceIdentity];
    const existing = memo.get(sourceIdentity);
    if (existing) return existing;
    // Every cycle has a root after the SCC pass. This guard keeps malformed
    // graph handling fail-closed if that invariant is ever changed.
    if (resolving.has(sourceIdentity)) return [];
    resolving.add(sourceIdentity);
    const resolved = [...new Set((adjacency.get(sourceIdentity) ?? []).flatMap(resolveRoots))].sort();
    resolving.delete(sourceIdentity);
    memo.set(sourceIdentity, resolved);
    return resolved;
  };
  for (const entry of entries) {
    if (roots.has(entry.source_identity)) continue;
    if (resolveRoots(entry.source_identity).length > 0) {
      entry.proposed_target = null;
      entry.target_sha256 = null;
      entry.recovery = recoveryFor(entry.source_paths[0]!);
    }
  }
  return { rootReasons, rootsFor: resolveRoots };
}
