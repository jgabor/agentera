import path from "node:path";

/** Structural validation shared by static CLI discovery and the source lane reader.
 * The YAML policy remains the authority; this function does not run any owner.
 * Callers supply parsed own-data YAML, not arbitrary executable objects.
 */
export function verificationPolicyErrors(policy: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const issue = (message: string) => {
    if (issues.length < 100) issues.push(message);
  };
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issue(`${label} must be one object`);
      return {};
    }
    return value as Record<string, unknown>;
  };
  const array = (value: unknown, label: string): unknown[] => {
    if (!Array.isArray(value)) {
      issue(`${label} must be an array`);
      return [];
    }
    return value;
  };
  const string = (value: unknown, label: string) => {
    if (typeof value !== "string" || !value.length) issue(`${label} must be a nonempty string`);
  };
  const required = (value: Record<string, unknown>, field: string, label: string) => {
    if (!Object.hasOwn(value, field)) issue(`${label}.${field} is missing`);
    return value[field];
  };
  const strings = (value: unknown, label: string) => {
    for (const [key, entry] of Object.entries(object(value, label))) {
      string(key, `${label} key`);
      string(entry, `${label}.${key}`);
    }
  };
  const inventory = object(required(policy, "inventory", "verification"), "verification.inventory");
  for (const field of ["root", "suffix"]) string(required(inventory, field, "verification.inventory"), `verification.inventory.${field}`);
  if (inventory.default_owner !== undefined && inventory.default_owner !== null) string(inventory.default_owner, "verification.inventory.default_owner");
  for (const [index, rule] of array(required(inventory, "rules", "verification.inventory"), "verification.inventory.rules").entries()) {
    const label = `verification.inventory.rules[${index}]`;
    const entry = object(rule, label);
    string(required(entry, "owner", label), `${label}.owner`);
    for (const field of ["path", "prefix"]) if (entry[field] !== undefined) string(entry[field], `${label}.${field}`);
    if (entry.evidence_producer !== undefined && typeof entry.evidence_producer !== "boolean") issue(`${label}.evidence_producer must be a boolean`);
  }
  for (const [owner, definition] of Object.entries(object(required(policy, "owners", "verification"), "verification.owners"))) {
    const label = `verification.owners.${owner}`;
    const entry = object(definition, label);
    for (const field of ["config", "correction"]) string(required(entry, field, label), `${label}.${field}`);
    if (entry.forwarding !== undefined) {
      const forwarding = object(entry.forwarding, `${label}.forwarding`);
      for (const field of ["safe_options", "forbidden_options"]) strings(forwarding[field] ?? {}, `${label}.forwarding.${field}`);
    }
    if (entry.integration !== undefined) {
      const integration = object(entry.integration, `${label}.integration`);
      string(required(integration, "path", `${label}.integration`), `${label}.integration.path`);
      for (const [index, command] of array(required(integration, "command", `${label}.integration`), `${label}.integration.command`).entries()) string(command, `${label}.integration.command[${index}]`);
    }
    if (entry.execution !== undefined) {
      const execution = object(entry.execution, `${label}.execution`);
      for (const field of ["workers", "wall_time_budget_ms"]) {
        const value = execution[field];
        if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) issue(`${label}.execution.${field} must be a positive safe integer`);
      }
    }
    if (entry.evidence !== undefined) {
      const evidence = object(entry.evidence, `${label}.evidence`);
      for (const field of ["schema_version", "authority", "stdout_format"]) string(required(evidence, field, `${label}.evidence`), `${label}.evidence.${field}`);
      const maxBytes = required(evidence, "max_utf8_bytes", `${label}.evidence`);
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1) issue(`${label}.evidence.max_utf8_bytes must be a positive safe integer`);
    }
  }
  for (const [index, mixed] of array(required(policy, "mixed_files", "verification"), "verification.mixed_files").entries()) {
    const label = `verification.mixed_files[${index}]`;
    const entry = object(mixed, label);
    for (const field of ["path", "primary_owner", "separation_target"]) string(required(entry, field, label), `${label}.${field}`);
  }
  for (const [name, owners] of Object.entries(object(required(policy, "policies", "verification"), "verification.policies"))) {
    for (const [index, owner] of array(owners, `verification.policies.${name}`).entries()) string(owner, `verification.policies.${name}[${index}]`);
  }
  if (policy.conservative_routing !== undefined) {
    const routing = object(policy.conservative_routing, "verification.conservative_routing");
    for (const field of ["exact", "prefixes"]) {
      for (const [index, entry] of array(routing[field] ?? [], `verification.conservative_routing.${field}`).entries()) string(entry, `verification.conservative_routing.${field}[${index}]`);
    }
  }
  return issues;
}

/** Closed pending-assertion contract; no source AST verifier is loaded here. */
export function verificationPendingContract(value: unknown, render: (value: unknown) => string = String) {
  const issues: string[] = [];
  const mapping = (value: unknown, keys: string[], label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`${label} must be one object`);
      return {};
    }
    for (const key of Object.keys(value)) if (!keys.includes(key)) issues.push(`${label} has unsupported key ${render(key)}`);
    for (const key of keys) if (!Object.hasOwn(value, key)) issues.push(`${label}.${key} is missing`);
    return value as Record<string, unknown>;
  };
  const overlap = mapping(value, ["max_diagnostic_utf8_bytes", "allowed_pending_assertion"], "overlap");
  const declaration = mapping(overlap.allowed_pending_assertion, ["owner", "path", "suite", "title", "status", "executes_when"], "overlap.allowed_pending_assertion");
  const execution = mapping(declaration.executes_when, ["platform"], "overlap.allowed_pending_assertion.executes_when");
  const maxDiagnosticBytes = overlap.max_diagnostic_utf8_bytes as number;
  const fields = {
    owner: declaration.owner as string,
    path: declaration.path as string,
    suite: declaration.suite as string,
    title: declaration.title as string,
    status: declaration.status as string,
    executesOn: execution.platform as string,
  };
  const expected = {
    owner: "source",
    path: "packages/cli/test/build/generatedOutputPublication.test.ts",
    suite: "generated generation publication",
    title: "reads one real Darwin process identity independently of caller locale and timezone",
    status: "skipped",
    executesOn: "darwin",
  };
  if (!Number.isSafeInteger(maxDiagnosticBytes) || maxDiagnosticBytes < 1024 || maxDiagnosticBytes > 8192) issues.push(`overlap.max_diagnostic_utf8_bytes=${render(maxDiagnosticBytes)} must be a safe integer from 1024 through 8192`);
  for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
    if (fields[field] !== expected[field]) issues.push(`${field}=${render(fields[field])}; expected ${render(expected[field])}`);
  }
  if (fields.path === expected.path && (path.isAbsolute(fields.path) || path.posix.normalize(fields.path) !== fields.path || fields.path.includes(".."))) issues.push(`path=${render(fields.path)} must be the canonical repository-relative source path`);
  return {
    issues,
    authority: Object.freeze({
      ...fields,
      name: `${fields.suite} ${fields.title}`,
      maxDiagnosticBytes,
    }),
  };
}
