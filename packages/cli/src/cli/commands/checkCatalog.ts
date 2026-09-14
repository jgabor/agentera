/** Static dispatch vocabulary shared with execution, without importing executors. */
export const VALIDATE_FAMILY_NAMES = ["cross-capability", "app-home-contract", "vocabularyAuthority", "retained-references", "activation-conjunction", "selfAudit", "release-metadata", "capability", "capability-contract", "artifact", "state"] as const;
export const VERIFY_FAMILIES = ["eval"] as const;
export const RETIRED_VERIFY_FAMILIES = ["smoke"] as const;
export const VERIFY_TARGETS: Record<string, string[]> = {
  eval: ["skills", "semantic", "routing", "glossary"],
};
