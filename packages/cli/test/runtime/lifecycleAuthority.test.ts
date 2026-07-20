import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_AUTHORITY_RELATIVE_PATH,
  loadLifecycleAuthority,
  validateLifecycleAuthorityData,
  validateLifecycleAuthorityRoot,
} from "../../src/runtime/lifecycleAuthority.js";
import {
  loadRuntimeLifecycleAdapterContract,
  validateRuntimeLifecycleAdapterContractRoot,
} from "../../src/runtime/lifecycleAdapterContract.js";
import { validateLifecycleOperationContractRoot } from "../../src/runtime/lifecycleOperationContract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, LIFECYCLE_AUTHORITY_RELATIVE_PATH);

function authorityFixture(): any {
  return YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"));
}

describe("migration-only runtime lifecycle authority", () => {
  it("declares no current runtime inventory and keeps migration contracts valid", () => {
    const data = authorityFixture();
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    const adapters = loadRuntimeLifecycleAdapterContract(undefined, authority);

    expect(data.status).toBe("migration_only_authority");
    expect(data.active_runtimes).toEqual([]);
    expect(authority.runtimes).toEqual([]);
    expect(authority.canonicalSkillPath).toBe("~/.agents/skills/agentera");
    expect(adapters.adapters).toEqual([]);
    expect(adapters.resources).toEqual([]);
    expect(validateLifecycleAuthorityRoot(REPO_ROOT)).toEqual([]);
    expect(validateRuntimeLifecycleAdapterContractRoot(REPO_ROOT)).toEqual([]);
    expect(validateLifecycleOperationContractRoot(REPO_ROOT)).toEqual([]);
  });

  it("rejects any runtime reintroduced as current product", () => {
    const fixture = authorityFixture();
    fixture.active_runtimes.push({
      id: "opencode",
      display_name: "OpenCode",
      surfaces: [{ id: "host", display_name: "OpenCode host", presence: "required" }],
    });

    expect(validateLifecycleAuthorityData(fixture, LIFECYCLE_AUTHORITY_RELATIVE_PATH)).toContain(
      `${LIFECYCLE_AUTHORITY_RELATIVE_PATH}:active_runtimes: must be empty because repository-native runtime integrations are retired`,
    );
  });

  it("rejects an internally active status label", () => {
    const fixture = authorityFixture();
    fixture.status = "active_authority";

    expect(validateLifecycleAuthorityData(fixture, LIFECYCLE_AUTHORITY_RELATIVE_PATH)).toContain(
      `${LIFECYCLE_AUTHORITY_RELATIVE_PATH}:status: must be migration_only_authority`,
    );
  });
});
