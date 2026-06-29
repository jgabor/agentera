/**
 * Test corpus for the Layer 3-4 routing engine. Three inputs per
 * capability (36 total) for clean-route accuracy, 5 adversarial
 * disambiguation inputs that match multiple capabilities within the
 * borderline band, and 5 adversarial fallback inputs that match no
 * triggers. The corpus is a pure data module so tests can import it by
 * reference.
 *
 * Spec: references/cli/trigger-schema-enrichment.md (§3-§5).
 */

export interface CorpusEntry {
  readonly input: string;
  readonly expected: string; // expected route.capability
}

/**
 * 36 capability inputs (3 per capability). Each input is a natural-language
 * phrase that should cleanly route to exactly one capability (no
 * disambiguation, no fallback) under the §3 scoring algorithm. The phrases
 * lean on the capability name where the T1 direct-invocation trigger is the
 * highest-confidence signal — this mirrors how `prime --route` is expected
 * to behave for unambiguous capability-stating requests.
 */
export const CORPUS: readonly CorpusEntry[] = [
  // status (3)
  { input: "show me the project status", expected: "status" },
  { input: "hello, onboard me to this project", expected: "status" },
  { input: "give me a status dashboard", expected: "status" },

  // vision (3)
  { input: "create a vision for this project", expected: "vision" },
  { input: "set the north star vision", expected: "vision" },
  { input: "rethink the vision for this product", expected: "vision" },

  // discuss (3)
  { input: "discuss this idea with me", expected: "discuss" },
  { input: "let's discuss the tradeoffs", expected: "discuss" },
  { input: "discuss and brainstorm this", expected: "discuss" },

  // research (3)
  { input: "research this library for patterns", expected: "research" },
  { input: "research the applicability of this approach", expected: "research" },
  { input: "research how this repo compares", expected: "research" },

  // plan (3)
  { input: "plan the next feature", expected: "plan" },
  { input: "write a plan for this work", expected: "plan" },
  { input: "break this into a plan", expected: "plan" },

  // build (3)
  { input: "build the next feature now", expected: "build" },
  { input: "keep building this project", expected: "build" },
  { input: "start building the dashboard", expected: "build" },

  // optimize (3)
  { input: "optimize the bundle size", expected: "optimize" },
  { input: "optimize performance and latency", expected: "optimize" },
  { input: "optimize and benchmark the metric", expected: "optimize" },

  // audit (3)
  { input: "audit the codebase for technical debt", expected: "audit" },
  { input: "audit code quality and architecture", expected: "audit" },
  { input: "audit the dependency check", expected: "audit" },

  // document (3)
  { input: "document this and write docs", expected: "document" },
  { input: "document this work first", expected: "document" },
  { input: "document the README first", expected: "document" },

  // profile (3)
  { input: "profile my decision history", expected: "profile" },
  { input: "profile and validate my patterns", expected: "profile" },
  { input: "profile my decision-making", expected: "profile" },

  // design (3)
  { input: "design the visual identity system", expected: "design" },
  { input: "design tokens and DESIGN.md", expected: "design" },
  { input: "design the aesthetic of the app", expected: "design" },

  // orchestrate (3)
  { input: "orchestrate multi-cycle execution", expected: "orchestrate" },
  { input: "orchestrate the whole plan autonomously", expected: "orchestrate" },
  { input: "orchestrate run the plan to completion", expected: "orchestrate" },
];

/**
 * Adversarial disambiguation inputs. Each matches 2+ capability triggers
 * within the borderline band — the engine must return disambiguation
 * candidates rather than a single match.
 */
export const DISAMBIGUATION_INPUTS: readonly string[] = [
  "refine the vision",
  "audit the design",
  "optimize the plan",
  "document the audit",
  "research the plan",
];

/**
 * Adversarial fallback inputs. None of these match any capability's trigger
 * patterns, so the engine must return fallback to status.
 */
export const FALLBACK_INPUTS: readonly string[] = [
  "xyzzy nonsense",
  "the weather today",
  "buy groceries",
  "schedule a meeting",
  "what time is it",
];
