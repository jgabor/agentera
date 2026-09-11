import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

// The local eight-worker result is selected only by its named policy; other
// runners remain at the unmeasured fallback. See the linked benchmark record.
export const MEASURED_LOCAL_WORKER_POLICY = "local-16-logical-cpu-node24";
export const UNMEASURED_WORKER_POLICY = "unmeasured";

export function workerPolicyFor(environment: NodeJS.ProcessEnv = process.env): {
  name: typeof MEASURED_LOCAL_WORKER_POLICY | typeof UNMEASURED_WORKER_POLICY | "explicit-override";
  workers: number;
} {
  const override = Number.parseInt(environment.VITEST_MAX_WORKERS ?? "", 10);
  if (override) return { name: "explicit-override", workers: override };
  if (environment.AGENTERA_VITEST_RUNNER_POLICY === MEASURED_LOCAL_WORKER_POLICY) {
    return { name: MEASURED_LOCAL_WORKER_POLICY, workers: 8 };
  }
  return { name: UNMEASURED_WORKER_POLICY, workers: 4 };
}

export function maxWorkersFor(environment: NodeJS.ProcessEnv = process.env): number {
  return workerPolicyFor(environment).workers;
}

export function testTimeoutFor(environment: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(environment.VITEST_TEST_TIMEOUT_MS ?? "", 10);
  return override > 0 ? override : 30_000;
}

export const maxWorkers = maxWorkersFor();
export const testTimeout = testTimeoutFor();

export const sharedTestConfig = {
  environment: "node" as const,
  globals: false,
  maxWorkers,
  testTimeout,
  hookTimeout: testTimeout,
  experimentalFsModuleCache: true,
  // Authority/config changes use the explicit local guard suite, never all source.
  forceRerunTriggers: [],
};

// Native discovery and CI consume the same membership authority. The local
// fast behavior and guards are disjoint subsets of source, not new CI owners.
export function ownerProjects(owner = process.env.AGENTERA_VERIFICATION_OWNER ?? "source", workers = maxWorkers) {
  const root = import.meta.dirname;
  const policy = YAML.parse(fs.readFileSync(path.resolve(root, "../../references/analysis/verification-policy.yaml"), "utf8"));
  if (!Object.hasOwn(policy.owners, owner)) throw new Error(`Unknown verification owner: ${owner}`);
  const relative = (file: string) =>
    path
      .relative(root, path.resolve(root, "../..", file))
      .split(path.sep)
      .join("/");
  const rules = policy.inventory.rules as { owner: string; path?: string; prefix?: string }[];
  const pattern = (rule: (typeof rules)[number]) => (rule.path ? relative(rule.path) : `${relative(rule.prefix!)}/**/*${policy.inventory.suffix}`);
  const guards = policy.local_guards.map(relative) as string[];
  const local = policy.local_source.map(pattern) as string[];
  const include = owner === policy.inventory.default_owner ? [`${relative(policy.inventory.root)}/**/*${policy.inventory.suffix}`] : rules.filter((rule) => rule.owner === owner).map(pattern);
  const exclude = rules.filter((rule) => rule.owner !== owner).map(pattern);
  const project = (name: string, include: string[], exclude: string[]) => ({
    test: {
      ...sharedTestConfig,
      maxWorkers: workers,
      root,
      name,
      include,
      exclude,
      setupFiles: ["./test/fixtureSetup.ts"],
      globalSetup: [owner === "package" ? "./test/packaging/packageSetup.ts" : "./test/sourceSetup.ts"],
      ...(owner === "package" ? { maxWorkers: 1, testTimeout: 120_000 } : {}),
    },
  });
  return owner === "source" ? [project("local", local, [...exclude, ...guards]), project("source", include, [...exclude, ...guards, ...local]), project("guards", guards, [])] : [project(owner, include, exclude)];
}
